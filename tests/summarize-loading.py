# coding: utf-8
import json, statistics, html
from pathlib import Path
p=Path('reports/loading-2026-10-09')
def read(n): return json.loads((p/n).read_text())
before=read('production-before.json')['samples']+read('production-backup-before.json')['samples']
after=[s for s in read('production-after.json')['samples'] if s['screen']=='index']+read('production-app-after-verified.json')['samples']+read('production-backup-after-final.json')['samples']
before=[s for s in before if not(s['screen']=='note-switch' and s['data']=='default')]
def key(s): return (s['screen'],s.get('operation',s['screen']),s['data'],s['cache'])
def stats(ss,m):
 v=[s[m] for s in ss if isinstance(s.get(m),(int,float))]
 return {'median':statistics.median(v),'min':min(v),'max':max(v),'n':len(v),'raw':v} if v else None
names={'index':'配布ページ','app':'ノート起動','note-switch':'別ノートへ切替','search-open':'検索画面を開く','search-results':'本文検索結果','settings':'設定','trash':'ごみ箱','help':'ヘルプ','backup-dialog':'HTML保存確認','backup-result':'HTMLバックアップ生成'}
rows=[]
for k in dict.fromkeys(key(s) for s in before+after):
 screen,op,data,cache=k
 for metric in ['content','interactive']:
  b=stats([s for s in before if key(s)==k],metric); a=stats([s for s in after if key(s)==k],metric)
  comparable=b is not None and a is not None and not(screen=='search-results' and data!='default')
  rate=(b['median']-a['median'])/b['median']*100 if comparable and b['median'] else None
  note=''
  if b is None: verdict='変更前未計測';note='旧本番は404。短縮率を算出できない'
  elif a is None: verdict='変更後未計測'
  elif not comparable: verdict='比較不可';note='旧本番100一致件、既存リポジトリ版は走査上限により30一致件。既存上限を変更していない。結果集合が異なるため算出しない'
  elif screen=='backup-result': verdict='悪化';note='旧本番の無確認キャッシュと異なり、既存リポジトリ版の更新確認を維持。no-cacheで毎回再検証。OS保存時間は含まない'
  elif abs(b['median']-a['median'])<16.7 or not(a['max']<b['min'] or b['max']<a['min']): verdict='改善未確認';note='フレーム単位の小差または分布重複。追加効果が小さく、確定的改善としない'
  else: verdict='改善' if rate>0 else '悪化'
  url='https://rita-rita24.github.io/leaf-note/'+('index.html' if screen=='index' else 'LeafNote.html')
  label=('主要内容の表示' if metric=='content' else '操作可能')
  if screen in ['search-results','backup-result'] and metric=='content': label='必要な結果がそろう'
  rows.append({'screen':names[screen],'url':url,'condition':('キャッシュ無効（初回相当）' if cache=='cold' else 'キャッシュあり再読み込み／操作')+'・'+('既定1ノート11ブロック' if data=='default' and screen!='index' else '100ノート×100本文ブロック' if data=='100-notes-100-blocks' else '配布ページ'),'metric':label,'before':b,'after':a,'reductionPercent':rate,'verdict':verdict,'note':note})
for name,url,reason in [('ノート切替（既定1ノート）','LeafNote.html','別ノートが存在しないため対象操作なし。旧記録の同一ノート再選択は無効として除外'),('オフラインHTML / 作業中leaf-note.html','leaf-note.html','オフライン機能同値確認済み。性能は未計測。ローカルの別途開発中の版は本番未反映'),('Markdown取り込み','LeafNote.html','機能回帰テスト済み。OSファイル選択・取り込み時間は未計測。旧本番と導線が異なる'),('保存権を持たない別タブ','LeafNote.html','Web Locks・保存権の回帰テスト済み。権限別の性能は未計測'),('メディア多量・最大容量','LeafNote.html','回帰テストで容量上限を確認。代表条件外の性能は未計測'),('実機スマートフォン／Safari／Firefox','LeafNote.html','性能は未計測。回帰テストでは携帯・タブレット幅を確認')]:
 for m in ['主要内容の表示','操作可能']:
  rows.append({'screen':name,'url':url,'condition':'代表計測外','metric':m,'before':None,'after':None,'reductionPercent':None,'verdict':'未計測／対象操作なし' if name.startswith('ノート切替') else '一部条件未計測','note':reason})
