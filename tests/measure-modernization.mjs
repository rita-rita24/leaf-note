import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  launchBrowser,
  stopBrowser,
  CdpClient,
  requestJson,
  evaluate,
  waitForReady,
} from "./loading-cdp.mjs";

const [source, output] = process.argv.slice(2);
if (!source || !output)
  throw new Error(
    "Usage: node tests/measure-modernization.mjs <HTML path or URL> <output.json>",
  );
const browser = await launchBrowser();
const result = {
  date: new Date().toISOString(),
  source,
  conditions: {
    cpu: 4,
    viewport: "1280x800",
    trials: 5,
    data: "30 notes × 100 distinct rich HTML text blocks",
    endpoint:
      "Correct DOM result plus next animation frame: a rendering proxy, not actual pixel presentation or INP.",
    helper:
      "10000 calls to escapeHTML: synchronous CPU microbenchmark, not user latency.",
    save: "Forced persistence completed and pages verified by loadStateAsync; isolated synthetic state only.",
  },
  rows: [],
};
let client;
try {
  result.browser = await requestJson(browser.port, "/json/version");
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
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await client.send("Page.navigate", {
    url:
      (source.startsWith("http") ? source : pathToFileURL(source).href) +
      "?test=1",
  });
  await waitForReady(client, "window.__LeafNoteTest?.isReady()", 30000);
  for (let trial = 0; trial < 5; trial++) {
    const row = await evaluate(
      client,
      `(async () => {
      const draft = createInitialState(); draft.documentId = state.documentId; draft.pages = {}; draft.rootPages = [];
      for (let p = 0; p < 30; p++) {
        const id = 'perf-page-' + p;
        draft.rootPages.push(id);
        draft.pages[id] = { id, title: 'Note ' + p, parentId: null, children: [], createdAt: 1, updatedAt: 1,
          blocks: Array.from({length: 100}, (_, b) => ({...blk('text', '<b>body ' + p + '-' + b + '</b> &amp; 日本語<br>needle'), id: 'perf-block-' + p + '-' + b})) };
      }
      draft.currentPageId = draft.rootPages[0]; __LeafNoteTest.setState(draft); renderAll();
      await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(resolve));
      const frames = async () => { await new Promise(resolve => requestAnimationFrame(resolve)); };
      const timed = async (operation, check) => {
        const start = performance.now(); operation();
        while (!check()) { if (performance.now() - start > 10000) throw Error('Operation timed out'); await new Promise(resolve => setTimeout(resolve, 0)); }
        await frames(); return performance.now() - start;
      };
      openSearchModal();
      const searchFirst = await timed(() => renderSearchResults('absent-first'), () => searchItems.length === 1);
      const searchRepeat = await timed(() => renderSearchResults('absent-repeat'), () => searchItems.length === 1);
      const expected = collectSearchMatches('needle', Object.values(state.pages)).pageMatches.map(page => page.id);
      if (expected.length !== 30) throw Error('Rich search missed pages');
      const changed = state.pages[draft.rootPages[0]].blocks[0]; changed.content = '<i>latest unique edit</i>';
      const matches = collectSearchMatches('latest unique edit', Object.values(state.pages)).pageMatches.map(page => page.id);
      if (JSON.stringify(matches) !== JSON.stringify([draft.rootPages[0]])) throw Error('Search used stale text');
      closeSearchModal();
      const editor = await timed(() => renderEditor(), () => document.querySelectorAll('#blocks > .block').length === 100);
      const values = ['plain text', '日本語 🌱', '<a href="x"> & \\" \\' >', '\\u00a0'];
      let checksum = 0; const helperStart = performance.now();
      for (let i = 0; i < 10000; i++) checksum += escapeHTML(values[i % values.length]).length;
      const helper = performance.now() - helperStart;
      if (_saveTimer) clearTimeout(_saveTimer); _saveTimer = null;
      const saveStart = performance.now(); let saved = false, attempts = 0;
      while (!saved && performance.now() - saveStart < 10000) { attempts++; saved = await __LeafNoteTest._doSave({force:true}); }
      const save = performance.now() - saveStart; const stored = await __LeafNoteTest.loadStateAsync();
      if (!saved || JSON.stringify(stored?.pages) !== JSON.stringify(state.pages)) throw Error('Persisted data differs');
      return { searchFirst, searchRepeat, editor, helper, checksum, save, pages: expected.length, saved, attempts };
    })()`,
    );
    assert.equal(row.pages, 30);
    result.rows.push({ trial, ...row });
    await writeFile(output, JSON.stringify(result, null, 2));
    console.log(
      `Trial ${trial + 1}: first search ${row.searchFirst.toFixed(1)}ms; repeat ${row.searchRepeat.toFixed(1)}ms; save ${row.save.toFixed(1)}ms`,
    );
  }
} finally {
  client?.close();
  await stopBrowser(browser);
}
