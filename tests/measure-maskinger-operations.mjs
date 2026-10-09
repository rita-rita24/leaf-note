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
  await waitForReady(client, "!!window.__MaskingerTest", 30000);
  for (const count of [100, 1000])
    for (let trial = 0; trial < 5; trial++) {
      const row = await evaluate(
        client,
        `(async()=>{
 const api=window.__MaskingerTest;api.clear();const frame=()=>new Promise(r=>requestAnimationFrame(r));await frame();const source=document.querySelector('#source-input'),masked=document.querySelector('#masked-output'),restore=document.querySelector('#restore-input'),restored=document.querySelector('#restore-output'),body=document.querySelector('tbody');
 const text=Array.from({length:${count}},(_,i)=>'user'+i+'@example.com').join('\\n');source.value=text;let start=performance.now();source.dispatchEvent(new Event('input',{bubbles:true}));const firstCpuMs=performance.now()-start;await frame();const firstReadyMs=performance.now()-start;
 const mappingCount=api.mappings().length;if(mappingCount!==${count}||masked.value.includes('@example.com'))throw Error('Incorrect masked result');const firstRow=body.firstElementChild;
 source.value=text+'\\nlatest';start=performance.now();source.dispatchEvent(new Event('input',{bubbles:true}));const repeatCpuMs=performance.now()-start;await frame();const repeatReadyMs=performance.now()-start,reused=body.firstElementChild===firstRow;
 restore.value=masked.value;start=performance.now();restore.dispatchEvent(new Event('input',{bubbles:true}));const restoreCpuMs=performance.now()-start;await frame();const restoreReadyMs=performance.now()-start;if(restored.value!==source.value)throw Error('Incorrect restored result');
 const stored=JSON.parse(sessionStorage.getItem('maskinger.activeMappings.v2'));if(JSON.stringify(stored)!==JSON.stringify(api.mappings()))throw Error('Persisted mappings differ');return {firstCpuMs,firstReadyMs,repeatCpuMs,repeatReadyMs,restoreCpuMs,restoreReadyMs,mappingCount,reused,correct:true};
 })()`,
      );
      assert.equal(row.correct, true);
      rows.push({ count, trial, ...row });
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
              trials: 5,
              data: "100 or 1000 distinct synthetic email mappings; repeated source only adds nonsensitive text",
              endpoint:
                "Input handler CPU and correct result plus next animation frame reported separately; frame readiness proxy, not pixel presentation. sessionStorage contents compared to exact active mappings after input.",
            },
            rows,
          },
          null,
          2,
        ),
      );
    }
  console.log(
    "PASS: 10 mask/restore trials; exact persisted mappings and restoration verified",
  );
} finally {
  client?.close();
  await stopBrowser(browser);
}
