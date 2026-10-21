#!/usr/bin/env node
import assert from "node:assert/strict";
import { APP_FILE_NAME, APP_PATH } from "../scripts/app-path.mjs";
import http from "node:http";
import { readFile, writeFile, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import {
  launchBrowser,
  stopBrowser,
  openPage,
  waitForReady,
  evaluate,
  js,
  jsWithArgs,
} from "./run-browser.mjs";

// 一時プロファイルと実際のIndexedDBトランザクションを使い、実時間で検証する。
// 短い実行時間への変更は検証器の開発用であり、長時間試験の代わりにはならない。
const durationSeconds = Number(process.env.SOAK_SECONDS || 900);
const reloadSeconds = Number(process.env.SOAK_RELOAD_SECONDS ?? 30);
const crashCount = Number(process.env.SOAK_CRASHES ?? 2);
if (
  !Number.isFinite(durationSeconds) ||
  durationSeconds < 10 ||
  durationSeconds > 86400
) {
  throw new Error("SOAK_SECONDS must be between 10 and 86400.");
}
if (
  !Number.isFinite(reloadSeconds) ||
  reloadSeconds < 0 ||
  ![0, 2].includes(crashCount)
) {
  throw new Error(
    "SOAK_RELOAD_SECONDS must be nonnegative and SOAK_CRASHES must be 0 or 2.",
  );
}
const source = await readFile(APP_PATH, "utf8");
let exportedHtml = "";
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(req.url.startsWith("/export.html") ? exportedHtml : source);
});
await new Promise((resolve, reject) => {
  server.on("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const url = `${origin}/${APP_FILE_NAME}?test=1`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  durationSeconds,
  reloadSeconds,
  crashCount,
  rounds: 0,
  edits: 0,
  reloads: 0,
  crashes: 0,
  quotaFailures: 0,
  fallbackSaves: 0,
  idleChecks: 0,
  samples: [],
  errors: [],
};
const timings = [];
let browser;
let page;
let profilePath;
let started;

const attach = async () => {
  page = await openPage(browser.port, { url });
  const originalMessage = page._onMessage.bind(page);
  page._onMessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown")
      report.errors.push(message.params.exceptionDetails);
    originalMessage(event);
  };
  await page.send("Performance.enable");
};
const readState = () => evaluate(page, "window.__LeafNoteTest.getState()");
const checkReload = async (expected) => {
  const loaded = page.waitForEvent("Page.loadEventFired");
  await page.send("Page.reload");
  await loaded;
  await waitForReady(
    page,
    "window.__LeafNoteTest && window.__LeafNoteTest.isReady()",
  );
  assert.deepEqual(
    await readState(),
    expected,
    "Reload changed committed state",
  );
  report.reloads++;
};
const sample = async () => {
  await page.send("HeapProfiler.collectGarbage");
  const metrics = Object.fromEntries(
    (await page.send("Performance.getMetrics")).metrics.map((m) => [
      m.name,
      m.value,
    ]),
  );
  const dom = await page.send("Memory.getDOMCounters");
  const row = {
    seconds: Math.round((performance.now() - started) / 1000),
    round: report.rounds,
    heapMiB: +(metrics.JSHeapUsedSize / 1024 / 1024).toFixed(2),
    nodes: dom.nodes,
  };
  report.samples.push(row);
  console.log(`soak - ${JSON.stringify(row)}`);
};

try {
  browser = await launchBrowser();
  profilePath = browser.userDataDir;
  await attach();
  assert.equal(
    await evaluate(
      page,
      js(async () => {
        const api = window.__LeafNoteTest;
        const draft = api.createInitialState();
        draft.workspaceName = "Storage soak 日本語";
        draft.trashAutoPurgeDays = 0;
        for (let i = 0; i < 19; i++)
          api.createPage(null, { title: "Page " + i });
        for (const [index, p] of Object.values(draft.pages).entries()) {
          p.title = "Soak page " + index;
          p.blocks = Array.from({ length: 40 }, (_, n) =>
            api.blk(
              "text",
              `page ${index} block ${n} — 日本語 ${"data ".repeat(40)}`,
            ),
          );
        }
        const first = draft.pages[draft.currentPageId];
        first.blocks.push(
          api.blk("file", "", {
            fileName: "synthetic.txt",
            fileType: "text/plain",
            fileSize: 128 * 1024,
            fileDataUrl:
              "data:text/plain;base64," + btoa("x".repeat(128 * 1024)),
          }),
        );
        api.setState(draft);
        api.renderAll();
        return api._doSave({ force: true });
      }),
    ),
    true,
  );
  // 繰り返し使用の計測前に、完全に正規化した初期状態を準備する。
  const loaded = page.waitForEvent("Page.loadEventFired");
  await page.send("Page.reload");
  await loaded;
  await waitForReady(
    page,
    "window.__LeafNoteTest && window.__LeafNoteTest.isReady()",
  );
  started = performance.now();
  await sample();
  let nextSample = 60;
  let nextReload = reloadSeconds || Infinity;
  const crashTimes = crashCount
    ? [durationSeconds / 3, (durationSeconds * 2) / 3]
    : [];
  while ((performance.now() - started) / 1000 < durationSeconds) {
    const round = ++report.rounds;
    const result = await evaluate(
      page,
      jsWithArgs(async (round) => {
        const api = window.__LeafNoteTest;
        const originalOpen = indexedDB.open;
        const originalPut = IDBObjectStore.prototype.put;
        const originalSet = Storage.prototype.setItem;
        const pageIds = api.getState().rootPages;
        api.switchPage(pageIds[round % pageIds.length]);
        const p = api.getState().pages[api.getState().currentPageId];
        const target = document.querySelector(
          `[data-block-id="${p.blocks[0].id}"]`,
        );
        for (let edit = 0; edit < 4; edit++) {
          target.textContent = `round ${round} edit ${edit} — 入力を保持 ${"x".repeat(100)}`;
          target.dispatchEvent(new Event("input", { bubbles: true }));
        }
        let quotaChecked = false;
        let fallbackSaved = false;
        const started = performance.now();
        try {
          if (round % 40 === 0) {
            const prior = JSON.stringify(await api.loadStateAsync());
            IDBObjectStore.prototype.put = function () {
              throw new DOMException("Injected quota", "QuotaExceededError");
            };
            Storage.prototype.setItem = function (key, value) {
              if (key === STATE_STORAGE_KEY)
                throw new DOMException("Injected quota", "QuotaExceededError");
              return originalSet.call(this, key, value);
            };
            const rejected = await api._doSave();
            quotaChecked =
              rejected === false &&
              prior === JSON.stringify(await api.loadStateAsync());
            if (!quotaChecked)
              throw new Error("Quota failure replaced the previous save");
            IDBObjectStore.prototype.put = originalPut;
            Storage.prototype.setItem = originalSet;
          } else if (round % 25 === 0) {
            indexedDB.open = () => {
              throw new Error("Injected IndexedDB outage");
            };
            fallbackSaved = await api._doSave();
            for (let i = 0; !fallbackSaved && i < 20; i++) {
              await new Promise((resolve) => setTimeout(resolve, 25));
              fallbackSaved = await api._doSave();
            }
            if (!fallbackSaved)
              throw new Error(
                "Fallback did not save: " +
                  document.querySelector("#save-status").textContent,
              );
            indexedDB.open = originalOpen;
          }
          let saved = await api._doSave({ force: fallbackSaved });
          // 予約済みの遅延保存や定期保存が、この要求を置き換える場合がある。
          // 特定の要求トークンの完了ではなく、最新内容が保存されたことを確認する。
          for (let i = 0; !saved && i < 20; i++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            saved = await api._doSave();
          }
          if (!saved)
            throw new Error(
              "Expected save did not commit: " +
                document.querySelector("#save-status").textContent,
            );
          const expected = JSON.stringify(api.getState());
          if (JSON.stringify(await api.loadStateAsync()) !== expected)
            throw new Error("Persisted content differs from live state");
          const history = _historyStackInfo();
          if (
            history.undoBytes > UNDO_MAX_TOTAL_BYTES ||
            history.redoBytes > UNDO_MAX_TOTAL_BYTES
          )
            throw new Error("History memory budget exceeded");
          return {
            elapsedMs: performance.now() - started,
            quotaChecked,
            fallbackSaved,
          };
        } finally {
          indexedDB.open = originalOpen;
          IDBObjectStore.prototype.put = originalPut;
          Storage.prototype.setItem = originalSet;
        }
      }, round),
    );
    report.edits += 4;
    report.quotaFailures += Number(result.quotaChecked);
    report.fallbackSaves += Number(result.fallbackSaved);
    timings.push(result.elapsedMs);
    const elapsed = (performance.now() - started) / 1000;
    if (crashTimes.length && elapsed >= crashTimes[0]) {
      crashTimes.shift();
      const expected = await readState();
      // SIGKILLではpagehide・beforeunloadやブラウザの通常の終了処理は実行されない。
      const exited = new Promise((resolve) =>
        browser.proc.once("exit", resolve),
      );
      browser.proc.kill("SIGKILL");
      await exited;
      page.close();
      browser = await launchBrowser({ profilePath });
      await attach();
      assert.deepEqual(
        await readState(),
        expected,
        "Committed data was lost after browser SIGKILL",
      );
      report.crashes++;
      console.log(
        `soak - crash recovery ${report.crashes} preserved the full document`,
      );
    } else if (elapsed >= nextReload) {
      await checkReload(await readState());
      nextReload = elapsed + reloadSeconds;
    }
    if (elapsed >= nextSample) {
      const expected = await readState();
      await sleep(3300);
      assert.deepEqual(
        await readState(),
        expected,
        "Idle autosave changed live content",
      );
      report.idleChecks++;
      await sample();
      nextSample = elapsed + 60;
    }
    await sleep(250);
  }
  report.actualSeconds = +((performance.now() - started) / 1000).toFixed(2);
  await sample();
  let expected = await readState();
  exportedHtml = await evaluate(
    page,
    js(async () => {
      let blob;
      const originalCreate = URL.createObjectURL;
      const originalClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (value) => {
        blob = value;
        return "blob:soak-backup";
      };
      HTMLAnchorElement.prototype.click = () => {};
      try {
        document.querySelector("#export-btn").click();
        document.querySelector("#dialog-box [data-ok]").click();
        for (let i = 0; i < 200 && !blob; i++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (!blob) throw new Error("HTML backup was not produced");
        return blob.text();
      } finally {
        URL.createObjectURL = originalCreate;
        HTMLAnchorElement.prototype.click = originalClick;
      }
    }),
  );
  // 既存の書き出しダイアログ自体が文書のリビジョンを更新する。
  expected = await readState();
  await page.send("Page.navigate", { url: "about:blank" });
  await page.send("Storage.clearDataForOrigin", {
    origin,
    storageTypes: "all",
  });
  await page.send("Page.navigate", { url });
  await waitForReady(
    page,
    "window.__LeafNoteTest && window.__LeafNoteTest.isReady()",
  );
  const afterClear = await readState();
  assert.notEqual(
    afterClear.documentId,
    expected.documentId,
    "Test clearing did not remove browser data",
  );
  report.browserClearRemovedData = true;
  await page.send("Page.navigate", { url: "about:blank" });
  await page.send("Storage.clearDataForOrigin", {
    origin,
    storageTypes: "all",
  });
  await page.send("Page.navigate", { url: `${origin}/export.html?test=1` });
  await waitForReady(
    page,
    "window.__LeafNoteTest && window.__LeafNoteTest.isReady()",
  );
  const fromBackup = await readState();
  assert.deepEqual(
    fromBackup.pages,
    expected.pages,
    "HTML backup changed page content or attachments",
  );
  assert.equal(fromBackup.documentId, expected.documentId);
  assert.equal(fromBackup.workspaceName, expected.workspaceName);
  report.htmlBackupRestoredAfterClear = true;
  assert.deepEqual(report.errors, [], "Unhandled runtime exceptions");
  const heaps = report.samples.map((row) => row.heapMiB);
  report.heapGrowthMiB = +(heaps.at(-1) - heaps[0]).toFixed(2);
  assert.ok(
    report.heapGrowthMiB < 64,
    `Retained heap grew by ${report.heapGrowthMiB} MiB`,
  );
  timings.sort((a, b) => a - b);
  report.saveP50Ms = +timings[Math.floor(timings.length * 0.5)].toFixed(2);
  report.saveP95Ms = +timings[Math.floor(timings.length * 0.95)].toFixed(2);
  report.passed = true;
  console.log(`ok - storage soak ${JSON.stringify(report)}`);
} catch (error) {
  report.passed = false;
  report.failure = error.stack;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  page?.close();
  await stopBrowser(browser);
  if (profilePath)
    await rm(profilePath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  if (process.env.SOAK_REPORT)
    await writeFile(
      process.env.SOAK_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
}