(p/'results.json').write_text(json.dumps({'formula':'(before-after)/before*100','rows':rows,'sourceFiles':['production-before.json','production-backup-before.json','production-after.json (index only)','production-app-after-verified.json','production-backup-after-final.json']},ensure_ascii=False,indent=2))
def esc(x):return html.escape(str(x))
def num(x):return '未計測' if x is None else f"{x['median']:.1f}"
body=''
for r in rows:
 b,a=r['before'],r['after'];span='前 '+(f"{b['min']:.1f}–{b['max']:.1f}" if b else '未計測')+' / 後 '+(f"{a['min']:.1f}–{a['max']:.1f}" if a else '未計測')+' ms'
 body+='<tr>'+''.join('<td>'+s+'</td>' for s in [f"{esc(r['screen'])}<br><a href='{esc(r['url'])}'>{esc(r['url'])}</a>",esc(r['condition']),esc(r['metric']),num(b),num(a),'算出不可' if r['reductionPercent'] is None else f"{r['reductionPercent']:.1f}%",f"{b['n'] if b else 0}／{a['n'] if a else 0}",esc(r['verdict'])+'<br>'+esc(r['note'])+'<br><small>'+span+'</small>'])+'</tr>'
links=''.join(f"<li><a href='{f}'>{f}</a></li>" for f in ['manifest.json','protocol.json','results.json','production-before.json','production-backup-before.json','production-after.json','production-app-after-verified.json','production-backup-after-final.json','fixture-audit.json','production-feature-comparison.json','working-feature-comparison.json','freshness-check.json','release-v3-tests.log'])
report='''<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HTML読み込み改善・本番検証報告</title><style>body{font:16px/1.7 system-ui,sans-serif;margin:30px;color:#18232a}h1,h2{line-height:1.4}p,li{max-width:1100px}.table{overflow:auto}table{border-collapse:collapse;font-size:13px;min-width:1450px;width:100%}th,td{border:1px solid #ccd5db;padding:10px;vertical-align:top}th{background:#eaf2ef;text-align:left;position:sticky;top:0}td:nth-child(1){max-width:245px;overflow-wrap:anywhere}small{color:#53626a}code{background:#eef1f3;padding:2px 5px}.notice{background:#fff5df;padding:15px;border-left:4px solid #b37700}a{color:#17634e}</style><h1>HTML読み込み改善・本番検証報告</h1>
<h2>① 実施結果</h2><p>本番反映、配信版の一致確認、主要機能の確認、本番再計測を完了。初回相当の主要内容表示は配布ページ約53%、ノート起動約28%短縮。バックアップには旧本番比で悪化があり、大量本文検索は結果集合が異なるため改善率を算出しない。一部の端末・データ・権限条件は未計測。</p>
<p>本番：<a href="https://rita-rita24.github.io/leaf-note/">https://rita-rita24.github.io/leaf-note/</a>。反映版 <code>187021f1abce8cd6df1787a51dc2f46bd9f42a04</code>。<a href="https://github.com/rita-rita24/leaf-note/actions/runs/37809887075">GitHub Pagesデプロイ成功</a>。3 HTMLのSHA-256がリリース候補と一致。変更前は直近の成功版<code>de9ecb72b1261a744d90909d7f389f575deb4465</code>。ローカル既存HEAD <code>544e334</code> には未公開の変更があり、未コミットの作業内容を混入させず、そのHEADに最適化を加えて通常のmain→Pages公開を行った。</p>
<p>計測：2026年10月9日 JST、変更前00:45〜01:02、最終版01:36〜01:54（各JSONにUTCの開始・終了時刻）。ページ表示完了前の補助通信を次回まで待つ条件で、各5回。探索中の無効記録は集計から除外。</p>
<div class="notice">大量本文検索：旧成功版は100一致件、既存リポジトリ版は走査上限により30一致件＋作成項目。上限を今回変更していないが、旧本番の結果集合を維持した比較にはならないため「比較不可」。バックアップ：既存リポジトリ版で必須の毎回更新確認を維持した結果、更新確認しない旧本番より待ち時間が増加。これらをサイト全体の改善として集計しない。</div>
<h2>② 本番での画面別計測結果</h2><p>全値は実測中央値（ms）。短縮率＝（変更前−変更後）÷変更前×100。負値は悪化。丸め前の値で計算。各行の備考に最小〜最大を記載。短い処理の同一フレーム完了では表示と操作の値が同じになる。</p><div class="table"><table><thead><tr><th>画面・URL</th><th>計測条件</th><th>指標</th><th>変更前中央値 ms</th><th>変更後中央値 ms</th><th>時間の短縮率</th><th>計測回数 前／後</th><th>判定・備考・ばらつき</th></tr></thead><tbody>'''+body+'''</tbody></table></div>
<h2>③ 計測と動作確認の根拠</h2><p>同じMac上の専用一時Chrome 154.0.8037.99、Node 22.22.2、1280×800、CPU 4倍減速、下り200,000 bytes/s・上り100,000 bytes/s・遅延150ms。CDPで条件制御。HTTPブラウザキャッシュ無効／有効を分離し、有効は配信完了まで待ってから再読み込み。初回相当でもDNS・TLS・JSコード・OSの各キャッシュを完全に冷却した計測ではない。サーバー/CDNキャッシュと本番負荷は制御しない。個人の利用データ・ブラウザプロファイルを使わず、合成データだけを投入。逐次計測で共有キャッシュの削除・負荷試験は行わない。</p>
<p>開始点はナビゲーション開始または対象クリック/inputイベント。表示完了は本文と一覧が描画フレームに存在する時点、操作完了は検索の開閉または配布HTMLソースの取得が実際に成功した時点。検索は結果または明示的な空結果の描画。設定・ごみ箱・ヘルプ・確認は内容とコントロールが開いた描画フレーム。バックアップは全ページの一致を確認したHTML Blob取得。loadイベントや通信完了を完了指標にしない。ごみ箱の空表示、検索の空結果も検証。バックアップはOS保存ダイアログとディスク書き込みを含まない。</p>
<p>100×100の旧形式合成ノートには既存リポジトリ版の非破壊的な整形通知が1度出る。通知を確認して閉じた次の描画フレームまで待つ手順を含める（人間の判断時間は含まない）。通知の下でボタンを直接呼べた初期記録は採用せず、production-app-after-verified.jsonで再計測。旧本番は同じデータで通知が出ないことを別途確認。既定1ノートの同一ノート再選択は「切替」にならないため除外。production-after.jsonのノート行も採用せず、配布ページ行だけを採用。</p>



<ul>'''+links+'''</ul>
<h2>④ 変更内容と残る課題</h2><ul><li>ノート：サイドバーの容量判定を1回にまとめ、DOMをまとめて追加。ガターの座標読み取りを先にまとめ、変更のないスタイル書き込みを削減。大量ノートの直列処理・レイアウト更新を減らす。単独施策の本番寄与は分離できないが、起動・切替をまとめた結果で確認。</li><li>ノート：文字列が通常のテキストならDOM解析を省略。正規化で値が同じなら不要なJSON直列化を省略。特殊文字・HTML・旧形式の分岐は従来と同じ処理へ戻し、512ケースで同値確認。永続化や取得データのキャッシュを新設していない。</li><li>検索：小さい安全なデータはinputイベント内で結果を生成。大きい/構造化データは0msタイマーで連続入力をまとめる。固定80ms待機を除去。既存リポジトリ版の固定待機を除去し、即時更新と最新入力の反映を確認。旧本番との小さい検索比較では改善未確認。大量本文検索は既存上限の差があるため本番率を算出不可。</li><li>バックアップ：no-storeの毎回全HTML再取得をno-cacheの必ず再検証に変更。304なら既存本文を使い、更新なら200で最新本文を得る。<a href="https://developer.mozilla.org/en-US/docs/Web/API/Request/cache">Request.cacheの仕様</a>。中間版の約3.8秒から最終188/306msへ改善したが、これは旧本番比の改善率ではない。元の無確認キャッシュに戻すと既存リポジトリ版の新しさを失うため戻さなかった。</li></ul>
<p>候補比較：アイコン後置は全画面に影響し、表示・画素を変えない小さい変更で最優先。DOM解析・直列化・サイドバーは大量データに効果が見込め、同値テストを伴って採用。検索の固定待機とバックアップ全量再取得は明確な待ちがあるため次に採用。データの長期キャッシュ・遅延表示・取得量削減は新しさや結果/件数を変える危険があり採用しない。CSS/JS外部分割と圧縮構成変更は単体HTMLのオフライン配布を損ない、運用負担が増えるため見送った。画像自体の圧縮は画素・表示要件に関わるため未実施。サーバーAPI/DBはこの単体HTML構成の起動経路にはない。</p>
<p>残る遅延：配布ページでソース取得可能になるまでの大きい埋め込みHTML転送、ノートの全体転送・10,000ブロックの読み込み/正規化、バックアップの更新確認の往復。主な安全な候補を実装・検証し、短い補助操作は数ms〜1フレームで分散と重なるため追加最適化を確定的成果としない。全量転送の削減には単体HTML配布の設計変更が必要。実機モバイル・メディア多量・権限別・オフラインの性能、実利用の遅いケースは未確認。既存検索上限と旧本番との差は今後の仕様調整事項。推定の追加効果を実測として記載していない。</p>
</html>'''
(p/'report.html').write_text(report)
for r in rows:
 if r['screen'] in ['配布ページ','ノート起動','本文検索結果','HTMLバックアップ生成']: print(r['screen'],r['condition'],r['metric'],num(r['before']),num(r['after']),r['reductionPercent'],r['verdict'])
print('rows',len(rows))
