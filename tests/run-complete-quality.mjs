import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  launchBrowser,
  stopBrowser,
  openPage,
  evaluate,
  js,
} from "./run-browser.mjs";
import { createCompleteQualityTests } from "./complete-quality-regressions.mjs";

const browser = await launchBrowser();
let page,
  failures = 0,
  passed = 0;
try {
  const url = process.env.QUALITY_COMPLETE_SOURCE
    ? `${pathToFileURL(process.env.QUALITY_COMPLETE_SOURCE).href}?test=1`
    : undefined;
  page = await openPage(browser.port, url ? { url } : {});
  for (const test of createCompleteQualityTests({ evaluate, js })) {
    if (
      process.env.QUALITY_FILTER &&
      !test.name.includes(process.env.QUALITY_FILTER)
    )
      continue;
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
