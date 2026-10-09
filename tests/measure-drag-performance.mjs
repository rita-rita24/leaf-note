import {launchBrowser,stopBrowser,CdpClient,requestJson,evaluate,waitForReady} from './loading-cdp.mjs';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
const [before,after,output]=process.argv.slice(2);
const browser=await launchBrowser();const rows=[];
try {
 const target=await requestJson(browser.port,'/json/new?about:blank','PUT');const c=new CdpClient(target.webSocketDebuggerUrl);await c.connect();await c.send('Page.enable');await c.send('Runtime.enable');
 await c.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await c.send('Emulation.setCPUThrottlingRate',{rate:4});
 for(let pair=0;pair<5;pair++)for(const kind of before===after?['before']:(pair%2?['after','before']:['before','after'])) {
  const source=kind==='before'?before:after;
  await c.send('Page.navigate',{url:source.startsWith('http')?source+'?test=1':pathToFileURL(source).href+'?test=1'});await waitForReady(c,'window.__LeafNoteTest?.isReady()',30000);
  for(const count of [100,1000]) {
   const sample=await evaluate(c,`(async()=>{
    const draft=createInitialState();draft.pages[draft.currentPageId].blocks=Array.from({length:${count}},(_,i)=>blk('text','Block '+i));__LeafNoteTest.setState(draft);renderAll();await document.fonts.ready;await new Promise(r=>requestAnimationFrame(r));
    const scroll=document.querySelector('#editor-scroll');scroll.scrollTop=0;BlockSelection.clear();const rect=scroll.getBoundingClientRect();const blocks=document.querySelectorAll('#blocks>.block');const first=blocks[0].getBoundingClientRect();const last=blocks[9].getBoundingClientRect();const x=first.right+8,y=first.top+2;
    let reads=0;const original=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){reads++;return original.call(this)};
    scroll.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y}));const start=performance.now();
    for(let i=0;i<60;i++)window.dispatchEvent(new MouseEvent('mousemove',{clientX:first.left+30,clientY:last.bottom-2,buttons:1}));
    window.dispatchEvent(new MouseEvent('mouseup',{button:0}));const handler=performance.now()-start;await new Promise(r=>requestAnimationFrame(r));const ready=performance.now()-start;Element.prototype.getBoundingClientRect=original;
    const ids=BlockSelection.getSelectedIds();const expected=getCurrentPage().blocks.slice(0,10).map(b=>b.id);if(JSON.stringify(ids)!==JSON.stringify(expected))throw Error('Selection differs: '+ids.length);BlockSelection.clear();
    const source=document.querySelector('#blocks>.block'),handle=source.querySelector('.block-drag'),target=document.querySelectorAll('#blocks>.block')[9];const data=new DataTransfer();handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));const r=target.getBoundingClientRect(), moveStart=performance.now();target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientY:r.bottom-1}));handle.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}));await new Promise(r=>requestAnimationFrame(r));const moveReady=performance.now()-moveStart;
    if(getCurrentPage().blocks[9].id!==expected[0]||document.querySelectorAll('#blocks>.block')[9].dataset.id!==expected[0])throw Error('Move differs');return {handler,ready,reads,selected:ids.length,moveReady,reused:source.isConnected};
   })()`);
   rows.push({pair,kind,count,...sample});console.log(kind,count,sample);await writeFile(output,JSON.stringify({date:new Date().toISOString(),conditions:{cpu:4,viewport:'1280x800',events:'60 mousemove events in one task, final mouseup flush, end: correct 10 selected blocks and next animation frame; synthetic burst, not a native drag latency estimate'},rows},null,2));
  }
 }
 c.close();
}finally{await stopBrowser(browser)}
process.exit(0);
