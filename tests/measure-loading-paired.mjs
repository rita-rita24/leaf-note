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
import { writeFile } from "node:fs/promises";
const [
  before,
  after,
  output = "reports/loading-2026-10-09-round2/paired-offline.json",
] = process.argv.slice(2);
const browser = await launchBrowser();
const result = {
  started: new Date().toISOString(),
  conditions: {
    cpu: 4,
    viewport: "1280x800",
    protocol: "file://",
    cache:
      "Both files primed, same dedicated browser, before/after order alternates each pair; HTTP throttling does not apply",
    data: "Canonical synthetic 100 notes x 100 text blocks",
  },
  samples: [],
};
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
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await c.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const urls = {
    before: pathToFileURL(path.join(before, "LeafNote.html")).href + "?test=1",
    after: pathToFileURL(path.join(after, "LeafNote.html")).href + "?test=1",
  };
  c.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (
      m.method === "Page.javascriptDialogOpening" &&
      m.params.type === "beforeunload"
    )
      c.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  });
  for (const kind of ["before", "after"]) {
    await c.send("Page.navigate", { url: urls[kind] });
    await waitForReady(c, "window.__LeafNoteTest?.isReady()", 30000);
    await evaluate(
      c,
      `(async()=>{const raw=JSON.parse(JSON.stringify(state));raw.documentId='paired-performance-document';raw.pages={};raw.rootPages=[];for(let p=0;p<100;p++){const id='page-'+p;raw.rootPages.push(id);raw.pages[id]={id,title:'Note '+p,icon:'',iconType:'emoji',hasIcon:false,parentId:null,children:[],createdAt:1700000000000,updatedAt:1700000000000,blocks:Array.from({length:100},(_,b)=>({id:'block-'+p+'-'+b,type:'text',content:'Synthetic body '+p+' '+b+' needle',children:[]}))}}raw.currentPageId='page-0';state=normalizeStateShape(raw).state;sanitizeStateInPlace(state);const snapshot=JSON.stringify(state);const db=await openDB();await new Promise((r,j)=>{const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).put(state,'app-state');tx.oncomplete=r;tx.onerror=j});db.close();localStorage.setItem(STATE_STORAGE_KEY,snapshot);_lastPersistedStateJSON=snapshot;_rememberStorageSnapshot('local',snapshot);_rememberStorageSnapshot('idb',snapshot)})()`,
    );
  }
  const added = await c.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__paired={content:null,interactive:null};const measureFrame=()=>{const m=window.__paired;if(document.querySelectorAll('#blocks .block').length===100 && document.querySelectorAll('#page-tree .page-item').length===100 && document.querySelector('#dialog-overlay')?.hidden){if(m.content===null)m.content=performance.now();document.querySelector('#search-btn').click();if(!document.querySelector('#search-overlay').hidden){closeSearchModal();m.interactive=performance.now();return}}requestAnimationFrame(measureFrame)};requestAnimationFrame(measureFrame);`,
  });
  for (let pair = 1; pair <= 10; pair++)
    for (const kind of pair % 2 ? ["before", "after"] : ["after", "before"]) {
      await c.send("Page.navigate", { url: urls[kind] });
      await waitForReady(
        c,
        "window.__paired?.interactive!==null && window.__paired?.interactive!==undefined",
        30000,
      );
      await waitForReady(c, "document.readyState==='complete'", 30000);
      const metric = await evaluate(
        c,
        '({...window.__paired,pages:Object.keys(state.pages).length,blocks:document.querySelectorAll("#blocks .block").length})',
      );
      const sw = await evaluate(
        c,
        `(async()=>{const target=state.currentPageId==='page-0'?'page-1':'page-0';const start=performance.now();document.querySelector('.page-item[data-page-id="'+target+'"]').click();await new Promise(r=>requestAnimationFrame(r));if(state.currentPageId!==target||document.querySelectorAll('#blocks .block').length!==100)throw new Error('Switch result mismatch');return performance.now()-start})()`,
      );
      result.samples.push({ kind, pair, ...metric, switch: sw });
      console.log(kind, pair, Math.round(metric.interactive), Math.round(sw));
      await writeFile(output, JSON.stringify(result, null, 2));
    }
  result.finished = new Date().toISOString();
  result.browser = await requestJson(browser.port, "/json/version");
  await writeFile(output, JSON.stringify(result, null, 2));
  await c.send("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: added.identifier,
  });
  c.close();
} finally {
  await stopBrowser(browser);
}
