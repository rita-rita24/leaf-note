import { mkdir, writeFile } from "node:fs/promises";
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
const [oldApp, newApp, oldMask, newMask, output] = process.argv.slice(2);
await mkdir(output, { recursive: true });
const browser = await launchBrowser();
let client;
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
  for (const width of [320, 768, 1280])
    for (const dark of [false, true])
      for (const [kind, source] of [
        ["before", oldApp],
        ["after", newApp],
      ]) {
        await client.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await client.send("Page.navigate", {
          url: pathToFileURL(resolve(source)).href + "?test=1",
        });
        await waitForReady(client, "window.__LeafNoteTest?.isReady()", 30000);
        await evaluate(
          client,
          `(async()=>{const draft=createInitialState();draft.darkMode=${dark};draft.pages[draft.currentPageId].title='Selection appearance';draft.pages[draft.currentPageId].blocks=Array.from({length:20},(_,i)=>blk('text','Identical block '+i+' with wrapping content'));window.__LeafNoteTest.setState(draft);applyTheme();applyThemeCustom();renderAll();getCurrentPage().blocks.slice(0,5).forEach(block=>BlockSelection.selectBlock(block.id));await document.fonts.ready;await new Promise(r=>setTimeout(r,350))})()`,
        );
        const { data } = await client.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        await writeFile(
          resolve(
            output,
            `app-${width}-${dark ? "dark" : "light"}-${kind}.png`,
          ),
          Buffer.from(data, "base64"),
        );
      }
  for (const width of [320, 768, 1280])
    for (const [kind, source] of [
      ["before", oldMask],
      ["after", newMask],
    ]) {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await client.send("Page.navigate", {
        url: pathToFileURL(resolve(source)).href + "?test=1",
      });
      await waitForReady(client, "!!window.__MaskingerTest", 30000);
      await evaluate(
        client,
        `(async()=>{window.__MaskingerTest.clear();const input=document.querySelector('#source-input');input.value=Array.from({length:1000},(_,i)=>'user'+i+'@example.com').join('\\n');input.dispatchEvent(new Event('input',{bubbles:true}));await document.fonts.ready;await new Promise(r=>setTimeout(r,350))})()`,
      );
      const { data } = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      await writeFile(
        resolve(output, `mask-${width}-${kind}.png`),
        Buffer.from(data, "base64"),
      );
    }
  console.log("Saved 9 before/after appearance pairs");
} finally {
  client?.close();
  await stopBrowser(browser);
}
