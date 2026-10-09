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
const events = [],
  rows = [];
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
    const message = JSON.parse(data);
    if (message.method === "Tracing.dataCollected")
      events.push(...message.params.value);
  });
  await client.send("Tracing.start", {
    categories:
      "devtools.timeline,blink.user_timing,input,latencyInfo,cc,viz,benchmark,disabled-by-default-devtools.timeline.frame",
    transferMode: "ReportEvents",
  });
  for (let trial = 0; trial < 5; trial++) {
    const points = await evaluate(
      client,
      `(async()=>{
      const draft=__LeafNoteTest.createInitialState();draft.pages[draft.currentPageId].blocks=Array.from({length:1000},(_,i)=>blk('text','Native drag '+i));__LeafNoteTest.setState(draft);renderAll();
      await document.fonts.ready;await new Promise(r=>requestAnimationFrame(r));document.querySelector('#editor-scroll').scrollTop=0;
      const blocks=document.querySelectorAll('#blocks>.block'),a=blocks[0].getBoundingClientRect(),z=blocks[4].getBoundingClientRect();
      performance.mark('drag-start-${trial}');return{x:a.right+8,y:a.top+2,endX:a.left+30,endY:z.bottom-2,expected:getCurrentPage().blocks.slice(0,5).map(b=>b.id)};
    })()`,
    );
    const timestamps = [],
      started = performance.now();
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: points.x,
      y: points.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (let input = 1; input <= 60; input++) {
      const deadline = started + input * 16.7,
        remaining = deadline - performance.now();
      if (remaining > 0)
        await new Promise((resolve) => setTimeout(resolve, remaining));
      timestamps.push(performance.now() - started);
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: points.x + ((points.endX - points.x) * input) / 60,
        y: points.y + ((points.endY - points.y) * input) / 60,
        buttons: 1,
      });
    }
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: points.endX,
      y: points.endY,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await evaluate(
      client,
      `new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>{performance.mark('drag-end-${trial}');r()})))`,
    );
    assert.deepEqual(
      await evaluate(client, "BlockSelection.getSelectedIds()"),
      points.expected,
    );
    rows.push({ trial, inputs: 60, dispatchTimes: timestamps, correct: true });
  }
  const done = client.waitForEvent("Tracing.tracingComplete", 30000);
  await client.send("Tracing.end");
  await done;
  for (const row of rows) {
    const start = events.find((e) => e.name === "drag-start-" + row.trial)?.ts,
      end = events.find((e) => e.name === "drag-end-" + row.trial)?.ts;
    const paints = events.filter(
      (e) => e.name === "Paint" && e.ts >= start && e.ts <= end,
    );
    row.paintEvents = paints.length;
    row.paintIntervalsMs = paints
      .slice(1)
      .map((event, index) => (event.ts - paints[index].ts) / 1000);
    row.paintDurationMs = paints.map((event) => (event.dur || 0) / 1000);
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        source,
        browser: await requestJson(browser.port, "/json/version"),
        conditions: {
          viewport: "1280x800",
          cpu: 4,
          blocks: 1000,
          trials: 5,
          input:
            "Native CDP mouse events, 60 moves with target deadlines 16.7ms apart; actual dispatch times retained. Slow processing can miss deadlines.",
          paint:
            "Actual DevTools Paint records during marked drag intervals; Paint is paint work, not compositor presentation or input-to-display latency. All page paint events included; separate layers may produce zero intervals.",
        },
        rows,
        traceEvents: events,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: 5 native drag trials, 300 move inputs, correct final selection; Paint traces recorded",
  );
} finally {
  client?.close();
  await stopBrowser(browser);
}
