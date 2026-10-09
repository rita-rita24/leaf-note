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
const browser = await launchBrowser();
let client;
const rows = [];
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
  for (const count of [100, 1000])
    for (let trial = 0; trial < 5; trial++) {
      const samples = await evaluate(
        client,
        `(async()=>{
   const api=window.__LeafNoteTest,frame=()=>new Promise(r=>requestAnimationFrame(r));
   const reset=async()=>{qsa('.overlay').forEach(closeOverlay);const draft=createInitialState();draft.pages[draft.currentPageId].title='Original note';draft.pages[draft.currentPageId].blocks=Array.from({length:${count}},(_,i)=>blk('text','Editable block '+i));api.setState(draft);renderAll();await document.fonts.ready;await frame();await frame()};
   const samples=[];
   const measure=async(name,action,correct,changed=false)=>{
    await reset();const start=performance.now();action();const handlerMs=performance.now()-start;await frame();const responseProxyMs=performance.now()-start;if(!correct())throw Error(name+' result incorrect');
    let savedMs=null;if(changed){clearTimeout(_saveTimer);_saveTimer=null;const saveStart=performance.now();let saved=false;for(let i=0;i<100&&!saved;i++){saved=await api._doSave({force:true});if(!saved)await new Promise(r=>setTimeout(r,10))}if(!saved)throw Error(name+' persistence did not complete');const stored=await api.loadStateAsync(),current=api.getState();if(stored.pages[current.currentPageId]?.title!==current.pages[current.currentPageId]?.title||JSON.stringify(stored.pages[current.currentPageId]?.blocks)!==JSON.stringify(current.pages[current.currentPageId]?.blocks))throw Error(name+' persisted data differs');savedMs=performance.now()-saveStart}
    samples.push({name,handlerMs,responseProxyMs,savedMs,correct:true});
   };
   await measure('search open',()=>document.querySelector('#search-btn').click(),()=>!document.querySelector('#search-overlay').hidden);
   await measure('settings open',()=>document.querySelector('#settings-btn').click(),()=>!document.querySelector('#theme-customizer-overlay').hidden);
   await measure('trash open',()=>document.querySelector('#trash-btn').click(),()=>!document.querySelector('#trash-overlay').hidden);
   await measure('shortcuts open',()=>document.querySelector('#shortcuts-btn').click(),()=>!document.querySelector('#shortcuts-overlay').hidden);
   let oldDark;await measure('theme toggle',()=>{oldDark=api.getState().darkMode;document.querySelector('#theme-toggle').click()},()=>api.getState().darkMode!==oldDark,true);
   await measure('note create',()=>document.querySelector('#new-page-btn').click(),()=>Object.keys(api.getState().pages).length===2&&getCurrentPage().blocks.length===1,true);
   await measure('note title edit',()=>{const title=document.querySelector('#page-title');title.textContent='Renamed note';title.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Renamed note'}))},()=>getCurrentPage().title==='Renamed note',true);
   await measure('text edit',()=>{const text=document.querySelector('#blocks .block-content');text.textContent='Latest edited text';text.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Latest edited text'}))},()=>getCurrentPage().blocks[0].content==='Latest edited text',true);
   await measure('note duplicate',()=>duplicatePage(api.getState().currentPageId),()=>Object.keys(api.getState().pages).length===2&&Object.values(api.getState().pages)[1].blocks.length===${count},true);
   let removed;await measure('note trash',()=>{removed=api.getState().currentPageId;deletePage(removed);renderAll()},()=>!!api.getState().pages[removed].deletedAt&&api.getState().currentPageId!==removed,true);
   await measure('undo redo',()=>{getCurrentPage().blocks[0].content='undo fixture';saveState();undo();redo()},()=>getCurrentPage().blocks[0].content==='undo fixture',true);
   return samples;
  })()`,
      );
      rows.push(...samples.map((sample) => ({ count, trial, ...sample })));
      await writeFile(
        output,
        JSON.stringify(
          {
            date: new Date().toISOString(),
            source,
            browser: await requestJson(browser.port, "/json/version"),
            conditions: {
              cpu: 4,
              viewport: "1280x800",
              cache:
                "page already loaded; each operation uses reset synthetic state",
              trials: 5,
              endpoint:
                "Handler CPU and correct DOM/state plus next animation frame are separate proxies, not presented pixels or INP. Persistence endpoint includes forced save and readback comparison. Page duplicate/trash/undo use application methods rather than native pointer/keyboard dispatch.",
              network:
                "No explicit network throttling for already-loaded local operations; external font state warmed.",
            },
            rows,
          },
          null,
          2,
        ),
      );
    }
  console.log(
    "PASS:",
    rows.length,
    "screen action samples; changed data saved and read back",
  );
} finally {
  client?.close();
  await stopBrowser(browser);
}
