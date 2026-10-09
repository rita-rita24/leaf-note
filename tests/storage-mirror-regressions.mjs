import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const [source = "LeafNote.html", engine = "chrome"] = process.argv.slice(2);
const html = await readFile(source, "utf8");
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await { chrome: chromium, firefox, webkit }[engine].launch({
    headless: true,
    ...(engine === "chrome" ? { channel: "chrome" } : {}),
  });
  console.log("Browser:", engine, browser.version());
  for (let trial = 0; trial < 5; trial++) {
    const context = await browser.newContext();
    try {
      const url = `http://127.0.0.1:${server.address().port}/?test=1`;
      const tab = async () => {
        const page = await context.newPage();
        await page.goto(url);
        await page.waitForFunction(() => window.__LeafNoteTest?.isReady());
        return page;
      };
      const first = await tab();
      assert.equal(
        await first.evaluate(async () => {
          const draft = createInitialState();
          draft.pages[draft.currentPageId].blocks = [blk("text", "original")];
          window.__LeafNoteTest.setState(draft);
          return _doSave({ force: true });
        }),
        true,
      );
      const second = await tab();
      for (const page of [first, second])
        await page.evaluate(() => {
          _storageChannel?.close();
          _storageChannel = null;
          _otherStorageTabsSeen = false;
          window.addEventListener(
            "storage",
            (event) => event.stopImmediatePropagation(),
            true,
          );
        });
      const primary = await first.evaluate(async () => {
        const originalSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (this === localStorage && key === STATE_STORAGE_KEY)
            throw new DOMException("Mirror full", "QuotaExceededError");
          return originalSet.call(this, key, value);
        };
        getCurrentPage().blocks[0].content = "primary committed";
        saveState();
        clearTimeout(_saveTimer);
        _saveTimer = null;
        const saved = await _doSave({ force: true });
        Storage.prototype.setItem = originalSet;
        return {
          saved,
          mirror: JSON.parse(localStorage.getItem(STATE_STORAGE_KEY)).pages[
            state.currentPageId
          ].blocks[0].content,
        };
      });
      assert.deepEqual(primary, { saved: true, mirror: "original" });
      const loser = await second.evaluate(async () => {
        indexedDB.open = () => {
          throw Error("IndexedDB unavailable");
        };
        getCurrentPage().blocks[0].content = "fallback edit";
        saveState();
        clearTimeout(_saveTimer);
        _saveTimer = null;
        const saved = await _doSave({ force: true });
        flushStateToLocalStorageSync();
        return {
          saved,
          unsaved: _hasUnsavedState(),
          mirror: JSON.parse(localStorage.getItem(STATE_STORAGE_KEY)).pages[
            state.currentPageId
          ].blocks[0].content,
        };
      });
      console.log("trial", trial, JSON.stringify({ primary, loser }));
      assert.deepEqual(loser, {
        saved: false,
        unsaved: true,
        mirror: "original",
      });
      await first.close({ runBeforeUnload: false });
      // Denied tabs retain their draft after the owner closes; reacquisition
      // requires a fresh load so stale copies cannot become writers.
      assert.equal(
        await second.evaluate(() => _doSave({ force: true })),
        false,
      );
      await second.close({ runBeforeUnload: false });
      const reopened = await tab();
      assert.equal(
        await reopened.evaluate(() => getCurrentPage().blocks[0].content),
        "primary committed",
      );
      assert.equal(
        await reopened.evaluate(async () => {
          getCurrentPage().blocks[0].content = "freshly reopened";
          saveState();
          clearTimeout(_saveTimer);
          _saveTimer = null;
          return _doSave({ force: true });
        }),
        true,
      );
    } finally {
      await context.close();
    }
  }
  console.log(
    "PASS: 5 mirror-failure, denied-draft, owner-close and reload scenarios",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
