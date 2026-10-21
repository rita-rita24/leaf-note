# coding: utf-8
import json, statistics, html
from pathlib import Path
p=Path('reports/loading-2026-10-09-round2')
def read(n):return json.loads((p/n).read_text())
def group(samples):
 out={}
 for s in samples:
  k=(s['screen'],s.get('operation',s['screen']),s['data'],s['cache'])
  out.setdefault(k,[]).append(s)
 return out
names={'index':'配布ページ','app':'ノート起動','note-switch':'ノート切替','search-open':'検索画面','search-results':'本文検索結果','settings':'設定','trash':'ごみ箱','help':'ヘルプ','backup-dialog':'HTML保存確認','backup-result':'HTMLバックアップ'}
def stats(samples,metric):
 vals=[s[metric] for s in samples if isinstance(s.get(metric),(float,int))]
 return {'median':statistics.median(vals),'n':len(vals),'min':min(vals),'max':max(vals),'raw':vals} if vals else None
before=[];after=[]
for n in ['production-before.json','production-backup-before.json']:before+=read(n)['samples']
for n in ['production-after.json','production-backup-after.json']:after+=read(n)['samples']
for suffix,into in [('before',before),('after',after)]:
 q=p/f'production-additional-{suffix}.json'
 if q.exists():into+=read(q.name)['samples']
bg=group(before);ag=group(after);rows=[]
for key in dict.fromkeys([*bg,*ag]):
 screen,op,data,cache=key
 for metric in ['content','interactive']:
  b=stats(bg.get(key,[]),metric);a=stats(ag.get(key,[]),metric)
  rate=(b['median']-a['median'])/b['median']*100 if b and a and b['median'] else None
  verdict='改善未確認'
  if b and a:
   if a['max']<b['min'] and abs(b['median']-a['median'])>=16.7:verdict='改善'
   if b['max']<a['min'] and abs(b['median']-a['median'])>=16.7:verdict='悪化'
  else:verdict='未計測'
  url='https://rita-rita24.github.io/leaf-note/'+('index.html' if screen=='index' else 'LeafNote.html')
  condition=('キャッシュ無効（初回相当）' if cache=='cold' else 'キャッシュあり再読み込み／操作')+'・'+('100ノート×100ブロック' if data=='100-notes-100-blocks' else '既定1ノート11ブロック' if data=='default' and screen!='index' else '配布ページ')
  label=('結果がそろう' if screen in ['search-results','backup-result'] else '主要内容の表示') if metric=='content' else '操作可能'
  rows.append({'screen':names[screen],'url':url,'condition':condition,'metric':label,'before':b,'after':a,'reductionPercent':rate,'verdict':verdict})
for screen,url,condition in [('配布ページ','index.html','実機スマートフォン・Safari/Firefox'),('ノート','LeafNote.html','実機スマートフォン・Safari/Firefox'),('ノート','LeafNote.html','最大容量・メディア多量'),('ノート','LeafNote.html','別タブで保存権なし'),('インポート','LeafNote.html','OSファイル選択の待ち時間')]:
 for metric in ['主要内容の表示','操作可能']:
  rows.append({'screen':screen,'url':'https://rita-rita24.github.io/leaf-note/'+url,'condition':condition,'metric':metric,'before':None,'after':None,'reductionPercent':None,'verdict':'未計測（代表条件外）'})
(p/'results.json').write_text(json.dumps({'rows':rows,'formula':'(before-after)/before*100'},ensure_ascii=False,indent=2))
def esc(s):return html.escape(str(s))
def fmt(v):return f"{v['median']:.1f}" if v else '未計測'
trs=''
for r in rows:
 b,a=r['before'],r['after'];span='前 '+(f"{b['min']:.1f}–{b['max']:.1f}" if b else '未計測')+' / 後 '+(f"{a['min']:.1f}–{a['max']:.1f}" if a else '未計測')+' ms'
 trs+='<tr>'+''.join('<td>'+v+'</td>' for v in [f"<a href='{r['url']}'>{esc(r['screen'])}</a>",esc(r['condition']),esc(r['metric']),fmt(b),fmt(a),f"{r['reductionPercent']:.1f}%" if r['reductionPercent'] is not None else '算出不可',f"{b['n'] if b else 0}／{a['n'] if a else 0}",r['verdict']+'<br><small>'+span+'</small>'])+'</tr>'
