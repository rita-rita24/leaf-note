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
const [source = "LeafNote.html", output] = process.argv.slice(2);
const browser = await launchBrowser();
let client;
const trials = [];
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
  const compose = (text) =>
    client.send("Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  for (let trial = 0; trial < 5; trial++) {
    await evaluate(
      client,
      `(()=>{
      document.activeElement?.blur();const draft=createInitialState();draft.pages[draft.currentPageId].title='';draft.pages[draft.currentPageId].blocks=Array.from({length:100},()=>blk('text',''));__LeafNoteTest.setState(draft);renderAll({forceEditableSync:true});
      window.__imeEvents=[];window.__imeAbort?.abort();window.__imeAbort=new AbortController();
      for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input'])document.addEventListener(type,e=>__imeEvents.push({type,target:e.target.id||e.target.className,data:e.data,isTrusted:e.isTrusted,isComposing:e.isComposing}),{capture:true,signal:__imeAbort.signal});
      document.querySelector('#blocks .block-content').focus();
    })()`,
    );
    await compose("に");
    await compose("日本語");
    await client.send("Input.insertText", { text: "日本語" });
    const content = await evaluate(
      client,
      `(()=>{const el=document.querySelector('#blocks .block-content');return {model:getCurrentPage().blocks[0].content,dom:el.textContent,focused:document.activeElement===el}})()`,
    );
    assert.equal(content.model, "日本語");
    assert.equal(content.dom, "日本語");
    assert.equal(content.focused, true);
    await compose("追加");
    await compose("");
    const cancelled = await evaluate(
      client,
      `getCurrentPage().blocks[0].content==='日本語'&&document.querySelector('#blocks .block-content').textContent==='日本語'`,
    );
    assert.equal(cancelled, true);
    await evaluate(
      client,
      `(()=>{const el=document.querySelector('#page-title');el.focus()})()`,
    );
    await compose("たいとる");
    await client.send("Input.insertText", { text: "日本語のノート" });
    const title = await evaluate(
      client,
      `getCurrentPage().title==='日本語のノート'&&document.querySelector('#page-title').textContent==='日本語のノート'&&document.activeElement.id==='page-title'`,
    );
    assert.equal(title, true);
    await evaluate(client, `openSearchModal('')`);
    await waitForReady(
      client,
      "document.activeElement.id==='search-input'",
      5000,
    );
    await compose("に");
    await compose("日本語");
    const deferred = await evaluate(
      client,
      `_searchComposing&&_searchRenderTimer===null&&!searchOverlay.hidden`,
    );
    assert.equal(deferred, true);
    await client.send("Input.insertText", { text: "日本語" });
    await waitForReady(
      client,
      "!_searchComposing&&_searchRenderTimer===null&&searchInput.value==='日本語'",
      5000,
    );
    const search = await evaluate(
      client,
      `searchItems.some(el=>el.textContent.includes('日本語'))`,
    );
    assert.equal(search, true);
    await evaluate(client, `closeSearchModal()`);
    const events = await evaluate(client, `__imeEvents`);
    assert.ok(events.some((e) => e.type === "compositionstart"));
    assert.ok(events.some((e) => e.type === "compositionend"));
    assert.ok(
      events
        .filter((e) =>
          ["compositionstart", "compositionupdate"].includes(e.type),
        )
        .every((e) => e.isTrusted),
    );
    const persisted = await evaluate(
      client,
      `(async()=>{clearTimeout(_saveTimer);_saveTimer=null;let saved=false;for(let n=0;n<100&&!saved;n++){saved=await _doSave({force:true});if(!saved)await new Promise(r=>setTimeout(r,50))}const stored=await loadStateAsync();return saved&&stored.pages[stored.currentPageId].title==='日本語のノート'&&stored.pages[stored.currentPageId].blocks[0].content==='日本語'})()`,
    );
    assert.equal(persisted, true);
    trials.push({
      trial,
      content,
      cancelled,
      title,
      deferred,
      search,
      persisted,
      events,
    });
  }
  const result = {
    browser: await client.send("Browser.getVersion"),
    source,
    tool: "CDP experimental test transport; browser-generated composition, trusted start/update; end trust flags recorded; no OS candidate UI",
    trials,
  };
  if (output) await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  console.log(
    "PASS: 5 browser-generated composition trials; content/title/search/cancel/readback",
  );
} finally {
  client?.close();
  await stopBrowser(browser);
}
