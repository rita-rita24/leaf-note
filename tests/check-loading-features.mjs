import assert from "node:assert/strict";
import {
  launchBrowser,
  stopBrowser,
  CdpClient,
  requestJson,
  evaluate,
  waitForReady,
} from "./loading-cdp.mjs";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
const outputs = [];
for (const root of process.argv.slice(2)) {
  const browser = await launchBrowser();
  try {
    const target = await requestJson(
      browser.port,
      "/json/new?about:blank",
      "PUT",
    );
    const c = new CdpClient(target.webSocketDebuggerUrl);
    await c.connect();
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    const url = root.startsWith("http")
      ? new URL("LeafNote.html", root).href
      : pathToFileURL(
          path.join(
            root,
            existsSync(path.join(root, "leaf-note.html"))
              ? "leaf-note.html"
              : "LeafNote.html",
          ),
        ).href;
    await c.send("Page.navigate", { url: url + "?test=1" });
    await waitForReady(c, "window.__LeafNoteTest?.isReady()", 30000);
    const output = await evaluate(
      c,
      `(async()=>{
   const corpus=['','plain text','日本語 🌱','a > b','\\t tab \\n newline','a\\rb','a\\u0000b','&amp; &lt; &#13;','a<br>b','<b>bold</b>','<!--hidden-->visible','<script>hello<'+ '/script>'];
   const reference=value=>{const d=document.createElement('div');d.innerHTML=value||'';d.querySelectorAll('br').forEach(br=>br.replaceWith('\\n'));return d.textContent||''};
   for(let i=0;i<500;i++)corpus.push('random plain '+String.fromCodePoint(0x20+i)+' '+i);
   const mismatch=corpus.filter(value=>stripHTMLToText(value)!==reference(value));
   const sanitizeResults=corpus.map(value=>sanitizeHTML(value));
   const s=JSON.parse(JSON.stringify(state));s.pages={};s.rootPages=[];
   for(let p=0;p<100;p++){
    const id='fixture-'+p;s.rootPages.push(id);s.pages[id]={id,title:'Fixture '+p,parentId:null,icon:'',iconType:'emoji',hasIcon:false,children:[],createdAt:1700000000000,updatedAt:1700000000000,
      blocks:Array.from({length:100},(_,b)=>blk(b%8===0?'numbered':b%11===0?'h2':'text',b%3===0?'Multiline <b>content</b><br>second line 🌱':'Plain body fixture '+b))};
   }
   s.currentPageId=s.rootPages[0];state=s;renderAll();
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const gutters=Array.from(document.querySelectorAll('#blocks .block')).map(el=>({type:el.dataset.type,top:el.querySelector('.block-gutter')?.style.top,text:el.querySelector('.block-content')?.textContent}));
   const snapshots=[];
   for(const q of ['Fixture','Plain body','not present']){renderSearchResults(q);snapshots.push({q,text:document.getElementById('search-results').textContent,items:Array.from(document.querySelectorAll('.search-item-title')).map(e=>e.textContent)})}
   state.pages[state.currentPageId].blocks[1].content='newly updated needle';renderSearchResults('newly updated needle');
   const fresh=document.getElementById('search-results').textContent.includes('newly updated needle');
   const snapshotBefore=JSON.stringify(state);renderAll();const renderPreservesData=JSON.stringify(state)===snapshotBefore;
   const originalFetch=window.fetch;window.fetch=async()=>{throw new Error('offline fixture')};let backup;try{backup=await getSourceHtmlForExport()}finally{window.fetch=originalFetch}
   const duplicatedIcon=/<link[^>]+id="leafnote-deferred-icon"/.test(backup);
   return {mismatch,sanitizeResults,gutters,snapshots,fresh,renderPreservesData,duplicatedIcon,icon:document.querySelector('link[rel="icon"]').href};
  })()`,
    );
    assert.deepEqual(output.mismatch, []);
    assert.ok(output.fresh);
    assert.ok(output.renderPreservesData);
    assert.equal(output.duplicatedIcon, false);
    outputs.push(output);
    c.close();
  } finally {
    await stopBrowser(browser);
  }
}
assert.deepEqual(outputs[0].gutters, outputs[1].gutters);
assert.deepEqual(outputs[0].sanitizeResults, outputs[1].sanitizeResults);
assert.deepEqual(outputs[0].snapshots, outputs[1].snapshots);
assert.equal(outputs[0].icon, outputs[1].icon);
await writeFile(
  process.env.FEATURE_REPORT ||
    "reports/loading-2026-10-09/feature-comparison.json",
  JSON.stringify(
    {
      passed: true,
      checks: [
        "512 HTML/text cases",
        "100 block gutter positions",
        "search content/count/order",
        "update visible immediately",
        "render preserves state",
        "offline backup avoids duplicate icon",
        "identical icon pixels",
      ],
      outputs: outputs.map(({ icon, ...rest }) => rest),
    },
    null,
    2,
  ),
);
console.log("Loading feature equivalence checks passed");
