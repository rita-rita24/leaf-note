import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  launchBrowser,
  stopBrowser,
  CdpClient,
  requestJson,
  evaluate,
  waitForReady,
} from "./loading-cdp.mjs";

const source =
  process.argv[2] || new URL("../LeafNote.html", import.meta.url).pathname;
const browser = await launchBrowser();
let client;
try {
  const target = await requestJson(
    browser.port,
    "/json/new?about:blank",
    "PUT",
  );
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Page.navigate", {
    url:
      (source.startsWith("http") ? source : pathToFileURL(source).href) +
      "?test=1",
  });
  await waitForReady(client, "window.__LeafNoteTest?.isReady()", 30000);
  const checks = await evaluate(
    client,
    `(async () => {
    const output = [];
    const element = document.createElement('div');
    for (let code = 0; code <= 65535; code++) {
      const value = 'a' + String.fromCharCode(code) + '&<>\\u00a0z';
      element.textContent = value;
      if (escapeHTML(value) !== element.innerHTML) throw Error('Escape mismatch at U+' + code.toString(16));
    }
    for (const value of [undefined, null, 0, false, 123, {toString: () => '<object>'}]) {
      element.textContent = value; if (escapeHTML(value) !== element.innerHTML) throw Error('Non-string escape mismatch');
    }
    output.push('65536 UTF-16 code units and non-string HTML serialization preserve exact output');
    const draft = __LeafNoteTest.createInitialState(); draft.documentId = state.documentId; const page = draft.pages[draft.currentPageId];
    page.blocks = [blk('text', '<b>old needle</b>'), blk('table', '', {rows:2, cols:2, cells:[['<b>cell</b>',''],['','']]})];
    __LeafNoteTest.setState(draft); renderAll(); openSearchModal();
    collectSearchMatches('old needle', [page]); page.blocks[0].content = '<b>new needle</b>';
    if (collectSearchMatches('old needle', [page]).pageMatches.length || collectSearchMatches('new needle', [page]).pageMatches.length !== 1) throw Error('Stale search');
    page.blocks[1].cells[0][0] = '<i>updated cell</i>';
    if (collectSearchMatches('updated cell', [page]).pageMatches.length !== 1) throw Error('Stale table');
    output.push('Search remains fresh after text and table mutation');
    for (let i = 0; i < 6000; i++) _htmlFieldSearchText('<b>unique ' + i + '</b>' + 'x'.repeat(200));
    if (_searchTextCacheChars > SEARCH_TEXT_CACHE_MAX_CHARS || _searchTextCache.size > SEARCH_TEXT_CACHE_MAX_ENTRIES) throw Error('Unbounded search cache');
    closeSearchModal(); if (_searchTextCache.size || _searchTextCacheChars) throw Error('Cache retained after close');
    output.push('Rich search cache stays bounded and releases text on every modal close');
    openSearchModal(); const original = searchResults.innerHTML;
    searchInput.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}));
    searchInput.value = 'new needle'; searchInput.dispatchEvent(new InputEvent('input', {bubbles:true,isComposing:true}));
    await new Promise(resolve => setTimeout(resolve, 20));
    if (searchResults.innerHTML !== original) throw Error('Search updated during composition');
    searchInput.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true}));
    await new Promise(resolve => setTimeout(resolve, 20));
    if (searchItems.length !== 2) throw Error('Composition result not committed');
    searchInput.value = 'missing'; searchInput.dispatchEvent(new Event('input', {bubbles:true})); closeSearchModal();
    const closed = searchResults.innerHTML; await new Promise(resolve => setTimeout(resolve, 20));
    if (searchResults.innerHTML !== closed || _searchRenderTimer) throw Error('Closed search updated');
    output.push('IME composition commits only final text; closing cancels queued search');
    for (const width of [320,768,1280]) {
      document.querySelector('#blocks').style.width = width + 'px';
      page.blocks = Array.from({length:60}, (_, i) => blk(i % 3 ? 'text' : 'numbered', 'Wrapping body '.repeat(i % 7 + 1)));
      renderEditor(); await new Promise(resolve => requestAnimationFrame(resolve));
      const a = page.blocks[0], b = page.blocks[20]; moveBlockWithRender(a.id,b.id,'after');
      await new Promise(resolve => requestAnimationFrame(resolve));
      const before = [...document.querySelectorAll('#blocks .block-gutter')].map(node => node.style.top);
      updateBlockGutterPositions();
      const after = [...document.querySelectorAll('#blocks .block-gutter')].map(node => node.style.top);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Scoped gutter mismatch at ' + width);
      if (getCurrentPage().blocks[20].id !== a.id) throw Error('Move order differs');
      if (_saveTimer) clearTimeout(_saveTimer); _saveTimer = null;
      let saved = false; for (let attempt = 0; attempt < 3 && !saved; attempt++) saved = await __LeafNoteTest._doSave({force:true}); const stored = await __LeafNoteTest.loadStateAsync();
      if (!saved || JSON.stringify(stored.pages) !== JSON.stringify(state.pages)) throw Error('Moved state not saved');
    }
    output.push('Moved block order, narrow/wide wrapped gutter positions and persisted pages agree with full recalculation');
    return output;
  })()`,
  );
  for (const check of checks) console.log(`PASS: ${check}`);
  assert.equal(checks.length, 5);
} finally {
  client?.close();
  await stopBrowser(browser);
}
