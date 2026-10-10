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
      const row = await evaluate(
        client,
        `(async()=>{const draft=createInitialState();draft.pages[draft.currentPageId].blocks=Array.from({length:${count}},(_,i)=>blk('text','Resize block '+i));__LeafNoteTest.setState(draft);setSidebarCollapsed(false);applySidebarWidth(260);renderAll();await document.fonts.ready;await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>requestAnimationFrame(r));let writes=0;const style=document.documentElement.style,original=style.setProperty;style.setProperty=function(name,...args){if(name==='--sidebar-width')writes++;return original.call(this,name,...args)};const start=performance.now();document.querySelector('#sidebar-resizer').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,clientX:260}));for(let i=0;i<60;i++)document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:261+i,buttons:1}));const handlerMs=performance.now()-start;document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));const completionMs=performance.now()-start;await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>requestAnimationFrame(r));const frameProxyMs=performance.now()-start;style.setProperty=original;const width=parseInt(style.getPropertyValue('--sidebar-width'),10),saved=localStorage.getItem(SIDEBAR_WIDTH_KEY);if(width!==320||saved!=='320'||document.querySelector('#sidebar').classList.contains('resizing'))throw Error('Width/save/finalization mismatch');return {handlerMs,completionMs,frameProxyMs,writes,width,saved,correct:true}})()`,
      );
      assert.equal(row.correct, true);
      rows.push({ count, trial, ...row });
    }
  await writeFile(
    output,
    JSON.stringify(
      {
        source,
        date: new Date().toISOString(),
        browser: (await requestJson(browser.port, "/json/version")).Browser,
        conditions: {
          cpu: 4,
          viewport: "1280x800",
          trials: 5,
          events:
            "60 synthetic mousemove events in one task; final mouseup flush; not native input latency",
          endpoint:
            "correct width and localStorage readback, then two rAF proxy; not displayed pixels/INP",
        },
        rows,
      },
      null,
      2,
    ),
  );
  console.log("PASS", rows.length, "resize samples");
} finally {
  client?.close();
  await stopBrowser(browser);
}
