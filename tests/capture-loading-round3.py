# coding: utf-8
import urllib.request,json,hashlib,sys,datetime,gzip
from pathlib import Path
p=Path('reports/loading-2026-10-09-round3');m=json.loads((p/'manifest.json').read_text());phase=sys.argv[1];folder=p/('baseline' if phase=='before' else 'deployed');folder.mkdir(exist_ok=True);hashes={}
for f in ['index.html','LeafNote.html']:
 with urllib.request.urlopen(m['productionURL']+f,timeout=30) as res:data=res.read();(folder/(f+'.headers')).write_text(str(res.headers))
 h=hashlib.sha256(data).hexdigest();expected=m['sourceBefore'][f] if phase=='before' else hashlib.sha256((Path('/tmp/leaf-note-loading-git')/f).read_bytes()).hexdigest();assert h==expected,(f,h,expected);(folder/f).write_bytes(data);hashes[f]=h
with urllib.request.urlopen(m['productionURL'],timeout=30) as res:root=res.read();(folder/'root.html').write_bytes(root)
assert hashlib.sha256(root).hexdigest()==hashes['index.html']
m[phase+'VerifiedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();m[phase+'Hashes']=hashes
if phase=='after':m['candidate']=hashes;m['gzipBytes']={f:{'before':len(gzip.compress((p/'baseline'/f).read_bytes())),'after':len(gzip.compress((folder/f).read_bytes()))} for f in hashes}
(p/'manifest.json').write_text(json.dumps(m,ensure_ascii=False,indent=2));print(phase,'all 3 production hashes and root alias match')
