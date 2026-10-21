import assert from "node:assert/strict";
import http from "node:http";
import { readFile, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  launchBrowser,
  stopBrowser,
  CdpClient,
  requestJson,
  evaluate,
  waitForReady,
} from "./loading-cdp.mjs";
const appPath = "/tmp/leaf-note-loading-release/LeafNote.html",
  source = await readFile(appPath, "utf8");
let revision = 1;
const requests = [];
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "max-age=600");
  res.setHeader("Content-Type", "text/html");
  const etag = '"revision-' + revision + '"';
  res.setHeader("ETag", etag);
  const status = req.headers["if-none-match"] === etag ? 304 : 200;
  requests.push({
    revision,
    status,
    validator: req.headers["if-none-match"] || null,
  });
  res.writeHead(status);
  res.end(
    status === 304 ? "" : source + "\n<!--source revision " + revision + "-->",
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await launchBrowser();
try {
  const t = await requestJson(browser.port, "/json/new?about:blank", "PUT"),
    c = new CdpClient(t.webSocketDebuggerUrl);
  await c.connect();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Network.enable");
  await c.send("Network.setCacheDisabled", { cacheDisabled: false });
  await c.send("Page.navigate", {
    url: pathToFileURL(appPath).href + "?test=1",
  });
  await waitForReady(c, "window.__LeafNoteTest?.isReady()");
  const url = `http://127.0.0.1:${server.address().port}/LeafNote.html`;
  const fetchSource = () =>
    evaluate(c, `fetchSelfHtmlForExport(${JSON.stringify(url)})`);
  assert.ok((await fetchSource()).endsWith("<!--source revision 1-->"));
  assert.ok((await fetchSource()).endsWith("<!--source revision 1-->"));
  assert.equal(requests.at(-1).status, 304);
  revision = 2;
  assert.ok((await fetchSource()).endsWith("<!--source revision 2-->"));
  assert.equal(requests.at(-1).status, 200);
  const search = await evaluate(
    c,
    `(async()=>{openSearchModal();const small=_canRenderSearchImmediately();searchInput.value='unique no result';searchInput.dispatchEvent(new Event('input',{bubbles:true}));const immediate=_searchRenderTimer===null;
 const page=getCurrentPage();page.blocks=Array.from({length:100},(_,i)=>blk('text','body '+i));const large=!_canRenderSearchImmediately();
 searchInput.value='body 1';searchInput.dispatchEvent(new Event('input',{bubbles:true}));searchInput.value='body 99';searchInput.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,50));
 return {small,immediate,large,latest:document.getElementById('search-results').textContent.includes('body 99')};})()`,
  );
  assert.deepEqual(search, {
    small: true,
    immediate: true,
    large: true,
    latest: true,
  });
  await writeFile(
    "reports/loading-2026-10-09/freshness-check.json",
    JSON.stringify({ passed: true, requests, search }, null, 2),
  );
  console.log(
    "Freshness revalidation, changed source and adaptive search checks passed",
  );
  c.close();
} finally {
  await stopBrowser(browser);
  await rm(browser.userDataDir, { recursive: true, force: true });
  await new Promise((r) => server.close(r));
}
