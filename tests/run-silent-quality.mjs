import { rm } from "node:fs/promises";
import {
  launchBrowser,
  stopBrowser,
  openPage,
  evaluate,
  js,
} from "./run-browser.mjs";
import { createSilentQualityTests } from "./silent-quality-regressions.mjs";

const browser = await launchBrowser();
let page,
  failures = 0,
  passed = 0;
try {
  page = await openPage(browser.port);
  for (const test of createSilentQualityTests({ evaluate, js })) {
    await evaluate(
      page,
      js(() => {
        hideDialog(null);
        document.querySelectorAll(".overlay").forEach((overlay) => {
          if (!overlay.hidden) closeOverlay(overlay);
        });
      }),
    );
    try {
      await test.run(page);
      console.log(`ok - ${test.name}`);
      passed++;
    } catch (error) {
      failures++;
      console.error(`not ok - ${test.name}\n${error.stack}`);
    }
  }
  console.log(JSON.stringify({ passed, failures }));
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
process.exitCode = failures ? 1 : 0;
