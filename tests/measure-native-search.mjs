import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
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
      (source.startsWith("http")
        ? source
        : pathToFileURL(resolve(source)).href) + "?test=1",
  });
  await waitForReady(client, "window.__LeafNoteTest?.isReady()", 30000);
  await evaluate(
    client,
    `(() => {
    const api = window.__LeafNoteTest, draft = createInitialState(), prototype = draft.pages[draft.currentPageId];
    for (let i=0;i<200;i++) { const id='search-fixture-'+i; draft.pages[id]={...prototype,id,title:'Navigation fixture '+i,children:[],blocks:[blk('text','Content '+i)]}; }
    api.setState(draft); renderAll(); openSearchModal(); searchInput.value='Navigation fixture'; renderSearchResults(searchInput.value); searchInput.focus();
    window.__searchSamples=[];
    let start;
    searchInput.addEventListener('keydown', e => {if(e.key==='ArrowDown')start=performance.now();},true);
    searchInput.addEventListener('keydown', e => {if(e.key==='ArrowDown')window.__searchSamples.push({handlerMs:performance.now()-start,trusted:e.isTrusted,index:searchSelectedIdx});});
  })()`,
  );
  for (let trial = 0; trial < 5; trial++) {
    await evaluate(
      client,
      "renderSearchResults(searchInput.value); searchInput.focus(); window.__searchSamples=[]",
    );
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "ArrowDown",
        code: "ArrowDown",
        windowsVirtualKeyCode: 40,
        nativeVirtualKeyCode: 40,
      });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "ArrowDown",
        code: "ArrowDown",
        windowsVirtualKeyCode: 40,
        nativeVirtualKeyCode: 40,
      });
      await evaluate(
        client,
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    }
    const wallMs = performance.now() - start;
    const result = await evaluate(
      client,
      `({samples:window.__searchSamples,candidates:searchItems.length,index:searchSelectedIdx,selected:[...searchResults.querySelectorAll('.search-item.selected')].map(el=>searchItems.indexOf(el))})`,
    );
    assert.equal(result.samples.length, 100);
    assert.ok(result.samples.every((row) => row.trusted));
    assert.equal(result.index, 100 % result.candidates);
    assert.deepEqual(result.selected, [result.index]);
    rows.push({ trial, wallMs, ...result });
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
            inputsPerTrial: 100,
            fixturePages: 200,
            endpoint:
              "Trusted Chrome DevTools keyboard events. Handler event-listener CPU measurements; each input followed by two requestAnimationFrame callbacks. Wall time includes protocol and deliberate frame pacing; neither metric is presented pixels, physical FPS or INP.",
          },
          rows,
        },
        null,
        2,
      ),
    );
  }
  console.log(
    "PASS 500 trusted search keys, final selected index/DOM match",
    source,
  );
} finally {
  client?.close();
  await stopBrowser(browser);
}