manifest=read('manifest.json')
links=''.join(f"<li><a href='{f.name}'>{f.name}</a></li>" for f in sorted(p.glob('*.json')) if not f.name.startswith('exploratory'))
paired=read('paired-offline.json')
pairedRows=[]
for metric,label in [('content','主要内容の表示'),('interactive','操作可能'),('switch','ノート切替完了')]:
 b=stats([s for s in paired['samples'] if s['kind']=='before'],metric);a=stats([s for s in paired['samples'] if s['kind']=='after'],metric)
 diffs=[next(s[metric] for s in paired['samples'] if s['kind']=='before' and s['pair']==i)-next(s[metric] for s in paired['samples'] if s['kind']=='after' and s['pair']==i) for i in range(1,11)]
 rate=(b['median']-a['median'])/b['median']*100
 pairedRows.append({'metric':label,'before':b,'after':a,'reductionPercent':rate,'improvedPairs':sum(x>0 for x in diffs),'pairDifferences':diffs})
(p/'paired-results.json').write_text(json.dumps({'conditions':paired['conditions'],'rows':pairedRows},ensure_ascii=False,indent=2))
pairedTable='<table><tr><th>単体HTML・100×100 正規化済み合成ノート</th><th>前中央値 ms</th><th>後中央値 ms</th><th>短縮率</th><th>回数 前／後</th><th>判定</th></tr>'+''.join('<tr><td>'+r['metric']+'</td><td>'+fmt(r['before'])+'</td><td>'+fmt(r['after'])+'</td><td>'+f"{r['reductionPercent']:.1f}%"+'</td><td>10／10</td><td>'+('改善（10ペア全て短縮）' if r['improvedPairs']==10 else '改善未確認（ばらつきあり）')+'</td></tr>' for r in pairedRows)+'</table>'
report='''<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HTML読み込み高速化・第2回</title><style>body{font:16px/1.7 system-ui;margin:30px;color:#19302a}h1,h2{line-height:1.4}.table{overflow:auto}table{border-collapse:collapse;font-size:13px;min-width:1200px;width:100%}td,th{border:1px solid #c9d6d0;padding:10px;text-align:left;vertical-align:top}th{background:#e9f3ed}small{color:#536b61}a{color:#17634e}code{background:#eef3f1;padding:3px}p,li{max-width:1200px}</style><h1>HTML読み込み高速化・第2回</h1>
<h2>① 実施結果</h2><p>追加改善を本番反映し主要機能・配信版を確認した。単体HTMLのノート切替は54.8→27.8 ms、49.3%短縮（10ペア全て改善）。本番のノート切替は中央値24.5%短縮したが分布が重なるため改善未確認。本番起動の改善は未確認で、配布ページには遅くなった実測値もある。全画面の高速化を達成したとは扱わない。</p><p>前回最終版187021fを今回の変更前として、本番を再計測した比較。前回よりさらに短縮した率のみを示す。過去の旧成功版de9ecb7との比較や、画面別の率の単純平均は行わない。</p>'''+f"<p>本番 <a href='{manifest['productionURL']}'>{manifest['productionURL']}</a>。反映版 <code>{manifest['releaseCommit']}</code>。<a href='{manifest['deployment']['url']}'>Pages公開成功</a>。3 HTMLの配信ハッシュ一致を確認。計測日時は各生データのUTC時刻（日本時間は＋9時間）、2026年10月9日。開始時刻（JST）：変更前 2026-10-09T08:18:45.913000+09:00、最終配布ページの追加計測 2026-10-09T09:33:37.969000+09:00。</p>"+'''
<h2>② 本番の画面・操作別の結果</h2><div class="table"><table><thead><tr><th>画面・URL</th><th>条件</th><th>指標</th><th>変更前中央値 ms</th><th>変更後中央値 ms</th><th>短縮率</th><th>回数 前／後</th><th>判定・ばらつき</th></tr></thead><tbody>'''+trs+'''</tbody></table></div>
<h2>単体HTMLの交互比較（本番とは別条件）</h2><p>同じ専用Chromeで旧HTMLと新HTMLの順序を毎ペア入れ替え、各10回。OS・コードキャッシュは冷却せず両ファイルを事前に開く。HTTPの通信制限・HTTPキャッシュ制御は適用されない。データは正規化済み100ノート×100本文ブロック。本番の旧形式合成ノートと別条件のため、率を本番結果に流用しない。</p>'''+pairedTable+'''<h2>③ 計測・機能確認の根拠</h2><p>専用の一時Chrome 154.0.8037.99、Mac、Node 22.22.2、1280×800、CPU4倍減速、下り200,000 bytes/s・上り100,000 bytes/s・遅延150ms。Chrome HTTPキャッシュ無効／有効を分けて制御。有効条件は任意の補助転送も完了させてから再読み込み。サーバー・CDN・OS・JSコード・DNS/TLSのキャッシュは冷却しない。端末負荷、本番負荷、公開後のCDN状態は完全には一致させられない。計測中に別の検証Chromeを走らせない。探索中に重なった補助操作の記録はexploratoryと明記し不採用。実利用のRUMはない。</p><p>ナビゲーション開始→本文と一覧の描画フレーム、または検索の開閉・配布HTMLソース読み出しの成功まで。操作はクリック/input開始→内容と主要コントロールの描画フレーム。検索は結果/空結果の描画。100×100の旧形式合成データには既存版の非破壊的整形通知が出るため、同じ手順で確認して閉じた次のフレームまで含める（人の判断時間は除外）。HTML保存は確認開始→全ページ一致を確認したBlob取得。OS保存ダイアログ・ディスク書き込みは含めない。ロードイベントのみをユーザー完了とは扱わない。</p><ul>'''+links+'''<li><a href="release-final-revised-tests.log">リリース回帰テスト</a></li></ul>
<h2>④ 変更・残る課題</h2><p>優先判断：一覧DOM再利用は100ノートの操作を対象とし、データキャッシュを持たず容易に復旧できるため優先。容量判定は読み込み・保存の全画面に及ぶが、Unicode境界を維持する同値確認が必要。指紋再利用は読み込みだけに影響し、メモリ増加に見合う起動効果が不明で不採用。アイコン共有は配布ページの転送量削減が見込まれたが、準備処理が操作開始に加わり、最終的に取り下げた。いずれも保守・運用コストを増やす外部サービスや新しい依存は追加していない。</p><ul><li>UTF-8容量判定：UTF-16コード単位の3倍以下にUTF-8サイズが収まることを使い、明らかに上限内の文書は全文字走査を省略。ASCII判定の正規表現を再利用し、空文字・上限0は早期終了。ASCIIは1文字＝1byteとして切り詰めと長さ取得を行う。Unicode・境界近く・上限超過は従来の計数を保持。上限も切り詰め結果も変更しない。</li><li>保存読み込みの指紋再利用は一度検証したが、起動への追加効果が切り分けられず一時的に全スナップショットを保持するため取り下げ、変更前の方式に戻した。</li><li>サイドバー：タイトル・アイコン・階層・削除・展開・言語・件数が変わらない場合、DOMを再利用して選択表示とaria-currentを更新。変更があれば全描画へ戻る。本文は毎回新しく描画する。永続データのキャッシュや新しさの緩和を導入していない。</li><li>配布ページのアイコン共有・重複配信削減は、操作可能になるまでの本番時間が悪化したため取り下げ、変更前の処理へ戻した。圧縮サイズ削減を最終成果に含めない。埋め込みノートHTMLだけを最終アプリ版へ同期している。</li></ul><p>候補判断：全文字走査・変化のないDOM作成は、出力を保って除去できる処理として採用。重複配信削減は本番時間を短縮できず不採用。大きいフォントは保存済みの任意Materialアイコンにも使用されるため、使用名だけへの削減は見送った。埋め込みフォント/画像の外部化、バックアップの更新確認省略、検索走査量削減は単体HTML利用・新しさ・結果集合への影響があるため見送った。主要な安全な候補を検証し、残る転送量や標準ケースの短い処理は追加効果が小さいか設計変更を要する。</p><p>一部条件未計測：実機スマートフォン・Safari/Firefox、最大容量や画像多量の文書、保存権を持たない別タブの性能、OSファイル選択、オフラインの既定・メディア多量・最大容量の性能。単体HTMLの100×100は別途交互比較した。これらは今回の代表計測から省略した成果として扱わず、未計測として残す。補助ポップオーバーは独立画面とせず既存回帰チェック対象。作業中leaf-note.htmlは未コミットの別開発版であり、本番には混入させていない。前回旧本番とリポジトリの検索上限差は今回修正していない。</p></html>'''
(p/'report.html').write_text(report)
for r in rows:
 if r['screen'] in ['配布ページ','ノート起動','ノート切替','HTMLバックアップ']:print(r['screen'],r['condition'],r['metric'],fmt(r['before']),fmt(r['after']),None if r['reductionPercent'] is None else round(r['reductionPercent'],1),r['verdict'])
