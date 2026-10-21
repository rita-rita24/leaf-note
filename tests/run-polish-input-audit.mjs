import assert from "node:assert/strict";
import { APP_PATH } from "../scripts/app-path.mjs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  launchBrowser,
  stopBrowser,
  openPage,
  evaluate,
  js,
} from "./run-browser.mjs";

assert.ok(
  process.env.QUALITY_BASELINE_DIR,
  "Set QUALITY_BASELINE_DIR to the original HTML directory",
);
const report = [];
for (const [label, source] of [
  ["before", path.join(process.env.QUALITY_BASELINE_DIR, "LeafNote.html")],
  ["after", APP_PATH],
]) {
  const browser = await launchBrowser();
  let page;
  try {
    page = await openPage(browser.port, {
      url: `${pathToFileURL(source).href}?test=1`,
    });
    const row = {
      source: label,
      sha256: createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
    };
    await evaluate(
      page,
      js(() => {
        const draft = createInitialState();
        draft.pages[draft.currentPageId].blocks = [blk("math", "abc")];
        window.__LeafNoteTest.setState(draft);
        renderAll();
        titleEl.focus();
        placeCaret(titleEl, "end");
      }),
    );
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
    });
    await page.send("Input.insertText", { text: "入力" });
    row.navigation = await evaluate(
      page,
      js(() => ({
        focused:
          document.activeElement ===
          document.querySelector(".raw-block-textarea"),
        content: getCurrentPage().blocks[0].content,
      })),
    );
    await evaluate(
      page,
      js(async () => {
        openSearchModal("");
        await new Promise((resolve) => setTimeout(resolve, 60));
        window.__polishMutationCount = 0;
        window.__polishObserver = new MutationObserver((records) => {
          window.__polishMutationCount += records.reduce(
            (sum, record) => sum + record.addedNodes.length,
            0,
          );
        });
        window.__polishObserver.observe(searchResults, { childList: true });
      }),
    );
    await page.send("Input.imeSetComposition", {
      text: "にほん",
      selectionStart: 3,
      selectionEnd: 3,
    });
    row.composing = await evaluate(
      page,
      js(async () => {
        await new Promise((resolve) =>
          setTimeout(resolve, SEARCH_INPUT_DEBOUNCE_MS + 30),
        );
        return {
          addedNodes: window.__polishMutationCount,
          value: searchInput.value,
          focused: document.activeElement === searchInput,
        };
      }),
    );
    await page.send("Input.insertText", { text: "日本" });
    row.committed = await evaluate(
      page,
      js(async () => {
        await new Promise((resolve) =>
          setTimeout(resolve, SEARCH_INPUT_DEBOUNCE_MS + 30),
        );
        window.__polishObserver.disconnect();
        return {
          value: searchInput.value,
          updated: searchResults.textContent.includes("日本"),
          focused: document.activeElement === searchInput,
        };
      }),
    );
    report.push(row);
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
}
assert.equal(report[0].navigation.focused, false);
assert.deepEqual(report[1].navigation, { focused: true, content: "入力abc" });
assert.ok(report[0].composing.addedNodes > 0);
assert.deepEqual(report[1].composing, {
  addedNodes: 0,
  value: "にほん",
  focused: true,
});
assert.deepEqual(report[1].committed, {
  value: "日本",
  updated: true,
  focused: true,
});
console.log(JSON.stringify(report, null, 2));
if (process.env.QUALITY_INPUT_REPORT)
  await writeFile(
    process.env.QUALITY_INPUT_REPORT,
    JSON.stringify(report, null, 2) + "\n",
  );
process.exit(0);
