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
      const sample = await evaluate(
        client,
        `(async () => {
      const draft=createInitialState(); draft.pages[draft.currentPageId].blocks=Array.from({length:${count}},(_,i)=>blk('text','Selection benchmark '+i)); window.__LeafNoteTest.setState(draft);renderAll();await document.fonts.ready;
      const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));await frame();await frame();
      const scroll=document.querySelector('#editor-scroll');scroll.scrollTop=0;
      const blocks=document.querySelectorAll('#blocks>.block'),first=blocks[0].getBoundingClientRect(),last=blocks[4].getBoundingClientRect();
      const original=Element.prototype.getBoundingClientRect;let reads=0;Element.prototype.getBoundingClientRect=function(){reads++;return original.call(this)};
      const times=[];let correct=false;const started=performance.now();
      try {
        scroll.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,clientX:first.right+8,clientY:first.top+2}));
        for(let move=0;move<30;move++) {
          await frame();const start=performance.now();window.dispatchEvent(new MouseEvent('mousemove',{clientX:first.left+30,clientY:last.bottom-2,buttons:1}));await frame();times.push(performance.now()-start);
        }
        window.dispatchEvent(new MouseEvent('mouseup',{button:0}));await frame();
        correct=JSON.stringify(BlockSelection.getSelectedIds())===JSON.stringify(getCurrentPage().blocks.slice(0,5).map(block=>block.id));
        return {reads,frameReadyMs:times,totalMs:performance.now()-started,correct};
      } finally {Element.prototype.getBoundingClientRect=original;window.dispatchEvent(new MouseEvent('mouseup',{button:0}));BlockSelection.clear();}
    })()`,
      );
      assert.equal(sample.correct, true);
      rows.push({ count, trial, ...sample });
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
              trials: 5,
              moves: 30,
              endpoint:
                "Mouse event dispatch to next animation frame after selection callback; frame readiness proxy, not presented pixels. Each move starts on a separate frame. Correct final five-block selection required.",
            },
            rows,
          },
          null,
          2,
        ),
      );
    }
  console.log(
    "PASS: 10 selection trials, 300 frame-separated moves, correct final selections",
  );
} finally {
  client?.close();
  await stopBrowser(browser);
}
