import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { firefox, webkit } from "playwright";
import {
  unitTests,
  integrationTests,
  maskingerUnitTests,
  maskingerIntegrationTests,
  indexIntegrationTests,
  runTestGroup,
} from "./run-browser.mjs";
const engine = process.argv[2] || "firefox";
const type = { firefox, webkit }[engine];
if (!type) throw new Error("Supported engines: firefox, webkit");
const app = existsSync("leaf-note.html") ? "leaf-note.html" : "LeafNote.html";
const routes = new Map([
  ["/LeafNote.html", app],
  ["/Maskinger.html", "Maskinger.html"],
  ["/index.html", "index.html"],
]);
const server = http.createServer(async (req, res) => {
  const file = routes.get(new URL(req.url, "http://localhost").pathname);
  if (!file) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(await readFile(resolve(file)));
  } catch {
    res.writeHead(500);
    res.end();
  }
});
let browser;
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  browser = await type.launch({ headless: true });
  console.log("Browser:", engine, browser.version());
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  for (const [file, tests, ready] of [
    [
      "LeafNote.html",
      [...unitTests, ...integrationTests],
      () => window.__LeafNoteTest?.isReady(),
    ],
    [
      "Maskinger.html",
      [...maskingerUnitTests, ...maskingerIntegrationTests],
      () => !!window.__MaskingerTest,
    ],
    [
      "index.html",
      indexIntegrationTests,
      () => window.__LeafNoteIndexReady === true,
    ],
  ]) {
    if (!existsSync(routes.get("/" + file))) {
      console.log("Not present in working composition:", file);
      continue;
    }
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/${file}?test=1`);
    await page.waitForFunction(ready, null, { timeout: 30000 });
    const adapter = {
      send: async (method, params = {}) => {
        if (method === "Runtime.evaluate")
          return { result: { value: await page.evaluate(params.expression) } };
        if (method === "Page.reload") {
          await page.reload();
          return {};
        }
        if (method === "Emulation.setDeviceMetricsOverride") {
          await page.setViewportSize({
            width: params.width,
            height: params.height,
          });
          return {};
        }
        if (method === "Emulation.clearDeviceMetricsOverride") {
          await page.setViewportSize({ width: 1280, height: 800 });
          return {};
        }
        if (method === "Input.dispatchMouseEvent") {
          if (params.type === "mouseMoved")
            await page.mouse.move(params.x, params.y);
          else if (params.type === "mousePressed") {
            await page.mouse.move(params.x, params.y);
            await page.mouse.down({
              button: params.button || "left",
              clickCount: params.clickCount || 1,
            });
          } else if (params.type === "mouseReleased") {
            await page.mouse.move(params.x, params.y);
            await page.mouse.up({
              button: params.button || "left",
              clickCount: params.clickCount || 1,
            });
          } else
            throw new Error("Unsupported mouse input type: " + params.type);
          return {};
        }
        throw new Error("Unsupported cross-browser protocol method: " + method);
      },
    };
    const unsupportedTouch = tests.filter((test) =>
      test.run.toString().includes('"Emulation.setTouchEmulationEnabled"'),
    );
    for (const test of unsupportedTouch)
      console.log("UNVERIFIED touch emulation:", test.name);
    await runTestGroup(
      adapter,
      tests.filter((test) => !unsupportedTouch.includes(test)),
    );
    await page.close();
  }
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
  server.closeAllConnections();
}
