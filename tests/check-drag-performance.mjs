import assert from "node:assert/strict";
import {
  launchBrowser,
  stopBrowser,
  CdpClient,
  requestJson,
  evaluate,
  waitForReady,
} from "./loading-cdp.mjs";
import { pathToFileURL } from "node:url";
const browser = await launchBrowser();
try {
  const t = await requestJson(browser.port, "/json/new?about:blank", "PUT"),
    c = new CdpClient(t.webSocketDebuggerUrl);
  await c.connect();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  const source = process.argv[2];
  await c.send("Page.navigate", {
    url:
      (source.startsWith("http") ? source : pathToFileURL(source).href) +
      "?test=1",
  });
  await waitForReady(c, "window.__LeafNoteTest?.isReady()", 30000);
  const result = await evaluate(
    c,
    `(()=>{
 const optimized=typeof moveBlockWithRender==='function'; const move=optimized?moveBlockWithRender:(sid,tid,pos)=>{const ok=moveBlock(sid,tid,pos);if(ok)renderEditor();return ok}; const rows=[];
 for(const toc of [false,true])for(const nested of [false,true])for(const pos of ['before','after']) {
 const draft=createInitialState(),a=blk('numbered','A'),b=blk('numbered','B'),child=blk('text','child'),parent=blk('toggle','parent',{expanded:true,children:[child]});draft.pages[draft.currentPageId].blocks=[a,b,parent,...(toc?[blk('toc','')]:[])];__LeafNoteTest.setState(draft);renderAll();
 const el=qs(blockSelectorById(a.id));const target=nested?child:b;
 const success=move(a.id,target.id,pos);
 const list=nested?findBlockAndList(child.id).list:getCurrentPage().blocks;const index=list.findIndex(x=>x.id===target.id),moved=list.findIndex(x=>x.id===a.id);
 const dom=qs(blockSelectorById(a.id)),targetDom=qs(blockSelectorById(target.id));const domCorrect=pos==='before'?dom.nextElementSibling===targetDom:targetDom.nextElementSibling===dom;
 rows.push({success,order:moved===index+(pos==='before'?-1:1),domCorrect,reused:dom===el,expectedReuse:optimized&&!toc&&!nested,numbering:!!dom});
 }
 const p=getCurrentPage().blocks.find(b=>b.type==='toggle');const child=p.children[0];const snapshot=JSON.stringify(state);const rejected=!move(p.id,child.id,'after')&&snapshot===JSON.stringify(state);
 return {rows,rejected};})()`,
  );
  for (const row of result.rows) {
    assert.equal(row.success, true);
    assert.equal(row.order, true);
    assert.equal(row.domCorrect, true);
    assert.equal(row.reused, row.expectedReuse);
  }
  assert.equal(result.rejected, true);
  const points = await evaluate(
    c,
    `(async()=>{const draft=createInitialState();draft.pages[draft.currentPageId].blocks=Array.from({length:20},(_,i)=>blk('text','native '+i));__LeafNoteTest.setState(draft);renderAll();document.querySelector('#editor-scroll').scrollTop=0;await document.fonts.ready;await new Promise(r=>requestAnimationFrame(r));const b=document.querySelectorAll('#blocks>.block'),a=b[0].getBoundingClientRect(),z=b[4].getBoundingClientRect();return {x:a.right+8,y:a.top+2,endX:a.left+30,endY:z.bottom-2,expected:getCurrentPage().blocks.slice(0,5).map(b=>b.id)}})()`,
  );
  for (const [type, x, y, buttons] of [
    ["mouseMoved", points.x, points.y, 0],
    ["mousePressed", points.x, points.y, 1],
    ["mouseMoved", points.endX, points.endY, 1],
    ["mouseReleased", points.endX, points.endY, 0],
  ])
    await c.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      buttons,
      ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }),
    });
  assert.deepEqual(
    await evaluate(c, "BlockSelection.getSelectedIds()"),
    points.expected,
  );
  console.log("PASS: native mouse drag selects the expected 5 blocks");
  console.log("PASS: 8 same-list/nested/TOC/order cases + ancestor rejection");
  c.close();
} finally {
  await stopBrowser(browser);
}
process.exit(0);
