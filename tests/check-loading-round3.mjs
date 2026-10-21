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
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
const [before, after, output] = process.argv.slice(2);
const outputs = [];
for (const root of [before, after]) {
  const b = await launchBrowser();
  try {
    const t = await requestJson(b.port, "/json/new?about:blank", "PUT");
    const c = new CdpClient(t.webSocketDebuggerUrl);
    await c.connect();
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    const file = existsSync(path.join(root, "leaf-note.html"))
      ? "leaf-note.html"
      : "LeafNote.html";
    await c.send("Page.navigate", {
      url: pathToFileURL(path.join(root, file)).href + "?test=1",
    });
    await waitForReady(c, "window.__LeafNoteTest?.isReady()", 30000);
    outputs.push(
      await evaluate(
        c,
        `(()=>{
  const out=[];let seed=12345;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};const values=[undefined,null,'',false,true,0,1,'0','x|y',[],['a'],{a:1}];
  const zeroBlock={type:'text',fileName:'',fileType:'',fileSize:-0,fileDataUrl:''};const zeroChanged=_normalizeBlockTypeSpecificFields(zeroBlock);out.push({negativeZeroPreserved:Object.is(zeroBlock.fileSize,-0),zeroChanged});
  const keys=['url','caption','fileName','fileType','fileSize','fileDataUrl','rows','cols','cells','hasHeaderRow','hasHeaderCol','alignments','label','refTitle','refUrl','columns'];
  const types=BLOCK_TYPES.map(b=>b.type).concat(['unknown','',null]);
  for(let i=0;i<1000;i++){
   const raw={type:types[i%types.length],id:'b'+i,content:i%4?'plain 🌱 body':'<img src=x onerror=alert(1)><b>rich</b>',children:[]};
   for(const key of keys)if(random()>.25)raw[key]=values[Math.floor(random()*values.length)];
   if(i%5===0)raw.children=[{type:'text',id:'c'+i,content:'<script>alert(1)</'+ 'script>child',children:[]}];
   const block=JSON.parse(JSON.stringify(raw));const changed=_normalizeBlockTypeSpecificFields(block);const changedAgain=_normalizeBlockTypeSpecificFields(block);out.push({block,changed,changedAgain});
  }
  const originalRandom=Math.random;let serial=0;Math.random=()=>((++serial)%1000)/1000;const originalNow=Date.now;Date.now=()=>1700000000000;
  try{for(let i=0;i<100;i++){
   serial=0;const raw={documentId:'fixture',workspaceName:'Fixture',rootPages:['p'],currentPageId:'p',pages:{p:{id:'p',title:'Title',children:[],blocks:out.slice(1+i*10,1+i*10+10).map(r=>r.block),createdAt:1,updatedAt:1}},lastModifiedAt:1};
   const normalized=normalizeStateShape(raw);sanitizeStateInPlace(normalized.state);out.push({normalized});
  }}finally{Math.random=originalRandom;Date.now=originalNow}
  return out;
 })()`,
      ),
    );
    c.close();
  } finally {
    await stopBrowser(b);
  }
}
assert.deepEqual(
  outputs[0],
  outputs[1],
  "Defaults, repair flags, sanitization, field presence, nesting, malformed legacy fields must remain identical",
);
await writeFile(
  output,
  JSON.stringify(
    {
      passed: true,
      fieldCases: 1001,
      wholeStateCases: 100,
      preserve: [
        "changed flags",
        "own field presence",
        "JSON output",
        "malformed fields",
        "XSS sanitization",
        "nested child promotion",
      ],
    },
    null,
    2,
  ),
);
console.log("Round 3 normalizer equivalence passed: 1101 cases");
