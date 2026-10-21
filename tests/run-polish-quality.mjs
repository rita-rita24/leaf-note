import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  launchBrowser,
  stopBrowser,
  openPage,
  evaluate,
  js,
} from "./run-browser.mjs";
import { createPolishQualityTests } from "./polish-quality-regressions.mjs";

const browser = await launchBrowser();
let page,
  passed = 0,
  failures = 0;
try {
  const url = process.env.QUALITY_POLISH_SOURCE
    ? `${pathToFileURL(process.env.QUALITY_POLISH_SOURCE).href}?test=1`
    : undefined;
  page = await openPage(browser.port, url ? { url } : {});
  for (const test of createPolishQualityTests({ evaluate, js })) {
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
      console.error(`not ok - ${test.name}\n${error.stack}`);
      failures++;
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
process.exit(failures ? 1 : 0);
