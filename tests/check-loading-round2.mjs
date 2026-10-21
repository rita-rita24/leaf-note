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
import path from "node:path";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const outputs = [];
for (const root of process.argv.slice(2)) {
  const b = await launchBrowser();
  try {
    const target = await requestJson(b.port, "/json/new?about:blank", "PUT");
    const c = new CdpClient(target.webSocketDebuggerUrl);
    await c.connect();
    await c.send("Page.enable");
    const url = root.startsWith("https:")
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
    const out = await evaluate(
      c,
      `(()=>{
   const results=[]; const strings=['','ASCII','日本語','🌱','a\\uD800b','a\\uDC00b','\\u0000\\r\\n','a &amp; <b>test</b>'];
   for(let i=0;i<256;i++)strings.push('prefix'+String.fromCodePoint(i*257)+'suffix');
   const limits=[0,1,2,3,4,5,8,12,32,128,NaN,Infinity,-1,'3'];
   for(const text of strings)for(const limit of limits)results.push([_truncateStringByUtf8Bytes(text,limit),_statePayloadLimitViolation(text,limit),_utf8ByteLength(text)]);
   for(const text of ['A'.repeat(500000),'日本語'.repeat(10000),'🌱'.repeat(10000)])for(const limit of [0,text.length-1,text.length,text.length*2,text.length*3,text.length*4])results.push([_truncateStringByUtf8Bytes(text,limit).bytes,_statePayloadLimitViolation(text,limit),_utf8ByteLength(text)]);
   const s=JSON.parse(JSON.stringify(state));s.pages={};s.rootPages=['one','two'];s.currentPageId='one';
   const page=(id,title,children=[])=>({id,title,parentId:null,children,icon:'',iconType:'emoji',hasIcon:false,createdAt:1,updatedAt:1,blocks:[{id:'block-'+id,type:'text',content:'body '+id,children:[]}]});
   s.pages.one=page('one','One',['child']);s.pages.two=page('two','Two');s.pages.child=page('child','Child');s.pages.child.parentId='one';state=s;
   const snapshots=[];const snapshot=()=>{renderSidebar();const tree=document.querySelector('#page-tree').cloneNode(true);for(const el of tree.querySelectorAll('*')){if(el.hasAttribute('class'))el.setAttribute('class',Array.from(el.classList).sort().join(' '));const attrs=Array.from(el.attributes).map(a=>[a.name,a.value]).sort((a,b)=>a[0].localeCompare(b[0]));for(const a of Array.from(el.attributes))el.removeAttribute(a.name);for(const [name,value] of attrs)el.setAttribute(name,value)}snapshots.push(tree.innerHTML)};
   expandedPages.clear();snapshot();state.currentPageId='two';snapshot();state.pages.one.title='Updated <title>';snapshot();state.pages.two.icon='search';state.pages.two.iconType='material';state.pages.two.hasIcon=true;snapshot();expandedPages.add('one');snapshot();state.pages.child.deletedAt=2;snapshot();delete state.pages.child.deletedAt;snapshot();state.rootPages.reverse();snapshot();state.uiLanguage='ja';snapshot();state.pages.three=page('three','Three');state.rootPages.push('three');snapshot();state.pages.two.deletedAt=2;snapshot();state.currentPageId='one';snapshot();state.pages.one.children=[];snapshot();state.pages={};state.rootPages=[];snapshot();state.pages.one=page('one','Again');state.rootPages=['one'];snapshot();
   const first=document.querySelector('#page-tree').firstChild;renderSidebar();const reused=first===document.querySelector('#page-tree').firstChild;
   return {results,snapshots,reused};
  })()`,
    );
    outputs.push(out);
    c.close();
  } finally {
    await stopBrowser(b);
  }
}
assert.deepEqual(
  outputs[0].results,
  outputs[1].results,
  "UTF-8 limits and truncation must match exactly",
);
for (let i = 0; i < outputs[0].snapshots.length; i++) {
  if (outputs[0].snapshots[i] !== outputs[1].snapshots[i]) {
    await writeFile(
      "/tmp/round2-sidebar-diff.json",
      JSON.stringify(
        {
          index: i,
          before: outputs[0].snapshots[i],
          after: outputs[1].snapshots[i],
        },
        null,
        2,
      ),
    );
    throw new Error(
      "Sidebar mismatch at mutation " +
        i +
        "; see /tmp/round2-sidebar-diff.json",
    );
  }
}
assert.ok(outputs[1].reused, "Unchanged sidebar must reuse its DOM");
await writeFile(
  process.env.ROUND2_REPORT ||
    "reports/loading-2026-10-09-round2/equivalence.json",
  JSON.stringify(
    {
      passed: true,
      utf8Cases: outputs[0].results.length,
      sidebarCases: outputs[0].snapshots.length,
      outputHash: createHash("sha256")
        .update(JSON.stringify(outputs[0].results))
        .digest("hex"),
      candidateReusesDOM: outputs[1].reused,
    },
    null,
    2,
  ),
);
console.log("Round 2 equivalence passed");
