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
const rows = [],
  events = [];
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
  client.ws.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.method === "Tracing.dataCollected")
      events.push(...event.params.value);
  });
  await client.send("Tracing.start", {
    categories:
      "devtools.timeline,blink.user_timing,input,latencyInfo,cc,viz,benchmark,disabled-by-default-devtools.timeline.frame",
    transferMode: "ReportEvents",
  });
  for (let trial = 0; trial < 5; trial++) {
    await evaluate(
      client,
      `(async()=>{
      const draft=createInitialState();draft.pages[draft.currentPageId].blocks=Array.from({length:1000},(_,i)=>blk('text','Native history '+i));__LeafNoteTest.setState(draft);
      for(let i=0;i<10;i++){getCurrentPage().blocks[0].content='revision '+i;_pushUndoStackSnapshot(JSON.stringify(state));}
      if(undoStack.length!==10)throw Error('History fixture differs');getCurrentPage().blocks[0].content='revision 10';renderAll();
      await document.fonts.ready;await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>requestAnimationFrame(r));
      const text=document.querySelector('#blocks .block-content');text.focus();placeCaret(text,'end');performance.mark('history-start-${trial}');
    })()`,
    );
    for (const direction of ["undo", "redo"])
      for (let step = 0; step < 10; step++) {
        const expected = direction === "undo" ? 9 - step : step + 1;
        const start = performance.now();
        const modifiers = direction === "undo" ? 2 : 10;
        await client.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "z",
          code: "KeyZ",
          modifiers,
        });
        await client.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "z",
          code: "KeyZ",
          modifiers,
        });
        const handlerAndDispatchMs = performance.now() - start;
        const correct = await evaluate(
          client,
          `(async()=>{await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>requestAnimationFrame(r));const content=document.querySelector('#blocks .block-content');return getCurrentPage().blocks[0].content==='revision ${expected}'&&content.textContent==='revision ${expected}'&&document.activeElement===content})()`,
        );
        assert.equal(correct, true);
        rows.push({
          trial,
          direction,
          step,
          handlerAndDispatchMs,
          correctResultAndFrameProxyMs: performance.now() - start,
          correct,
        });
      }
    const persisted = await evaluate(
      client,
      `(async()=>{performance.mark('history-end-${trial}');clearTimeout(_saveTimer);_saveTimer=null;let saved=false;for(let i=0;i<100&&!saved;i++){saved=await _doSave({force:true});if(!saved)await new Promise(r=>setTimeout(r,10));}const loaded=await loadStateAsync();return saved&&JSON.stringify(loaded.pages[state.currentPageId].blocks)===JSON.stringify(getCurrentPage().blocks)})()`,
    );
    assert.equal(persisted, true);
  }
  const complete = new Promise((resolve) => {
    const listener = ({ data }) => {
      if (JSON.parse(data).method === "Tracing.tracingComplete") {
        client.ws.removeEventListener("message", listener);
        resolve();
      }
    };
    client.ws.addEventListener("message", listener);
  });
  await client.send("Tracing.end");
  await complete;
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
          blocks: 1000,
          trials: 5,
          nativeKeysPerTrial: 20,
          input:
            "10 native Ctrl+Z then 10 native Ctrl+Shift+Z; sequential dispatch and correct DOM/model/focus plus two rAF. Dispatch includes CDP overhead; rAF is a proxy. EventLatency/presentation trace kept separately. Fresh synthetic history each trial; state storage read back after each trial.",
        },
        rows,
        traceEvents: events,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: 100 native undo/redo keys, matching model/DOM/focus and 5 persistence readbacks",
  );
} finally {
  client?.close();
  await stopBrowser(browser);
}
