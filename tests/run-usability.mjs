import { rm } from "node:fs/promises";
import {
  launchBrowser,
  stopBrowser,
  openPage,
  evaluate,
  js,
} from "./run-browser.mjs";
import { createUsabilityTests } from "./usability-regressions.mjs";
const browser = await launchBrowser();
const pages = [];
let passed = 0;
try {
  const leaf = await openPage(browser.port);
  pages.push(leaf);
  for (const [page, tests] of [
    [leaf, createUsabilityTests({ evaluate, js })],
  ]) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const test of tests) {
      await test.run(page);
      passed++;
      console.log(`ok - ${test.name}`);
    }
  }
  console.log(`Passed ${passed} usability checks.`);
} finally {
  pages.forEach((p) => p.close());
  await stopBrowser(browser);
  await rm(browser.userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
