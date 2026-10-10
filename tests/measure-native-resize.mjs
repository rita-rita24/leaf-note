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
const owned = await launchBrowser();
let client;
const rows = [],
  events = [];
try {
  const target = await requestJson(owned.port, "/json/new?about:blank", "PUT");
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
    const e = JSON.parse(data);
    if (e.method === "Tracing.dataCollected") events.push(...e.params.value);
  });
  await client.send("Tracing.start", {
    categories:
      "devtools.timeline,blink.user_timing,input,latencyInfo,cc,viz,benchmark,disabled-by-default-devtools.timeline.frame",
    transferMode: "ReportEvents",
  });
  for (const count of [100, 1000])
    for (let trial = 0; trial < 5; trial++) {
      const point = await evaluate(
        client,
        `(async()=>{const draft=createInitialState();draft.pages[draft.currentPageId].blocks=Array.from({length:${count}},(_,i)=>blk('text','Native resize '+i));__LeafNoteTest.setState(draft);setSidebarCollapsed(false);applySidebarWidth(260);renderAll();await document.fonts.ready;await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>requestAnimationFrame(r));const r=document.querySelector('#sidebar-resizer').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,width:document.querySelector('#sidebar').getBoundingClientRect().width}})()`,
      );
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        buttons: 0,
      });
      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        buttons: 1,
        button: "left",
        clickCount: 1,
      });
      await evaluate(
        client,
        `performance.mark('resize-start-${count}-${trial}')`,
      );
      for (let step = 0; step < 30; step++) {
        const x = point.x + (step + 1) * 2,
          start = performance.now();
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y: point.y,
          buttons: 1,
        });
        const dispatchMs = performance.now() - start;
        const expected = Math.round(point.width + (step + 1) * 2);
        const result = await evaluate(
          client,
          `(async()=>{await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>requestAnimationFrame(r));const width=parseInt(document.documentElement.style.getPropertyValue('--sidebar-width'),10);return {width,active:document.querySelector('#sidebar').classList.contains('resizing')}})()`,
        );
        assert.equal(result.width, expected);
        assert.equal(result.active, true);
        rows.push({
          count,
          trial,
          step,
          dispatchMs,
          correctFrameProxyMs: performance.now() - start,
          expected,
          ...result,
        });
      }
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x + 60,
        y: point.y,
        buttons: 0,
        button: "left",
        clickCount: 1,
      });
      const saved = await evaluate(
        client,
        `(()=>{performance.mark('resize-end-${count}-${trial}');return {width:parseInt(document.documentElement.style.getPropertyValue('--sidebar-width'),10),saved:localStorage.getItem(SIDEBAR_WIDTH_KEY),active:document.querySelector('#sidebar').classList.contains('resizing')}})()`,
      );
      assert.equal(saved.saved, String(saved.width));
      assert.equal(saved.active, false);
    }
  const complete = new Promise((resolve) => {
    const onMessage = ({ data }) => {
      if (JSON.parse(data).method === "Tracing.tracingComplete") {
        client.ws.removeEventListener("message", onMessage);
        resolve();
      }
    };
    client.ws.addEventListener("message", onMessage);
  });
  await client.send("Tracing.end");
  await complete;
  await writeFile(
    output,
    JSON.stringify(
      {
        source,
        date: new Date().toISOString(),
        browser: (await requestJson(owned.port, "/json/version")).Browser,
        conditions: {
          cpu: 4,
          viewport: "1280x800",
          trialsPerCount: 5,
          movesPerTrial: 30,
          counts: [100, 1000],
          input:
            "Native CDP mouse, self-paced after two rAF and exact CSS width; not fixed Hz or physical pointer",
          persistence: "Each mouseup checked against localStorage readback",
          limits:
            "CDP dispatch and DOM/frame proxy not physical presentation/INP; raw compositor trace retained",
        },
        rows,
        traceEvents: events,
      },
      null,
      2,
    ),
  );
  console.log("PASS", rows.length, "native moves and 10 final width readbacks");
} finally {
  client?.close();
  await stopBrowser(owned);
}
