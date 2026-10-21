# coding: utf-8
import json,statistics,html
from pathlib import Path
p=Path('reports/loading-2026-10-09-round3')
def read(n):return json.loads((p/n).read_text())
def samples(suffix):
 out=[s for s in read('production-'+suffix+'.json')['samples'] if s['screen']!='index']
 for n in ['production-index-visual-'+suffix+'.json','production-backup-'+suffix+'.json','production-additional-'+suffix+'.json']:
  if (p/n).exists():out+=read(n)['samples']
 return out
def groups(data):
 out={}
 for s in data:out.setdefault((s['screen'],s.get('operation',s['screen']),s['data'],s['cache']),[]).append(s)
 return out
def stats(rows,k):
 vals=[s[k] for s in rows if isinstance(s.get(k),(int,float))]
 return {'median':statistics.median(vals),'n':len(vals),'min':min(vals),'max':max(vals),'raw':vals} if vals else None
names={'index':'配布ページ','app':'ノート起動','note-switch':'ノート切替','search-open':'検索画面','search-results':'本文検索結果','settings':'設定','trash':'ごみ箱','help':'ヘルプ','backup-dialog':'HTML保存確認','backup-result':'HTMLバックアップ'}
bg=groups(samples('before'));ag=groups(samples('after'));rows=[]
for key in dict.fromkeys([*bg,*ag]):
 screen,op,data,cache=key
 for k in ['content','interactive']:
  b=stats(bg.get(key,[]),k);a=stats(ag.get(key,[]),k);rate=(b['median']-a['median'])/b['median']*100 if b and a and b['median'] else None;v='改善未確認'
  if b and a:
   if a['max']<b['min'] and abs(a['median']-b['median'])>=16.7:v='改善'
   elif b['max']<a['min'] and abs(a['median']-b['median'])>=16.7:v='悪化'
  else:v='未計測'
  cond=('初回相当・HTTPキャッシュ無効' if cache=='cold' else '再読み込み／操作・HTTPキャッシュあり')+'・'+('100ノート×100ブロック' if data=='100-notes-100-blocks' else '配布ページ' if screen=='index' else '既定1ノート11ブロック')
  metric='操作可能' if k=='interactive' else '結果がそろう' if screen in ['search-results','backup-result'] else '主要内容の表示'
  url='https://rita-rita24.github.io/leaf-note/'+('index.html' if screen=='index' else 'LeafNote.html')
  rows.append({'screen':names[screen],'url':url,'condition':cond,'metric':metric,'before':b,'after':a,'reductionPercent':rate,'verdict':v})
for name,url,cond in [('配布ページ','index.html','実機モバイル・Safari/Firefox'),('ノート','LeafNote.html','実機モバイル・Safari/Firefox'),('ノート','LeafNote.html','最大容量・画像/添付多量'),('ノート','LeafNote.html','別タブで保存権なし'),('インポート','LeafNote.html','OSファイル選択時間'),('単体HTML','LeafNote.html','既定・メディア多量・最大容量')]:
 for metric in ['主要内容の表示','操作可能']:rows.append({'screen':name,'url':'https://rita-rita24.github.io/leaf-note/'+url,'condition':cond,'metric':metric,'before':None,'after':None,'reductionPercent':None,'verdict':'未計測（代表条件外）'})
for metric in ['主要内容の表示','操作可能']:
 rows.append({'screen':'別開発中leaf-note.html','url':'/Users/arita-ritsuki/Documents/ドキュメント/個人開発/leaf-note/leaf-note.html','condition':'本番未反映・同値確認のみ（既存の未コミット開発はリリースから除外）','metric':metric,'before':None,'after':None,'reductionPercent':None,'verdict':'未計測（別開発版）'})
(p/'results.json').write_text(json.dumps({'rows':rows,'formula':'(before-after)/before*100'},ensure_ascii=False,indent=2))
def esc(x):return html.escape(str(x))
def fmt(s):return f"{s['median']:.1f}" if s else '未計測'
def tr(r):
 b,a=r['before'],r['after'];spread='前 '+(f"{b['min']:.1f}–{b['max']:.1f}" if b else '未計測')+' / 後 '+(f"{a['min']:.1f}–{a['max']:.1f}" if a else '未計測')+' ms'
 vals=[f"<a href='{r['url']}'>{esc(r['screen'])}</a>",esc(r['condition']),r['metric'],fmt(b),fmt(a),f"{r['reductionPercent']:.1f}%" if r['reductionPercent'] is not None else '算出不可',f"{b['n'] if b else 0}／{a['n'] if a else 0}",r['verdict']+'<br><small>'+spread+'</small>']
 return '<tr>'+''.join('<td>'+v+'</td>' for v in vals)+'</tr>'
