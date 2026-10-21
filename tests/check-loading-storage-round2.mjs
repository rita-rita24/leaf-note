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
      `(async()=>{
   const rows=[];const calls=[];
   const fixed={documentId:'fixture',workspaceName:'Fixture',rootPages:['one'],currentPageId:'one',pages:{one:{id:'one',title:'One',children:[],parentId:null,blocks:[{id:'block',type:'text',content:'body',children:[]}],createdAt:1,updatedAt:1}},lastModifiedAt:1};
   for(const variant of ['identical','newer-local','newer-idb','same-revision-different-content','empty-local','empty-idb']){
    const dbState=JSON.parse(JSON.stringify(fixed));const localState=JSON.parse(JSON.stringify(fixed));
    if(variant==='newer-local'){localState.lastModifiedAt=2;localState.pages.one.blocks[0].content='local new'}
    if(variant==='newer-idb'){dbState.lastModifiedAt=2;dbState.pages.one.blocks[0].content='idb new'}
    if(variant==='same-revision-different-content')localState.pages.one.blocks[0].content='different at same time';
    const db=await openDB();await new Promise((r,j)=>{const tx=db.transaction(DB_STORE,'readwrite');const store=tx.objectStore(DB_STORE);if(variant==='empty-idb')store.delete('app-state');else store.put(dbState,'app-state');tx.oncomplete=r;tx.onerror=j});db.close();
    if(variant==='empty-local')localStorage.removeItem(STATE_STORAGE_KEY);else localStorage.setItem(STATE_STORAGE_KEY,JSON.stringify(localState));
    const original=_storageSnapshotSignature;let count=0;_storageSnapshotSignature=(...args)=>{count++;return original(...args)};
    let loaded;try{loaded=await loadStateAsync({trackStorageBaseline:true})}finally{_storageSnapshotSignature=original}
    rows.push({variant,loaded,baseline:{..._storageBaseline}});calls.push(count);
    if(variant==='same-revision-different-content'){const conflict=_storageSnapshotMatchesBaseline('idb',JSON.stringify(localState));if(conflict!==false)throw new Error('Different equal-revision content must remain a conflict');_storageConflictDetected=false;}
   }
   return {rows,calls};
  })()`,
    );
    outputs.push(out);
    c.close();
  } finally {
    await stopBrowser(b);
  }
}
assert.deepEqual(
  outputs[0].rows,
  outputs[1].rows,
  "Startup selection and all conflict signatures must match",
);
assert.equal(
  outputs[1].calls[0],
  2,
  "The unconfirmed snapshot-reuse candidate has been reverted",
);
assert.equal(
  outputs[1].calls[3],
  2,
  "Different content at equal revision hashes both",
);
await writeFile(
  process.env.STORAGE_REPORT ||
    "reports/loading-2026-10-09-round2/storage-equivalence.json",
  JSON.stringify(
    {
      passed: true,
      cases: outputs[1].rows,
      hashCallsBefore: outputs[0].calls,
      hashCallsAfter: outputs[1].calls,
    },
    null,
    2,
  ),
);
console.log("Storage equivalence passed");
