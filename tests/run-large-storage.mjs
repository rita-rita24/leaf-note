#!/usr/bin/env node
import assert from "node:assert/strict";
import { APP_FILE_NAME, APP_PATH } from "../scripts/app-path.mjs";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import {
  launchBrowser,
  stopBrowser,
  openPage,
  evaluate,
  js,
  jsWithArgs,
} from "./run-browser.mjs";

const source = await readFile(APP_PATH, "utf8");
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(source);
});
await new Promise((resolve, reject) => {
  server.on("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const report = {
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  attachmentMiB: 12,
  saves: 0,
  heapMiB: [],
  errors: [],
};
let browser, page;
try {
  browser = await launchBrowser();
  page = await openPage(browser.port, {
    url: `${origin}/${APP_FILE_NAME}?test=1`,
  });
  const onMessage = page._onMessage.bind(page);
  page._onMessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown")
      report.errors.push(message.params.exceptionDetails);
    onMessage(event);
  };
  await page.send("Performance.enable");
  const initial = await evaluate(
    page,
    js(async () => {
      const api = window.__LeafNoteTest;
      const draft = api.createInitialState();
      draft.workspaceName = "large-storage-fixture";
      draft.pages[draft.currentPageId].blocks = [
        blk("text", "commit 0"),
        blk("file", "", {
          fileName: "synthetic-12MiB.bin",
          fileType: "application/octet-stream",
          fileSize: 12 * 1024 * 1024,
          fileDataUrl:
            "data:application/octet-stream;base64," +
            "QUJD".repeat(4 * 1024 * 1024),
        }),
      ];
      api.setState(draft);
      api.renderAll();
      if (!(await _doSave({ force: true })))
        throw new Error("Initial large save failed");
      const snapshot = JSON.stringify(api.getState());
      const loaded = await loadStateAsync();
      return {
        bytes: new TextEncoder().encode(snapshot).length,
        roundTrip: JSON.stringify(loaded) === snapshot,
        localMissing: localStorage.getItem(STATE_STORAGE_KEY) !== snapshot,
      };
    }),
  );
  assert.equal(initial.roundTrip, true);
  assert.equal(initial.localMissing, true);
  report.snapshotBytes = initial.bytes;
  for (let round = 1; round <= 24; round++) {
    const saved = await evaluate(
      page,
      jsWithArgs(async (index) => {
        const s = window.__LeafNoteTest.getState();
        s.pages[s.currentPageId].blocks[0].content = `commit ${index}`;
        saveState();
        const saved = await _doSave();
        _flushPendingUndoSnapshot();
        return (
          saved && JSON.stringify(await loadStateAsync()) === JSON.stringify(s)
        );
      }, round),
    );
    assert.equal(saved, true, `large save ${round}`);
    report.saves++;
    if (round === 1 || round % 6 === 0) {
      await page.send("HeapProfiler.collectGarbage");
      const metrics = await page.send("Performance.getMetrics");
      report.heapMiB.push(
        +(
          metrics.metrics.find((m) => m.name === "JSHeapUsedSize").value /
          1024 /
          1024
        ).toFixed(2),
      );
    }
  }
  const failure = await evaluate(
    page,
    js(async () => {
      const api = window.__LeafNoteTest;
      const committed = JSON.stringify(await loadStateAsync());
      const originalOpen = openDB;
      let saved, live, dirty, historyRefused;
      try {
        openDB = async () => {
          throw new Error("Injected unavailable database");
        };
        api.getState().pages[api.getState().currentPageId].blocks[0].content =
          "unsaved large edit";
        saveState();
        saved = await _doSave();
        live = JSON.stringify(api.getState());
        dirty = _hasUnsavedState();
        historyRefused =
          undo() === false && JSON.stringify(api.getState()) === live;
        clearTimeout(_saveTimer);
        _saveTimer = null;
      } finally {
        openDB = originalOpen;
      }
      const previousPreserved =
        committed === JSON.stringify(await loadStateAsync());
      const recovered = await _doSave();
      const latestPreserved = JSON.stringify(await loadStateAsync()) === live;
      return {
        saved,
        dirty,
        historyRefused,
        previousPreserved,
        recovered,
        latestPreserved,
      };
    }),
  );
  assert.deepEqual(failure, {
    saved: false,
    dirty: true,
    historyRefused: true,
    previousPreserved: true,
    recovered: true,
    latestPreserved: true,
  });
  report.failureRecovery = failure;
  assert.ok(
    report.heapMiB.at(-1) - report.heapMiB[0] < 64,
    "Large documents retain excess heap between saves",
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`ok - large attachment storage ${JSON.stringify(report)}`);
} catch (error) {
  report.passed = false;
  report.failure = error.stack;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  page?.close();
  await stopBrowser(browser);
  if (browser?.userDataDir)
    await rm(browser.userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  if (process.env.LARGE_STORAGE_REPORT)
    await writeFile(
      process.env.LARGE_STORAGE_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
}