m=read('manifest.json');paired=read('minified-paired-offline.json');pr=[]
for k,label in [('content','主要内容の表示'),('interactive','操作可能'),('switch','ノート切替')]:
 b=stats([s for s in paired['samples'] if s['kind']=='before'],k);a=stats([s for s in paired['samples'] if s['kind']=='after'],k);diff=[next(s[k] for s in paired['samples'] if s['kind']=='before' and s['pair']==i)-next(s[k] for s in paired['samples'] if s['kind']=='after' and s['pair']==i) for i in range(1,11)];pr.append({'metric':label,'before':b,'after':a,'rate':(b['median']-a['median'])/b['median']*100,'improvedPairs':sum(v>0 for v in diff),'pairDifferences':diff})
(p/'paired-results.json').write_text(json.dumps(pr,ensure_ascii=False,indent=2));pt='<table><tr><th>単体HTML・100×100</th><th>前中央値 ms</th><th>後中央値 ms</th><th>短縮率</th><th>回数</th><th>判定</th></tr>'+''.join(f"<tr><td>{r['metric']}</td><td>{fmt(r['before'])}</td><td>{fmt(r['after'])}</td><td>{r['rate']:.1f}%</td><td>10／10</td><td>改善未確認（{r['improvedPairs']}/10ペア短縮）</td></tr>" for r in pr)+'</table>'
raw=''.join(f"<li><a href='{f.name}'>{f.name}</a></li>" for f in sorted(p.glob('*.json')))
report='''<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HTML高速化・第3回</title><style>body{font:16px/1.7 system-ui;margin:30px;color:#19302a}h1,h2{line-height:1.4}.table{overflow:auto}table{border-collapse:collapse;font-size:13px;min-width:1200px;width:100%}td,th{border:1px solid #c9d6d0;padding:10px;text-align:left;vertical-align:top}th{background:#e9f3ed}small{color:#536b61}a{color:#17634e}code{background:#eef3f1;padding:3px}p,li{max-width:1200px}</style><h1>HTML高速化・第3回</h1><h2>① 実施結果</h2><p>再調査・実装・本番反映・配信一致・主要機能確認・本番再計測を実施。既定ノートの初回表示2,589.0→2,398.2 ms（7.4%短縮）、操作可能2,610.3→2,414.1 ms（7.5%短縮）を確認した。配布HTMLの準備は4,485.0→4,327.7 ms（3.5%短縮）。大きい文書の起動・再読み込みにはばらつきが残り、改善未確認。限界とは断定しない。</p>'''+f"<p>前回公開版 <code>{m['beforeCommit']}</code> を今回の変更前として本番で再計測。今回の公開版 <code>{m.get('releaseCommit','未反映')}</code>。本番 <a href='{m['productionURL']}'>{m['productionURL']}</a>。<a href='{m.get('deployment',{}).get('url','#')}'>Pages公開記録</a>。配信3 HTMLとルート別名のハッシュを照合し、主要機能を検証した。計測日時は各原本のstarted/ended（UTC、日本時間＋9時間）、2026年10月9日。過去の49.3%短縮率を今回の追加改善率として再利用しない。</p>"+'''
<h2>② 本番の画面・操作別結果</h2><div class="table"><table><tr><th>画面・URL</th><th>計測条件</th><th>指標</th><th>変更前中央値 ms</th><th>変更後中央値 ms</th><th>短縮率</th><th>回数 前／後</th><th>判定・備考</th></tr>'''+''.join(tr(r) for r in rows)+'''</table></div><h2>単体HTMLの交互比較（本番とは別）</h2><p>同じ専用Chromeで前後各10回、順序を交互にする。正規化済み100ノート×100本文ブロック、両ファイルは事前読み込み。OS・コードキャッシュは制御せずHTTPの通信制限は適用しない。本番の率に流用しない。ばらつきがあり、今回のCPU側起動改善は確認できない。中央値の短縮は4.7%で、10ペア中9ペアが短縮したが分布は重なる。</p>'''+pt+'''
<h2>③ 計測・動作確認の根拠</h2><p>一時専用Chrome 154.0.8037.99、Mac、Node 22.22.2、1280×800、CPU4倍減速、遅延150ms、下り200000 B/s・上り100000 B/s。HTTPキャッシュ無効（初回相当）と、専用プロファイルで有効・転送完了後の再読み込みを分離。サーバー・CDN・OS・JSコード・DNS/TLSのキャッシュを冷却しない。既存利用者のキャッシュは削除しない。負荷は通常利用相当で、検証Chromeと画像圧縮等の重い処理を性能計測時に並行実行しない。本番負荷・普段の端末負荷は統一できず、実利用RUMはない。</p><p>変更前後の主計測は日本時間2026年10月9日09:36〜10:14。最初の後計測は全85件の保存とChrome終了後にNodeの終了が停滞したため、その終了処理のみ補い追加を独立して再開した。サンプルの開始/終了条件・ブラウザ条件を変えていない。</p><ul>'''+raw+'''<li><a href="final-release-tests.log">最終公開版と同じ生成HTMLの144回帰チェック</a></li><li><a href="release-src/src/LeafNote.html.in">今回公開した版の編集用ソース</a>・<a href="release-src/scripts/build-app.mjs">ビルド処理</a>・<a href="release-src/TESTING.md">開発手順</a></li></ul>
<h2>④ 変更と残る課題</h2><ul><li>ブロック正規化：画像・添付・表のフィールドが正確な既定値かつ自身のプロパティである場合、比較配列の作成と同じ値の再設定を省略。未設定・不正値・異なる型は元の処理へ進み、修復フラグと出力を維持。キャッシュ・新しさの緩和は導入しない。</li><li>JavaScriptの配信生成：読みやすいsrc/LeafNote.html.inを保持し、固定したTerser 5.51.2でアプリスクリプトだけを圧縮。約503KB→339KBへ削減。グローバル名とプロパティ名を維持し、unsafe最適化を無効にする。フォント・画像・HTML構造・MITライセンスは維持。実行時の追加依存や通信はない。実際のHTTP本文転送量はノート686,015→657,728 bytes、配布ページ1,079,100→1,051,747 bytes（HTTPキャッシュ無効時）。主要内容や操作可能の短縮率とは別の値である。npm ci→npm run build→npm testで再現でき、生成物の古さも検査する。転送量削減は確認できても、単体HTMLでの起動短縮は今回未確認。</li><li>アイコン共有：全転送量は21%減ったが、画像を必要なHTML復元より前に待つ順序になり、操作完了を短縮できなかった。変更前の方式へ復旧し不採用。サイズ減少を待ち時間改善と取り違えない。</li><li>画像再圧縮：画素を維持するWebP再圧縮はロゴ67,748→271,426 bytes、背景91,276→723,366 bytesへ増大。PNG再生成は同一223,202 bytesで減らない。元のバイト列を保持し不採用。</li></ul><p>優先判断：正規化の削減は大きい文書のCPU処理を対象とし、同値検証が可能で容易に復旧できる。配信生成はノート起動と配布HTML取得の両方に効く候補で、再現可能なビルドと開発依存が必要だが実行時コストを追加しない。画像共有/再圧縮は実測と画素維持条件により見送った。大きな任意Materialアイコン用フォントの削除や損失圧縮は表示を変え、外部化は単体HTML/オフラインの設計変更を要する。バックアップの更新確認省略、検索結果削減、永続データの長期キャッシュは必要な新しさや結果を変えるため採用しない。</p><p>残る待ち時間：フォント・画像を含む単体HTMLの転送、保存データの取得/正規化/無害化、本文DOM生成。今回だけで限界とは断定しない。さらなる大幅削減には配布方式や単体HTMLの制約を含めた設計検証が必要で、未実施の追加効果を実測として扱わない。実機モバイル、Safari/Firefox、最大容量/メディア多量、非保存権タブ、OSファイル選択は未計測として表に残す。</p><p>復旧条件：重大エラー、データ不整合、更新反映欠落、反復して明確な主要操作悪化があれば、公開コミットをgit revertで丸ごと戻してee8b39cのHTMLとビルド構成へ復旧し、mainへpush、Pages成功・ハッシュ・主要操作を確認。package.json/lock、scripts/build-app.mjsと編集用ソースも同じコミット単位で戻す。検証した範囲で重大障害は確認していない。</p></html>'''
(p/'report.html').write_text(report)
for r in rows:
 if r['screen'] in ['配布ページ','ノート起動','ノート切替','HTMLバックアップ'] and r['before'] and r['after']:print(r['screen'],r['condition'],r['metric'],fmt(r['before']),fmt(r['after']),round(r['reductionPercent'],1),r['verdict'])
