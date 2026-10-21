import assert from "node:assert/strict";
import { APP_PATH } from "../scripts/app-path.mjs";
import { rm, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  launchBrowser,
  stopBrowser,
  openPage,
  evaluate,
  js,
} from "./run-browser.mjs";
import { createTenRoundTests } from "./ten-rounds-regressions.mjs";

const tests = createTenRoundTests({ evaluate, js }).filter(
  (test) =>
    !process.env.ROUND || test.name.startsWith(`round ${process.env.ROUND}:`),
);
assert.ok(tests.length, "No matching round");
const hash = createHash("sha256")
  .update(await readFile(APP_PATH))
  .digest("hex");
console.log(
  JSON.stringify({
    startedAt: new Date().toISOString(),
    round: process.env.ROUND || "all",
    sourceSha256: hash,
  }),
);
const browser = await launchBrowser();
let page;
try {
  page = await openPage(browser.port);
  for (const test of tests) {
    await evaluate(
      page,
      js(() => {
        if (typeof hideDialog === "function") hideDialog(null);
        document.querySelectorAll(".overlay").forEach((overlay) => {
          if (!overlay.hidden && typeof closeOverlay === "function")
            closeOverlay(overlay);
        });
      }),
    );
    await test.run(page);
    console.log(`ok - ${test.name}`);
  }
  console.log(
    JSON.stringify({
      completedAt: new Date().toISOString(),
      passed: tests.length,
    }),
  );
} finally {
  page?.close();
  await stopBrowser(browser);
  await rm(browser.userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
