import {
  launchBrowser,
  stopBrowser,
  CdpClient,
  requestJson,
  evaluate,
  waitForReady,
} from "./loading-cdp.mjs";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

// Isolated synthetic data only. No user profile, cache purge, or shared origin writes.
const [
  baseArg,
  output = "reports/loading-2026-10-09/measure.json",
  app = "LeafNote.html",
] = process.argv.slice(2);
let server;
let base = baseArg;
if (!base.startsWith("http") && !base.startsWith("file:")) {
  const root = path.resolve(base);
  server = http.createServer(async (req, res) => {
    try {
      const file = path.join(
        root,
        new URL(req.url, "http://localhost").pathname === "/"
          ? "index.html"
          : decodeURIComponent(new URL(req.url, "http://localhost").pathname),
      );
      res.setHeader(
        "Content-Type",
        file.endsWith(".html")
          ? "text/html;charset=utf-8"
          : "application/octet-stream",
      );
      res.setHeader("Cache-Control", "max-age=600");
      res.end(await readFile(file));
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
}
const browser = await launchBrowser();
const result = {
  started: new Date().toISOString(),
  base: baseArg,
  app,
  node: process.version,
  conditions: {
    viewport: "1280x800",
    cpu: 4,
    latency: 150,
    downBytesPerSec: 200000,
    upBytesPerSec: 100000,
    cold: "Network cache disabled, dedicated temporary Chrome profile; synthetic storage retained",
    warm: "same profile, browser cache enabled and primed",
    cdn: "not purged or controlled; headers captured",
  },
  samples: [],
  errors: [],
};
try {
  const target = await requestJson(
    browser.port,
    "/json/new?about:blank",
    "PUT",
  );
  const c = new CdpClient(target.webSocketDebuggerUrl);
  await c.connect();
  c.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (
      message.method === "Page.javascriptDialogOpening" &&
      message.params.type === "beforeunload"
    )
      c.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    if (message.method === "Runtime.exceptionThrown")
      result.errors.push(
        message.params.exceptionDetails.exception?.description ||
          message.params.exceptionDetails.text,
      );
  });
  for (const name of ["Page", "Runtime", "Network"])
    await c.send(name + ".enable");
  result.browser = await requestJson(browser.port, "/json/version");
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await c.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await c.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: 200000,
    uploadThroughput: 100000,
    connectionType: "cellular4g",
  });
  const nav = async (url, kind, cache, data, round, record = true) => {
    await c.send("Network.setCacheDisabled", {
      cacheDisabled: cache === "cold",
    });
    const src = `(() => {
     window.__loadingMeasure = {content:null, interactive:null, longTasks:[]};
     new PerformanceObserver(l=>{for(const e of l.getEntries()) window.__loadingMeasure.longTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true});
     const frame=()=>{
       const m=window.__loadingMeasure;
       const content=${kind === "index" ? "document.querySelector('h1') && document.querySelector('[data-copy-source]')" : "document.querySelector('#blocks .block') && document.querySelector('#page-tree .page-item')"};
       if(content && ${kind === "app" ? "true" : "false"} && document.querySelector('#dialog-overlay') && !document.querySelector('#dialog-overlay').hidden) {
         // A legacy synthetic fixture can need non-lossy format repair. Include
         // acknowledging that notice in the scripted workflow; never click through
         // loss, conflicts, or unexpected errors to declare the app usable.
         if(typeof t==='function' && document.querySelector('#dialog-title')?.textContent===t('dialog.repairTitle') &&
            typeof state!=='undefined' && Object.keys(state.pages).length===100 &&
            Object.values(state.pages).every(p=>p.blocks.length===100)) {
           document.querySelector('#dialog-box [data-ok]')?.click();m.startupNoticeAcknowledged=performance.now();
         }
         requestAnimationFrame(frame);return;
       }
       if(content && ${kind === "index" ? "true" : "false"} && !m.imagesChecked) {
         m.imagesChecked=true;m.imagesReady=false;
         Promise.all(['.lp-title','.lp-page'].map(selector=>new Promise((resolve,reject)=>{
           const value=getComputedStyle(document.querySelector(selector)).backgroundImage;
           const url=value.slice(5,-2);const image=new Image();image.onload=()=>resolve();image.onerror=()=>reject(new Error('Required distribution image failed'));image.src=url;
         }))).then(()=>{m.imagesReady=true});
       }
       if(content && (${kind === "index" ? "m.imagesReady" : "true"}) && m.content===null) m.content=performance.now();
       if(content && m.interactive===null) {
         if(${kind === "index" ? "document.querySelector('[data-copy-source]') && !document.querySelector('[data-copy-source]').disabled && document.querySelector('#leafnote-source') && typeof _getLeafNoteSource !== 'undefined'" : "typeof state !== 'undefined' && typeof openSearchModal === 'function' && document.querySelector('#search-btn')"}) {
           ${kind === "index" ? "try { const s=_getLeafNoteSource(); if(typeof s==='string' && s.startsWith('<!DOCTYPE html>'))m.interactive=performance.now(); } catch {}" : "try{document.querySelector('#search-btn').click(); if(!document.querySelector('#search-overlay').hidden && document.querySelector('.search-item')) { closeSearchModal(); m.interactive=performance.now(); }}catch{}"}
         }
       }
       if(m.interactive===null || m.content===null) requestAnimationFrame(frame);
     }; requestAnimationFrame(frame);
   })();`;
    const added = await c.send("Page.addScriptToEvaluateOnNewDocument", {
      source: src,
    });
    await c.send("Page.navigate", { url });
    await waitForReady(
      c,
      "window.__loadingMeasure?.interactive !== null && window.__loadingMeasure?.interactive !== undefined && window.__loadingMeasure?.content !== null",
      60000,
    );
    // The user metric remains the earlier frame. Complete optional transfers before
    // the next navigation so a warm reload does not cancel an uncached response.
    await waitForReady(c, "document.readyState === 'complete'", 60000);
    const m = await evaluate(
      c,
      `({...window.__loadingMeasure, navigation:performance.getEntriesByType('navigation')[0].toJSON(), pages:typeof state==='undefined'?null:Object.keys(state.pages).length, blocks:document.querySelectorAll('#blocks .block').length})`,
    );
    await c.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: added.identifier,
    });
    if (record) {
      result.samples.push({
        screen: kind,
        operation: "navigate",
        cache,
        data,
        round,
        ...m,
      });
      console.log(
        kind,
        data,
        cache,
        round,
        Math.round(m.content),
        Math.round(m.interactive),
      );
      await writeFile(output, JSON.stringify(result, null, 2));
    }
  };
  const operation = async (name, expr, condition, data, round) => {
    const m = await evaluate(
      c,
      `(async()=>{const start=performance.now(); ${expr}; await new Promise((resolve,reject)=>{const until=()=>{if(${condition})return requestAnimationFrame(()=>resolve()); if(performance.now()-start>30000)return reject(new Error('operation timeout'));requestAnimationFrame(until)};until()}); const content=performance.now()-start; const active=document.activeElement;return {content,interactive:content,items:document.querySelectorAll('.search-item').length,title:document.querySelector('#page-title').textContent,focus:active?.id};})()`,
    );
    result.samples.push({
      screen: name,
      operation: name,
      cache: "warm",
      data,
      round,
      ...m,
    });
    await writeFile(output, JSON.stringify(result, null, 2));
  };
  for (const kind of (process.env.PERF_SCREENS || "index,app").split(",")) {
    for (const data of kind === "index"
      ? ["default"]
      : ["default", "100-notes-100-blocks"]) {
      const url = new URL(kind === "index" ? "index.html" : app, base).href;
      await nav(url, kind, "cold", data, 0, false);
      if (kind === "app") {
        await evaluate(
          c,
          `(async()=>{const s=JSON.parse(JSON.stringify(state));
      ${data === "default" ? "" : `s.pages={};s.rootPages=[];for(let p=0;p<100;p++){const id='perf-page-'+p;s.rootPages.push(id);s.pages[id]={id,title:'Performance note '+p,icon:'',iconType:'emoji',hasIcon:false,parentId:null,children:[],createdAt:1700000000000,updatedAt:1700000000000,blocks:Array.from({length:100},(_,b)=>({id:'perf-block-'+p+'-'+b,type:'text',content:'Synthetic body '+p+' '+b+' loading verification needle',children:[]}))};}s.currentPageId=s.rootPages[0];`}
      window.__perfExpected=JSON.stringify(s); state=s;
      const db=await openDB();await new Promise((r,j)=>{const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).put(s,'app-state');tx.oncomplete=r;tx.onerror=j});db.close();localStorage.setItem(STATE_STORAGE_KEY,JSON.stringify(s));
      if(typeof _lastPersistedStateJSON!=='undefined') _lastPersistedStateJSON=JSON.stringify(s);
      if(typeof _rememberStorageSnapshot==='function'){_rememberStorageSnapshot('idb',JSON.stringify(s));_rememberStorageSnapshot('local',JSON.stringify(s));}
    })();`,
        );
      }
      for (
        let round = 1;
        round <= Number(process.env.PERF_ROUNDS || 5);
        round++
      ) {
        if (process.env.PERF_EXTRA_ONLY)
          await nav(url, kind, "warm", data, round, false);
        else
          for (const cache of ["cold", "warm"])
            await nav(url, kind, cache, data, round);
        if (kind === "app") {
          if (process.env.PERF_EXTRA_ONLY) {
            if (process.env.PERF_REVALIDATE_SOURCE)
              await evaluate(
                c,
                `{const originalFetch=window.fetch;window.fetch=(input,options)=>originalFetch(input,String(input)===location.href?{...options,cache:'no-cache'}:options);}`,
              );
            await operation(
              "backup-dialog",
              `document.getElementById('export-btn').click()`,
              "!document.getElementById('dialog-overlay').hidden && !!document.querySelector('#dialog-box [data-ok]')",
              data,
              round,
            );
            const backup = await evaluate(
              c,
              `(async()=>{
       const originalCreate=URL.createObjectURL, originalClick=HTMLAnchorElement.prototype.click;
       let blob=null;URL.createObjectURL=value=>{blob=value;return originalCreate(value)};HTMLAnchorElement.prototype.click=()=>{};
       const expected=JSON.stringify(state.pages),start=performance.now();
       try {
        document.querySelector('#dialog-box [data-ok]').click();
        await new Promise((resolve,reject)=>{const poll=()=>{if(blob)return resolve();if(performance.now()-start>30000)return reject(new Error('backup timeout'));setTimeout(poll,5)};poll()});
        const content=performance.now()-start,html=await blob.text();
        const match=html.match(/<script id="embedded-state"[^>]*>([\\s\\S]*?)<\\/script>/);
        const saved=match?JSON.parse(match[1]):null;
        return {content,interactive:content,correct:JSON.stringify(saved?.pages)===JSON.stringify(state.pages),bytes:blob.size,
          savedPages:saved?.pages?Object.keys(saved.pages).length:null, currentPages:Object.keys(state.pages).length};
       }finally{URL.createObjectURL=originalCreate;HTMLAnchorElement.prototype.click=originalClick}
      })()`,
            );
            if (!backup.correct) throw new Error("backup data mismatch");
            result.samples.push({
              screen: "backup-result",
              operation: "backup-result",
              data,
              cache: "warm",
              round,
              ...backup,
            });
            await writeFile(output, JSON.stringify(result, null, 2));
            continue;
          }
          if (data !== "default")
            await operation(
              "note-switch",
              `const items=document.querySelectorAll('#page-tree .page-item');const target=items[0].classList.contains('active')?items[1]:items[0];window.__perfTarget=target.dataset.pageId;target.click()`,
              "state.currentPageId===window.__perfTarget && !!document.querySelector('#blocks .block')",
              data,
              round,
            );
          await operation(
            "search-open",
            `document.querySelector('#search-btn').click()`,
            "!document.querySelector('#search-overlay').hidden && !!document.querySelector('.search-item')",
            data,
            round,
          );
          await operation(
            "search-results",
            `const input=document.querySelector('#search-input');input.value='verification needle';input.dispatchEvent(new Event('input',{bubbles:true}))`,
            "document.querySelector('#search-results').textContent.includes('verification needle') || document.querySelector('.search-empty')",
            data,
            round,
          );
          await evaluate(c, "closeSearchModal()");
          for (const [name, button, overlay] of [
            ["settings", "settings-btn", "theme-customizer-overlay"],
            ["trash", "trash-btn", "trash-overlay"],
            ["help", "shortcuts-btn", "shortcuts-overlay"],
          ]) {
            await operation(
              name,
              name === "help"
                ? `openShortcutsModal()`
                : `document.getElementById('${button}').click()`,
              `!document.getElementById('${overlay}').hidden && !!document.getElementById('${overlay}').querySelector('button')`,
              data,
              round,
            );
            await evaluate(
              c,
              `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
            );
          }
        }
      }
    }
  }
  c.close();
} catch (error) {
  result.errors.push(error.stack);
  throw error;
} finally {
  result.ended = new Date().toISOString();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  await stopBrowser(browser);
  await rm(browser.userDataDir, { recursive: true, force: true });
  server?.close();
}

// Exit only after records and owned-browser cleanup have completed.
process.exit(result.errors.length ? 1 : 0);
