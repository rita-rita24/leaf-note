import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  launchBrowser,
  stopBrowser,
  CdpClient,
  requestJson,
  evaluate,
  waitForReady,
} from "./loading-cdp.mjs";
export async function openTestPage({
  source,
  ready,
  engine = "chrome",
  viewport = { width: 1280, height: 800 },
}) {
  const url =
    (source.startsWith("http") ? source : pathToFileURL(resolve(source)).href) +
    "?test=1";
  let browser, client;
  const close = async () => {
    client?.close();
    if (browser) {
      if (engine === "chrome") await stopBrowser(browser);
      else await browser.close();
      browser = null;
    }
  };
  try {
    if (engine === "chrome") {
      browser = await launchBrowser();
      const target = await requestJson(
        browser.port,
        "/json/new?about:blank",
        "PUT",
      );
      client = new CdpClient(target.webSocketDebuggerUrl);
      await client.connect();
      await client.send("Page.enable");
      await client.send("Runtime.enable");
      await client.send("Emulation.setDeviceMetricsOverride", {
        ...viewport,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await client.send("Page.navigate", { url });
      await waitForReady(client, ready, 30000);
      return {
        close,
        version: (await requestJson(browser.port, "/json/version")).Browser,
        evaluate: (expression) =>
          evaluate(
            client,
            typeof expression === "function"
              ? `(${expression.toString()})()`
              : expression,
          ),
      };
    }
    const { firefox, webkit } = await import("playwright"),
      type = { firefox, webkit }[engine];
    if (!type) throw new Error("Unknown engine: " + engine);
    browser = await type.launch({ headless: true });
    const page = await browser.newPage({ viewport });
    await page.goto(url);
    await page.waitForFunction(ready, null, { timeout: 30000 });
    return {
      close,
      version: browser.version(),
      evaluate: (expression) => page.evaluate(expression),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
