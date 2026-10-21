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
  await client.send("HeapProfiler.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.send("Page.navigate", {
    url:
      (source.startsWith("http") ? source : pathToFileURL(source).href) +
      "?test=1",
  });
  await waitForReady(client, "window.__LeafNoteTest?.isReady()", 30000);
  const settle = () =>
    evaluate(
      client,
      `(async()=>{clearTimeout(_saveTimer);_saveTimer=null;let saved=false;for(let i=0;i<100&&!saved;i++){saved=await _doSave({force:true});if(!saved)await new Promise(r=>setTimeout(r,10))}if(!saved)throw Error('Could not settle persistence');await new Promise(r=>setTimeout(r,500))})()`,
    );
  for (let trial = 0; trial < 5; trial++) {
    await evaluate(
      client,
      `(async()=>{document.activeElement?.blur();const draft=createInitialState();draft.pages[draft.currentPageId].blocks=Array.from({length:1000},(_,i)=>blk('text','Retention block '+i));__LeafNoteTest.setState(draft);renderAll({forceEditableSync:true});await document.fonts.ready;await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>requestAnimationFrame(r))})()`,
    );
    await settle();
    await client.send("HeapProfiler.collectGarbage");
    const before = {
      heap: await client.send("Runtime.getHeapUsage"),
      dom: await client.send("Memory.getDOMCounters"),
    };
    const correct = await evaluate(
      client,
      `(async()=>{for(let cycle=0;cycle<10;cycle++){const el=document.querySelector('#blocks .block-content');el.focus();el.innerHTML='Retention edit '+cycle;el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Retention edit '+cycle}));undo();redo();undo();if(getCurrentPage().blocks[0].content!=='Retention block 0'||document.querySelector('#blocks .block-content').textContent!=='Retention block 0'||getCurrentPage().blocks.length!==1000)throw Error('History result differs');clearTimeout(_saveTimer);_saveTimer=null;await new Promise(r=>requestAnimationFrame(r))}return true})()`,
    );
    assert.equal(correct, true);
    await settle();
    await client.send("HeapProfiler.collectGarbage");
    const after = {
      heap: await client.send("Runtime.getHeapUsage"),
      dom: await client.send("Memory.getDOMCounters"),
    };
    const history = await evaluate(
      client,
      `({undoCount:undoStack.length,redoCount:redoStack.length,undoBytes:undoStackBytes,redoBytes:redoStackBytes,pendingChars:_pendingSnapshot?.length||0})`,
    );
    await evaluate(
      client,
      `(()=>{_clearUndoStack();_clearRedoStack();clearTimeout(_undoTimer);_undoTimer=null;_pendingSnapshot=null})()`,
    );
    await client.send("HeapProfiler.collectGarbage");
    const afterHistoryClear = {
      heap: await client.send("Runtime.getHeapUsage"),
      dom: await client.send("Memory.getDOMCounters"),
    };
    rows.push({ trial, before, after, afterHistoryClear, history, correct });
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        source,
        dateUTC: new Date().toISOString(),
        browser: await client.send("Browser.getVersion"),
        conditions: {
          viewport: "1280x800",
          cpu: "no throttling",
          trials: 5,
          blocks: 1000,
          cyclesPerTrial: 10,
          quiescence:
            "forced persistence completes, then 500ms before heap/DOM sampling",
          cycle:
            "DOM input, undo, redo, undo; correct model/DOM/block count; forced GC before and after",
          limitations:
            "Retained heap/DOM counters after forced GC, not peak memory, resident set, natural GC or all-operation lifetime. Local preserved release bytes for comparable environment; no production timing rate.",
        },
        rows,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: 5 × 10 history cycles; retained heap and DOM counters recorded",
  );
} finally {
  client?.close();
  await stopBrowser(browser);
}
