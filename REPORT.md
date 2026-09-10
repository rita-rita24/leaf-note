# 課題一覧

製品品質改善（2026-09-11）: 保存競合、Undo / Redo とエクスポートの revision、初回利用とダウンロード、取り込みのタッチ導線、モーダルとサイドバーのフォーカスを改善。追加13件を含む全144テストが成功。改善内容と未検証範囲は [製品品質レポート](reports/product-quality-2026-09-11.md) を参照。以下の91件は直前までの課題記録。

_直前の対応記録: 2026-09-11 JST。未対応だった 89〜91 を修正し、全91件を「完」に更新した。`LOW_PRIORITY_COMPAT_BLOCK_TYPES` / deferred 判定、保存前 state payload 上限、専用ブロック変換時の hidden field cleanup を実装し、`index.html` の `leafnote-source` も `LeafNote.html` と同期した。`node --check tests/run-browser.mjs` と承認付き `npm test` は成功した。_

## 1. localStorage / IndexedDB 起動時選択

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 起動時に localStorage / IndexedDB / 埋め込み状態のうち古い保存元を選ぶと、ユーザーの最新編集が巻き戻る可能性があった。
- 根拠: `getStateRevision` が `lastModifiedAt`、`exportedAt`、`exportRevision`、ページ更新時刻、ごみ箱自動削除時刻を revision 候補に含め、`chooseStartupState` が埋め込み状態と保存済み状態を revision 比較している。`loadStateAsync` も IndexedDB と localStorage を並行取得し、両方ある場合は revision が新しい方を返している。
- 現状: 起動時の復元元選択は revision 基準になっており、古い保存元を無条件に優先する状態ではない。
- 影響: 解消済みのため、現時点で同経路による編集巻き戻りリスクは確認されない。
- 次の対応: なし。

## 2. ダイアログ input 属性生成

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: ダイアログの input を HTML 文字列で組み立てる際、初期値や placeholder に引用符などが含まれると属性が壊れる可能性があった。
- 根拠: `showPrompt` と `showSaveDocumentDialog` は `dialogBox.innerHTML` 内に動的な `value` / `placeholder` を埋め込まず、生成後に `input.value` と `input.placeholder` へ代入している。タイトル、本文、ボタン文言は `escapeHTML` 済み。
- 現状: ユーザー入力値が input 属性文字列へ直接連結されないため、属性破壊は解消済み。
- 影響: 解消済みのため、ダイアログ入力値による表示崩れや属性注入リスクは確認されない。
- 次の対応: なし。

## 3. Markdown リンク変換時の href 属性文字列結合

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: Markdown リンクを HTML に変換する際、URL を `<a href="...">` の属性文字列へ直接連結すると、引用符などで属性を壊せる可能性があった。
- 根拠: `markdownToHtmlInline` はリンク生成を `safeInlineLinkHtml` に委譲し、`safeInlineLinkHtml` は `document.createElement('a')`、`setAttribute('href', ...)`、`textContent` でリンクを作っている。許可スキーム外はリンク化せずテキストとして escape している。
- 現状: href 属性の直接文字列連結は使われておらず、Markdown リンク経由の属性破壊は解消済み。
- 影響: 解消済みのため、Markdown リンク由来の属性注入リスクは確認されない。
- 次の対応: なし。

## 4. HTML-only paste の sanitizer bypass

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: contenteditable への貼り付けで `text/html` だけがあり `text/plain` / Markdown がない場合、貼り付けハンドラが何もせず戻るため、ブラウザのデフォルト HTML 挿入が走る可能性があった。本文以外の table cell / image caption / definition list の編集欄も貼り付け処理が揃っておらず、同じ経路で保存値に HTML が残り得た。
- 根拠: `_readLeafNoteClipboard` が `text/html` も返し、`handleBlockPaste` は HTML-only clipboard を `preventDefault()` したうえで `_insertSanitizedClipboardPayload` 経由の `sanitizeHTML` 済み HTML だけを挿入する。`handleSanitizedRichPaste` と `handlePlainTextEditablePaste` も table cell / image caption / definition list / page title / document name に適用されている。該当 integration テストも存在する。
- 現状: ブラウザのデフォルト HTML paste に任せる主要経路は塞がれており、ライブ DOM と保存値の両方が sanitizer 経由になっている。
- 影響: 解消済みのため、主要貼り付け経路で危険な HTML が保存されるリスクは確認されない。
- 次の対応: なし。

## 5. HTML 保存時の Object URL 同期 revoke

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: HTML 保存時に Blob の Object URL を作ってクリック直後に同期的に revoke しており、ブラウザによってはダウンロード開始前に URL が無効化される可能性があった。
- 根拠: `#export-btn` の HTML 保存処理はダウンロード用 anchor を DOM に追加してクリック後に除去し、`setTimeout(() => URL.revokeObjectURL(url), 0)` で Object URL を遅延 revoke している。Markdown エクスポートとファイルダウンロードでも同じ方針になっている。
- 現状: HTML 保存も Markdown エクスポート / ファイルダウンロードと同じ遅延 revoke 方針に揃っている。
- 影響: 解消済みのため、同期 revoke による保存失敗リスクは確認されない。
- 次の対応: なし。

## 6. npm test scripts の参照先テストハーネス不在

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `package.json` と `TESTING.md` は `npm test` / `npm run test:unit` / `npm run test:integration` / `npm run test:coverage` を案内しているが、参照先の `tests/run-browser.mjs` が存在しないためテストを実行できない状態だった。
- 根拠: `tests/run-browser.mjs` が存在し、Chrome DevTools Protocol で `LeafNote.html?test=1` を起動する unit / integration / coverage ランナーが実装されている。`package.json` の scripts はこの実在ファイルを参照している。teardown の安定化も課題15として実装済み。
- 現状: テストハーネス不在の問題は解消済みで、teardown の安定化も課題15で対応済み。
- 影響: 解消済みのため、参照先ファイル不在でテストを起動できない問題は確認されない。
- 次の対応: なし。

## 7. ごみ箱自動削除日数の負値で全削除され得る

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 保存済み状態や埋め込み状態の `trashAutoPurgeDays` が負の数に改変されていると、起動時またはごみ箱表示時の自動削除でごみ箱内ページがまとめて削除される可能性があった。
- 根拠: `normalizeTrashAutoPurgeDays` があり、許可値を `0` / `7` / `30` / `90` に限定している。`normalizeStateShape`、`sanitizeStateInPlace`、ごみ箱 UI setter、`renderTrashModal`、`autoPurgeTrash` は同じ正規化関数を使い、`autoPurgeTrash` は `days <= 0` で即 return する。負値で削除されない unit テストも存在する。
- 現状: 保存済み状態・埋め込み状態・UI 変更のいずれでも負値や未許可値は `0` に丸められ、自動削除は無効扱いになる。
- 影響: 解消済みのため、負値設定でごみ箱が全削除されるリスクは確認されない。
- 次の対応: なし。

## 8. リモート画像インライン化の timeout / size cap 不在

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: HTML 保存時にリモート画像を data URL 化する処理が timeout やサイズ上限なしで順次 `fetch` するため、遅い画像や巨大画像で保存処理が長時間止まったり、生成 HTML が過大になる可能性があった。
- 根拠: `readResponseBlobWithLimit` を追加し、`Content-Length` 超過は body を読まず即拒否、長さ不明または過小申告のレスポンスは `ReadableStream` を chunk 単位に読みながら累積サイズを確認する。上限超過時は reader cancel と controller abort を行い、`fetchRemoteImageBlob` はこの helper 経由で blob を取得する。unit テストで `Content-Length` 超過時に body を読まないこと、stream 読み取り中の 8MB+1 byte を中断することを確認済み。
- 現状: 8MB 超のリモート画像は、ヘッダで判定できる場合も stream 読み取り中に判明する場合も HTML へインライン化されない。
- 影響: 解消済みのため、サイズ不明の巨大レスポンスを最後まで読み切ってブラウザのメモリや保存処理を圧迫するリスクは抑制されている。
- 次の対応: なし。

## 9. 循環したページ階層の正規化漏れ

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 保存済み状態や埋め込み状態に `A.parentId = B`、`B.parentId = A` のようなページ階層の循環があると、起動後のサイドバー描画や検索結果のパス生成で再帰・ループが止まらない可能性があった。
- 根拠: `normalizeStateShape` に `breakPageParentCycles` と `syncChildrenWithParents` があり、祖先方向の循環を検出して閉路を作る `parentId` を切る。root 強制後にも `children` を再整合している。循環 state の回帰テストも存在する。
- 現状: 改変された保存データや共有 HTML から循環したページ階層が入っても、起動時正規化で循環が切られる。
- 影響: 解消済みのため、ページ階層循環による描画停止リスクは確認されない。
- 次の対応: なし。

## 10. 画像 URL 入力時の保存前検証不在

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 画像ブロックの URL 入力で `javascript:` や `ftp:` など不許可スキームを入力しても、保存・描画時点では拒否されず、現在セッションの state と DOM に残る可能性があった。
- 根拠: `normalizeImageUrl` があり、`sanitizeBlocksDeep`、`normalizeStateShape`、画像ファイル読み込み、画像ブロック挿入、画像 URL 入力が同じ raster 画像 URL 判定を使う。`applyImageUrlInput` は空でない不許可 URL を保存せず、ユーザーへエラーを表示する。画像 URL picker の回帰テストも存在する。
- 現状: 画像 URL 入力時点で不許可スキームは拒否され、保存直後の state や DOM に残らない。
- 影響: 解消済みのため、画像 URL 入力から危険な URL が保存されるリスクは確認されない。
- 次の対応: なし。

## 11. 非同期保存の順序保証がない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 複数の `_doSave` が重なると、古い snapshot を持った非同期保存が新しい保存より後に完了し、IndexedDB / localStorage の最新状態を古い内容で上書きする可能性があった。
- 根拠: `_doSave` は単調増加する `_saveSequence` と live state の snapshot 比較で古い保存を破棄する。保存済み snapshot と同一で、実保存済みフラグが立っている場合は書き込みをスキップする。state が保存中に進んだ場合は即時再保存を予約する。古い transaction が後から完了する unit テストも存在する。
- 現状: 保存完了順が入れ替わっても、古い snapshot は IndexedDB / localStorage の最終保存値として採用されない。
- 影響: 解消済みのため、非同期保存の完了順入れ替わりによるデータ巻き戻りリスクは確認されない。
- 次の対応: なし。

## 12. Markdown インポートのサイズ / 読み取りエラー制御不在

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: Markdown インポートで巨大ファイルや読み取り失敗ファイルを選ぶと、`File.text()` と同期的な `parseMarkdownToBlocks` がそのまま走り、UI 停止や未処理エラーになる可能性があった。
- 根拠: `readMarkdownImportFile` が 2MB 上限を確認し、`File.text()` の読み取り失敗を `try/catch` で扱う。parse / sanitize も `try/catch` で囲み、失敗時は `showAlert` して import を中断する。oversize / read error の integration テストも存在する。
- 現状: 巨大 Markdown と読み取り失敗ではページを作成せず、ユーザー通知だけを出す。
- 影響: 解消済みのため、Markdown インポート失敗で UI が止まる主要リスクは確認されない。
- 次の対応: なし。

## 13. SVG 画像データの安全ポリシー不在

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 画像ブロックが SVG を通常画像として受け入れるため、改変データや選択ファイル、リモート画像の `image/svg+xml` が無検査のまま state・DOM・保存 HTML に残る可能性があった。
- 根拠: 画像ブロックは `RASTER_IMAGE_MIME_TYPES` と raster 拡張子 allowlist に統一されている。`.svg`、`image/svg+xml`、`data:image/svg+xml,...`、remote SVG MIME は拒否され、ファイル picker の accept も raster MIME / 拡張子に限定している。state normalization、file 判定、remote fetch の unit テストも存在する。
- 現状: SVG は画像ブロックの state / DOM / 保存 HTML へ通常画像として残らない。
- 影響: 解消済みのため、画像ブロック経由で SVG が保存・描画されるリスクは確認されない。
- 次の対応: なし。

## 14. Markdown インポート画像 URL の正規化漏れ

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: Markdown ファイルのインポートで `![alt](javascript:...)` など不許可 URL の画像を含むファイルを選ぶと、画像ブロックの URL が正規化されないまま state / DOM に入る可能性があった。
- 根拠: `importMarkdownAsNewPage` は `parseMarkdownToBlocks(body)` の直後に `sanitizeBlocksDeep(blocks)` を通す。画像 URL は `normalizeImageUrl` により不許可 scheme、SVG data URL、SVG 拡張子 URL が空になる。`javascript:` / SVG / raster URL を含む Markdown import の integration テストも存在する。
- 現状: Markdown ファイル import でも貼り付け経路と同等に画像 URL が正規化される。
- 影響: 解消済みのため、Markdown インポート画像から危険な URL が保存されるリスクは確認されない。
- 次の対応: なし。

## 15. テスト終了処理が Chrome プロファイル削除レースで失敗することがある

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `npm test` で全テストケースが成功しても、Chrome の一時 user data dir 削除時に `ENOTEMPTY` が発生し、終了コード 1 になることがある。
- 根拠: `tests/run-browser.mjs` に `stopBrowser` / `waitForProcessExit` を追加し、teardown で Chrome に `SIGTERM` を送った後に `exit` を待つ。時間内に終了しない場合は `SIGKILL` に fallback する。プロファイル削除は `rm(..., { maxRetries: 10, retryDelay: 100 })` で retry する。
- 現状: テストケース成功後、Chrome 終了と一時 user data dir 削除の順序が安定化されている。
- 影響: 解消済みのため、teardown レースによる false negative のリスクは低減された。
- 次の対応: なし。

## 16. raw/code 系ブロックを通常ブロックへ変換すると未サニタイズ HTML が描画され得る

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: `code` / `html` / `math` / `mermaid` など raw text 系ブロックの本文に HTML 断片が入った状態で、ブロック種別を `text` や見出しなどの通常ブロックへ変換すると、未サニタイズの文字列が `innerHTML` として描画される可能性がある。
- 根拠: `convertBlockType` は変換前の種別を保持し、`RAW_TEXT_BLOCK_TYPES` から通常 rich block 系へ変換する場合に `_rawTextSourceToRichHtml` 経由で `<` や `>` を HTML 文字として escape し、改行は `<br>` として保持する。raw text から `text` / `toggle` へ変換しても実 DOM に `img` / `script` / `b` 要素が生成されない integration テストを追加した。
- 現状: raw/code 系の本文は通常ブロックへ変換される前に安全な rich HTML へ変換される。
- 影響: 解消済みのため、raw/code 系から通常ブロックへの変換操作で任意 HTML が描画されるリスクは確認されない。
- 次の対応: なし。

## 17. 埋め込み state の `</script>` エスケープが空白付き終了タグを扱えない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 自己完結 HTML 保存時に state JSON 内の `</script>` は置換しているが、`</script >` や `</script\n>` のような HTML パーサが終了タグとして扱う表記は置換されず、埋め込み state の script タグを途中で閉じる可能性がある。
- 根拠: HTML 保存処理は `escapeJSONForScriptData` で state JSON 内の `<` を `\u003c` に置換してから `embedded-state` へ埋め込む。完全一致の終了タグだけでなく、空白付き・改行付きの終了タグ相当文字列も script-data 内に literal `<` として現れない。保存 HTML の embedded payload に `<` が含まれず、JSON.parse 後は元の文字列へ復元される integration テストを追加した。
- 現状: 自己完結 HTML 保存時の embedded state は HTML script-data として安全な JSON 文字列になっている。
- 影響: 解消済みのため、state JSON 内の終了タグ相当文字列で embedded-state が途中終了するリスクは確認されない。
- 次の対応: なし。

## 18. ローカル画像 / 添付ファイルに保存可能な最大サイズがない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 画像ファイルや添付ファイルを追加する際、8MB 超では確認ダイアログを出すだけでハード上限がなく、巨大ファイルを丸ごと data URL 化して state に保存できる可能性があった。
- 根拠: `IMAGE_WARN_BYTES`、`ATTACHMENT_WARN_BYTES`、`LOCAL_FILE_MAX_BYTES` を追加し、`_readImageFileAsDataUrl` / `_readAttachmentFileAsDataUrl` は FileReader 実行前に `_confirmLocalFileRead` で 100MB 超を拒否する。画像 25MB 超、添付ファイル 50MB 超では保存や HTML エクスポートが重くなる可能性を警告して続行確認する。境界値の unit / integration テストも追加済み。
- 現状: 巨大ローカル画像 / 添付ファイルは 100MB 超で state へ入らず、警告基準も画像と添付ファイルで分離されている。
- 影響: 解消済みのため、確認後に無制限の data URL を保存対象へ入れるリスクは抑制されている。
- 次の対応: なし。

## 19. テーブル行数 / 列数が正規化・UI操作で上限なしに増える

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 保存済み state や UI 操作でテーブルの `rows` / `cols` が大きくなった場合、描画時に全セルを同期生成して UI が固まる可能性がある。仮想スクロールなしの現実装では、最大 100 行・100 列・10,000 セルをハード上限にする方針にする。
- 根拠: `TABLE_MAX_ROWS = 100`、`TABLE_MAX_COLS = 100`、`TABLE_MAX_CELLS = 10000` と `_normalizeTableBlockShape` を追加し、`blk`、`normalizeStateShape`、`sanitizeBlocksDeep`、`renderTableBlock` で同じ上限に揃えた。行追加・列追加・Tab 末尾移動は `_addTableRow` / `_addTableColumn` 経由で上限超過時に止まる。境界値と上限超過 state の回帰テストも追加済み。
- 現状: 保存済み state、Markdown 由来 table、UI 操作のいずれでも 100 行・100 列・10,000 セルを超えない。
- 影響: 解消済みのため、巨大 table state による同期 DOM 生成の停止リスクは抑制されている。
- 次の対応: なし。

## 20. 重複したブロック ID が保存データ正規化で修復されない

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 保存済み state 内に同じ `block.id` を持つブロックが複数あると、編集・削除・フォーカスなどが意図しない先頭一致ブロックに作用する可能性がある。
- 根拠: `normalizeStateShape` の `normalizeBlocksDeep` はページ単位の `usedBlockIds` を再帰的に共有し、空 ID と重複 ID を `uid()` で再採番する。重複 ID を含む保存データの正規化、Markdown import の ID 一意性、duplicate 用 ID 再生成経路を回帰テストで確認している。
- 現状: 改変済み保存データや古い不整合データに重複 block id があっても、起動時正規化でページ内一意になる。
- 影響: 解消済みのため、重複 block id による編集・削除・フォーカス対象の取り違えリスクは抑制されている。
- 次の対応: なし。

## 21. Markdown 貼り付け判定が広すぎて通常テキストをブロック化する

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 通常のテキストブロックへ JSON 断片や `#tag` のような文字列を貼り付けた場合でも Markdown と誤判定され、現在位置へのテキスト挿入ではなくブロック置換または後続ブロック挿入になる可能性がある。
- 根拠: `looksLikeMarkdown` から広すぎる `^[{%#]` 判定を削除し、見出しは `# Heading` のような空白付き構文だけを Markdown とみなす。JSON 1行、`#tag`、`%memo` は false、見出し・リスト・テーブルは true になる unit / integration テストを追加した。
- 現状: 通常テキストの JSON 断片やタグ風メモは、既存ブロック内への plain text paste として扱われる。
- 影響: 解消済みのため、通常テキスト貼り付けが意図せずブロック化されるリスクは抑制されている。
- 次の対応: なし。

## 22. ブロック children の深いネストで再帰処理が停止し得る

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 保存済み state や埋め込み state に極端に深い `block.children` ネストが含まれると、起動時正規化・描画・検索・エクスポートなどの再帰処理で call stack 上限に達し、ノートを開けない可能性がある。
- 根拠: `BLOCK_MAX_DEPTH = 32` を追加し、`normalizeBlocksDeep` と `sanitizeBlocksDeep` で深すぎる children を切り離す。`parseMarkdownToBlocks`、`blocksToMarkdown`、`collectPageHeadings`、`findBlockPath`、render、`collectRemoteImageBlocks`、`flattenTextFromBlocks` も同じ上限前提で再帰を止める。上限超過 state の正規化・描画・検索・Markdown export の回帰テストも追加済み。
- 現状: 改変済み保存データや埋め込み state の極端な children ネストは起動時正規化で上限内に収まる。
- 影響: 解消済みのため、深いブロックネストによる call stack overflow リスクは抑制されている。
- 次の対応: なし。

## 23. Mermaid Gantt の巨大 duration でプレビュー描画が無限ループし得る

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: Mermaid Gantt ブロックに非常に大きい期間指定を入力すると、プレビュー生成中のループが終了しない可能性がある。
- 根拠: `_parseMermaidDurationDays` は有限性と `MERMAID_GANTT_MAX_DAYS` を検証し、`_renderMermaidGantt` も date range / `totalDays` の上限超過で fallback へ切り替える。tick 生成にも安全側の上限を設け、`renderMermaidDiagramPreview` は例外を捕捉して fallback preview を表示する。巨大 duration、巨大日付範囲、通常 Gantt の回帰テストも追加済み。
- 現状: Gantt の duration / totalDays が上限を超える場合は SVG 本描画に進まず、fallback preview が表示される。
- 影響: 解消済みのため、Mermaid Gantt 入力・Markdown import・保存済み state 表示で無限ループに入るリスクは抑制されている。
- 次の対応: なし。

## 24. ページ階層の深さに上限がなく、サイドバー描画や削除処理が再帰で落ち得る

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: ページの親子階層に深さ上限がなく、深い階層を持つデータでサイドバー描画、削除、復元、完全削除、複製が再帰的に実行される。
- 根拠: `PAGE_MAX_DEPTH = 32`を追加し、`normalizeStateShape`で上限を超える親子関係を切り離す。`createPage`とページメニューは上限超過の子ページ作成を防ぎ、サイドバー描画も上限で子の展開を止める。`deletePage`、`restorePage`、`purgePage`、`duplicatePage`は子ページ処理を反復処理へ変更し、複製時は残り深度を超える子孫をコピーしない。深いページ階層の正規化と lifecycle 操作の回帰テストも追加済み。
- 現状: 保存済み state、UI 作成、サイドバー描画、削除・復元・完全削除・複製でページ階層が32階層を超えて再帰的に処理されない。
- 影響: 解消済みのため、深いページ階層による最大コールスタック超過やサイドバー・ごみ箱操作停止のリスクは抑制されている。
- 次の対応: なし。

## 25. クリップボード貼り付けにサイズと生成ブロック数の上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: HTML、Markdown、プレーンテキストの貼り付け処理がクリップボード内容全体を同期的にサニタイズ・解析・挿入しており、入力サイズや生成ブロック数の上限がない。
- 根拠: `handlePlainTextLimitPaste` を追加し、code block と raw textarea 系ブロックに `CLIPBOARD_PASTE_MAX_BYTES` / `CLIPBOARD_PASTE_MAX_LINES` / `RAW_TEXT_BLOCK_MAX_BYTES` を適用している。警告ダイアログを挟む paste でも `currentTarget` を保持して挿入先を失わず、拒否時は DOM と `block.content` を変更しない。integration テストで 1 MiB ちょうどの code paste、1 MiB+1 の raw paste 拒否、2000行超過拒否、拒否時の state / DOM 維持を確認済み。
- 現状: 通常 rich block、page title、document name、code block、raw textarea 系の貼り付けは共通上限を通る。
- 影響: 解消済みのため、巨大なコード・raw HTML・Mermaid 等の貼り付けが上限を迂回して state や undo 履歴を肥大化させるリスクは抑制されている。
- 次の対応: なし。

## 26. Mermaidプレビューの要素数に上限がなく、巨大図で同期SVG生成が重くなり得る

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: MermaidプレビューはGanttの日数上限だけを制限しており、Flowchart、Sequence、ER、Gantt、Stateの行数・ノード数・エッジ数・タスク数には上限がない。
- 根拠: `MERMAID_SOURCE_MAX_BYTES = 64 KiB`、`MERMAID_MAX_LINES = 500`、`MERMAID_MAX_NODES = 200`、`MERMAID_MAX_EDGES = 400`、`MERMAID_MAX_GANTT_TASKS = 200`、`MERMAID_MAX_SVG_ELEMENTS = 1000`を追加した。各 Mermaid レンダラは入力サイズ・行数・ノード相当・エッジ相当・タスク数を検査し、超過時は `renderMermaidDiagramPreview` の fallback 表示へ切り替える。巨大 source / Flowchart / Sequence / Gantt の回帰テストも追加済み。
- 現状: Mermaid プレビューは巨大入力や過剰要素を同期 SVG 生成へ進めず、簡易表示にフォールバックする。
- 影響: 解消済みのため、大量 Mermaid 入力によるプレビュー生成停止リスクは抑制されている。
- 次の対応: なし。

## 27. Markdown インポートに生成ブロック数の上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: Markdown ファイル import は 2MB の入力サイズ上限だけで、parse 後に生成されるブロック数や行数の上限を確認していない。小さめのファイルでも大量の見出し・リスト・表行を含むと、多数のブロックや table DOM を同期生成して UI が固まる可能性がある。
- 根拠: `MARKDOWN_IMPORT_MAX_LINES = 5000`、`MARKDOWN_IMPORT_MAX_BLOCKS = 1000`、`MARKDOWN_IMPORT_MAX_TABLE_CELLS = 10000` を追加し、`readMarkdownImportFile` が parse 前に入力サイズ・行数を拒否する。`importMarkdownAsNewPage` は parse / sanitize 後に `_markdownImportBlocksLimitViolation` で生成ブロック数とファイル全体の table cell 数を検査し、超過時はページ作成前に中断する。1000ブロック成功、1001ブロック拒否、5000行超過、table cell超過の integration テストを追加済み。
- 現状: Markdown import は入力量と生成量の両方を state / DOM 反映前に制限する。
- 影響: 巨大または機械生成 Markdown による過剰な同期描画・保存データ肥大化リスクは抑制されている。
- 次の対応: なし。

## 28. DB仕様ブロックの columns に上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `db_table` 仕様ブロックの `columns` 配列は保存データ正規化と UI 操作のどちらでも行数上限がなく、巨大な columns を持つ state や連続追加操作で大量の入力欄を同期描画する可能性がある。
- 根拠: `SPEC_COLUMNS_MAX_ROWS = 200` を追加し、`_ensureSpecBlockShape` と `_parseSpecColumnsFromMarkdown` が `db_table.columns` を200件までに制限する。`_renderSpecColumns` は200件到達時に追加ボタンを disabled にし、`_addSpecColumn` が追加処理側でも二重に guard する。200件保持、201件以上の切り詰め、helper guard、UI disabled の unit / integration テストを追加済み。
- 現状: 保存済み state、Markdown 由来、UI 操作のいずれでも DB仕様ブロックの columns は200件を超えない。
- 影響: DB仕様ブロック表示時の過剰な同期DOM生成と保存データ肥大化リスクは抑制されている。
- 次の対応: なし。

## 29. HTML sanitizer が DOM 深さに対して再帰し続ける

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: `sanitizeHTML` は HTML DOM を再帰的に走査しており、保存済み state や Markdown import 由来の block content に極端に深い HTML ネストが含まれると、起動時正規化や import 中に call stack 上限へ達する可能性がある。`BLOCK_MAX_DEPTH` は block.children の深さだけを制限しており、block.content 内の HTML DOM 深さは制限していない。
- 根拠: `sanitizeHTML` は `walk(child)` の直接再帰を使わず、明示 stack と同一親ループで DOM を反復走査する実装になった。危険タグ削除、未知タグ unwrap、属性検査、テキスト制御文字除去は従来どおり適用される。深い HTML content を含む state 正規化テストも追加済み。
- 現状: 深い HTML 断片を含む保存データや import データでも、JS再帰による call stack overflow を起こさず sanitize できる。
- 影響: 改変済み保存データや外部 Markdown による起動・インポート停止リスクは抑制されている。
- 次の対応: なし。

## 30. index.html の配布用 LeafNote ソースが本体と同期していない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: ランディングページの `Copy SourceCode` が返す埋め込み LeafNote ソースが、現在の `LeafNote.html` と一致していない。ユーザーが `index.html` からコピーした場合、修正済みの不具合や最新の制御が入っていない古い本体を配布・利用する可能性がある。
- 根拠: `index.html` の `leafnote-source` を現在の `LeafNote.html` から再生成し、script-data内で問題になる `</script` は JSON 文字列上で `<\/script` にエスケープした。`tests/run-browser.mjs` に `index embedded LeafNote source matches LeafNote.html` を追加し、`JSON.parse(leafnote-source)` と `LeafNote.html` の完全一致を確認している。
- 現状: `LeafNote.html` を直接開く経路と、`index.html` からコピーする経路の本体ソースは一致している。
- 影響: ランディングページ経由で古い本体が配布されるリスクは解消されている。
- 次の対応: なし。

## 31. 保存済み data URL の読み込み時サイズ上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 保存済み state や埋め込み state に巨大な `data:` URL が含まれている場合、起動時正規化では画像 URL や添付ファイル data URL のサイズを制限しない。UI から追加するローカルファイルには 100MB 上限があるが、改変済み保存データや共有 HTML から入る data URL には同等の上限がない。
- 根拠: `_parseDataUrl`、`_estimateDataUrlDecodedBytes`、`_isDataUrlWithinSizeLimit`、`_normalizeFileDataUrl` を追加し、base64本文は `atob` 前に文字数から推定デコードサイズを検査する。`normalizeImageUrl`、`normalizeStateShape`、`sanitizeBlocksDeep`、`_applyFileToBlock`、`_dataUrlToBlob` は `LOCAL_FILE_MAX_BYTES` 基準の validator を通す。画像 data URL、fileDataUrl、download前の上限超過を確認する unit テストを追加済み。
- 現状: 保存済み state / 埋め込み state / import 由来の巨大 data URL は読み込み時に空値化または download 前に拒否される。
- 影響: 改変済み HTML や巨大保存データによる起動・描画・保存・download時のメモリ急増リスクは抑制されている。
- 次の対応: なし。

## 32. 最大深度の toggle に子ブロックを追加できる

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `BLOCK_MAX_DEPTH` 到達済みの toggle ブロックでも、空の子リスト用ヒントや Enter 操作から子ブロックを追加できる。追加された子は `renderToggleBlock` の `depth < BLOCK_MAX_DEPTH` 条件で描画されず、ユーザーから見えない state として保存される。
- 根拠: `renderToggleBlock` と `handleBlockKeydown` に depth を渡し、`_canAddToggleChildAtDepth` / `_insertToggleChildBlock` で `depth < BLOCK_MAX_DEPTH` の場合だけ state に子ブロックを追加するようにした。最大深度では空ヒントを表示せず、Enter は不可視 child ではなく通常の兄弟ブロック挿入へ進む。最大深度で子が増えないこと、最大未満では従来どおり追加できることを integration テストで確認している。
- 現状: UI 操作でも最大深度 toggle に不可視の子ブロックは作成されない。
- 影響: 最大深度付近のアウトライン編集で入力内容が見えない state として保存されるリスクは解消されている。
- 次の対応: なし。

## 33. 保存済み state のページ数に上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 保存済み state や埋め込み state に大量のページが含まれている場合、起動時正規化とサイドバー描画が全ページを同期処理する。ページ階層の深さ上限はあるが、ページ総数の上限はない。
- 根拠: `PAGE_MAX_COUNT = 1000` を追加し、`normalizeStateShape` はページ本文の正規化前に保持対象ページを決定する。保持順は `currentPageId` の祖先・子孫、`rootPages` の表示順、`updatedAt` の新しいページ順で、上限超過時は `rootPages`、`children`、`parentId`、`currentPageId` を既存の整合処理で再構築する。切り捨ては `normalized.lossyRepair` と `repair.trimmedPages` に記録される。ページ上限超過 state の保持優先度、参照整合、サイドバー描画の回帰テストも追加済み。
- 現状: 改変済み localStorage / IndexedDB / 共有 HTML からページ数の多い state が入っても、正規化後のページ数は上限内に収まり、サイドバー描画も上限内のページだけを対象にする。
- 影響: 大量ページ state による起動時・サイドバー表示時の過剰な同期処理リスクは抑制されている。切り捨てを伴う修復は起動直後の自動保存・終了時同期保存では永続化せず、ユーザーに専用警告を表示する。
- 次の対応: なし。

## 34. 保存済み state のページ内ブロック数に上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 保存済み state や埋め込み state の 1 ページ内に大量のブロックが含まれている場合、起動時正規化とエディタ描画が全ブロックを同期処理する。ブロックの深さ上限、Markdown import 上限、clipboard paste 上限はあるが、保存済み state のブロック総数上限はない。
- 根拠: `BLOCK_MAX_COUNT_PER_PAGE = MARKDOWN_IMPORT_MAX_BLOCKS` を追加し、保存済み state の `normalizeBlocksDeep` にページ単位の残り予算を渡す。top-level sibling と nested children は同じ予算を preorder で消費し、上限到達後の raw block は sanitize / DOM 生成前に切り捨てる。切り捨ては `normalized.lossyRepair`、`repair.trimmedBlocks`、`repair.blockTrimmedPageIds` に記録される。横に広い sibling と children が混在する上限超過 state、current page の描画、検索テキスト抽出、Markdown export の回帰テストも追加済み。
- 現状: localStorage / IndexedDB / 共有 HTML から読み込む既存データでも、1ページあたりのブロック総数は上限内に正規化される。保持ブロックは従来どおり ID 一意性、深度、table / file / image などの正規化を受ける。
- 影響: 改変済み保存データや巨大な共有 HTML による起動・正規化・エディタ描画時の UI 停止やメモリ急増リスクは抑制されている。切り捨てを伴う修復は起動直後の自動保存・終了時同期保存では永続化せず、ユーザーに専用警告を表示する。
- 次の対応: なし。

## 35. ガバナンスブロック本文の keydown で未定義変数を参照する

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: Decision / Requirement / Open Question などのガバナンスブロック本文でキー操作を行うと、keydown ハンドラが未定義の `depth` を参照し、ショートカット、Enter 分割、Backspace 結合などのキー操作が例外で止まる可能性がある。
- 根拠: `renderBlock` が `renderGovernanceBlock(block, el, parentList, depth)` を呼び、`renderGovernanceBlock` 側も `depth = 0` を受け取って `handleBlockKeydown` へ渡す。ガバナンス本文の keydown テストは `window.error` を捕捉し、イベントリスナー例外が出た場合に失敗する。
- 現状: ガバナンスブロック本文でも通常ブロックと同じ keydown 経路が例外なく動作する。
- 影響: 未定義変数参照によるガバナンスブロック編集停止リスクは解消されている。
- 次の対応: なし。

## 36. UI から PAGE_MAX_COUNT を超えるページを作成できる

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 読み込み時のページ数上限はあるが、通常のページ作成 UI と `createPage` には `PAGE_MAX_COUNT` 到達時の作成拒否がない。そのためユーザー操作で 1000 ページを超える state を保存でき、次回起動時に lossy repair でページが切り捨てられる可能性がある。
- 根拠: `canCreatePage` / `assertPageCapacity` を追加し、`createPage`、子ページ追加、検索からの作成、Markdown import、`duplicatePage` を同じ判定に通す。判定対象は `normalizeStateShape` と同じくゴミ箱内を含む `state.pages` 総数で、複製は追加予定サブツリー数を事前に数える。新規ページボタンと子ページ追加メニューは上限時に disabled になる。
- 現状: 通常UI、Markdown import、複製のいずれも `PAGE_MAX_COUNT` 超過時は state を変更せず、ユーザーへ上限到達を通知する。
- 影響: UI操作で1000ページ超の保存状態を作り、次回起動時にページが切り捨てられるリスクは抑制されている。
- 次の対応: なし。

## 37. UI から BLOCK_MAX_COUNT_PER_PAGE を超えるブロックを作成できる

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 保存済み state の読み込み時にはページ内ブロック数を 1000 件へ切り詰めるが、通常編集のブロック追加・Enter 分割・複製にはページ単位の残り予算チェックがない。ユーザー操作で 1 ページ 1000 ブロックを超える state を保存でき、次回起動時に末尾ブロックが lossy repair で切り捨てられる可能性がある。
- 根拠: `countBlocksForPage` / `canInsertBlocks` / `assertBlockCapacity` を追加し、`insertBlockAfter`、toggle child 挿入、ブロック追加メニュー、Enter 分割、ブロック複製、Markdown paste、複数行 plain text paste、画像・添付ファイルの新規ブロック挿入を同じページ単位の総数判定に通す。上限時は挿入前に通知し、直接 `splice` する経路も事前に guard している。
- 現状: 通常編集や貼り付けで1ページ1000ブロックを超える追加は state 変更前に拒否される。toggle children は深さ上限と件数上限の両方を満たす場合だけ追加される。
- 影響: UI操作でページ内ブロック数が読み込み時上限を超え、次回起動時に末尾ブロックが切り捨てられるリスクは抑制されている。
- 次の対応: なし。

## 38. Markdown 貼り付けの生成 table cell 総数に上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: Markdown 貼り付けでは入力サイズ・行数・生成ブロック数は検査されるが、生成される table cell の総数は検査されない。複数の大きな table を含む Markdown を貼り付けると、各 table は 100 行・100 列に正規化されても、ページ全体では大量の cell DOM を同期生成できる。
- 根拠: `handleBlockPaste` の Markdown auto-conversion 経路で `parseMarkdownToBlocks(text)` / `sanitizeBlocksDeep(newBlocks)` 後に `_countTableCellsDeep(newBlocks, MARKDOWN_IMPORT_MAX_TABLE_CELLS)` を実行し、`_confirmClipboardPasteWithinLimits` が `tableCellCount` 超過を `dialog.pasteTooManyTableCells` で拒否する。10,000 cell 境界と上限超過時 state 不変の integration テストを追加済み。
- 現状: Markdown import と Markdown paste のどちらも table cell 総数 10,000 件を超える入力を state 反映前に拒否する。
- 影響: 解消済みのため、Markdown paste だけで多数 table cell DOM を同期生成するリスクは抑制されている。
- 次の対応: なし。

## 39. HTML 保存時のリモート画像インライン化件数に上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: HTML 保存時にリモート画像を data URL 化する処理は、画像ごとの timeout とサイズ上限はあるが、処理対象の画像件数に上限がない。リモート画像ブロックが多数ある state では保存操作が長時間戻らない可能性がある。
- 根拠: `REMOTE_IMAGE_INLINE_MAX_COUNT = 50` を追加し、`inlineRemoteImagesForExport(s, { limit })` は処理対象を上限件数までに制限して `skipped` / `limited` を返す。HTML 保存時は上限超過を事前確認し、「先頭50件を埋め込む」または「リンクのまま保存」を選べる。上限超過時に fetch が上限内で止まる unit テストと、リンク保持時に外部画像 fetch が走らない export integration テストを追加済み。
- 現状: 少数件は従来どおり取り込み、多数件はユーザー選択後に上限件数まで、または0件だけを処理する。
- 影響: 解消済みのため、多数リモート画像を含む state で HTML 保存が全件逐次 fetch し続けるリスクは抑制されている。
- 次の対応: なし。

## 40. Markdown export の HTML inline 変換が深い DOM に再帰する

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: Markdown export / 選択ブロックコピーで使う `htmlToMarkdownInline` が DOM を再帰的に走査するため、保存済み state や貼り付け由来の block content に深い許可タグのネストが含まれると、Markdown 変換時に call stack 上限へ達する可能性がある。
- 根拠: `htmlToMarkdownInline` は明示 stack の post-order 走査へ変更され、`HTML_TO_MARKDOWN_MAX_DOM_DEPTH`、`HTML_TO_MARKDOWN_MAX_DOM_NODES`、`HTML_TO_MARKDOWN_MAX_OUTPUT_CHARS` を超えた場合は対象 inline を `textContent` ベースの plain text に fallback する。深い DOM fallback と通常 inline 変換の unit テストを追加済み。
- 現状: Markdown export / 選択ブロックコピーで深い HTML inline を処理しても JS 再帰で call stack overflow しない。
- 影響: 解消済みのため、深くネストした block content による Markdown 変換失敗リスクは抑制されている。
- 次の対応: なし。

## 41. 保存済み themeCustom の accent が CSS 値として未検証のまま適用される

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 保存済み state や埋め込み state の `themeCustom.accent` / `accentDark` が色値として正規化されず、そのまま CSS カスタムプロパティへ入る。改変済み共有 HTML から不正な CSS 値を渡されると、表示崩れや外部 URL 参照を含む CSS 値の適用につながる可能性がある。
- 根拠: `normalizeThemeCustom` と `normalizeThemeHexColor` を追加し、`accent` / `accentDark` は `#rrggbb` のみ、`pageWidth` と `fontFamily` は既存 map の key のみ保持する。`normalizeStateShape`、`sanitizeStateInPlace`、`applyThemeCustom`、`renderThemeCustomizer` は同じ正規化関数を通る。改変 state の不正 accent / enum 値破棄と適用直前 guard の unit テストを追加済み。
- 現状: 保存済み state / 共有 HTML 由来の不正な themeCustom 値は破棄され、CSS カスタムプロパティには検証済み hex 色だけが入る。
- 影響: 解消済みのため、不正な CSS 値によるテーマ崩れや外部 URL 参照評価リスクは抑制されている。
- 次の対応: なし。

## 42. 検索が全ページ全ブロックを入力ごとに同期走査する

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 検索欄の入力ごとに、全ページの全ブロック本文を同期的に flatten して検索する。ページ数とページ内ブロック数はそれぞれ上限内でも最大 1000 ページ × 1000 ブロックまであり、検索入力のたびに大量の文字列生成と DOM 結果生成が走る可能性がある。
- 根拠: `SEARCH_INPUT_DEBOUNCE_MS`、`SEARCH_MAX_RESULTS`、`SEARCH_MAX_SCANNED_PAGES`、`SEARCH_MAX_SCANNED_BLOCKS` を追加し、入力は `scheduleSearchResults` で debounce する。`collectSearchMatches` は title match を先に処理し、body flatten は `flattenTextFromBlocksWithinBudget` でページ数・ブロック数予算内だけ実行する。予算到達時は部分結果と `search.limited` 表示に切り替える。結果上限・body scan 予算・検索 UI の回帰テストを追加済み。
- 現状: 通常検索でも結果件数と本文走査量に上限があり、連続入力では古い予約描画が新しい検索結果を上書きしない。
- 影響: 解消済みのため、大きなノートセットで検索入力ごとに全ページ全ブロックを同期 flatten するリスクは抑制されている。
- 次の対応: なし。

## 43. ブロック drag 移動で深さ上限を超える子孫を持つ state を作れる

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: ブロックの drag 移動では、移動先の深さと移動する subtree の深さを検査しない。子ブロックを持つブロックを深い nested list 内へ移動すると、`BLOCK_MAX_DEPTH` を超える子孫が state に残り、描画されない子ブロックや次回読み込み時の切り捨てにつながる可能性がある。
- 根拠: `findBlockAndList` が depth を返すようになり、`_blockSubtreeHeight`、`_blockContainsId`、`canMoveBlockWithinDepthLimit` を追加した。`moveBlock` 本体は `target.depth + subtreeHeight <= BLOCK_MAX_DEPTH` の場合だけ splice し、上限超過時は `dialog.blockDepthLimitReached` を表示して state を変更しない。drag drop UI も `moveBlock` 成功時だけ再描画する。子持ちブロックの最大深度移動拒否と子なしブロックの境界移動成功を integration テストで確認済み。
- 現状: 既存 subtree の drag 移動でも block children 深さ上限を超える state は作れない。
- 影響: 解消済みのため、ドラッグ操作で不可視子ブロックや次回起動時の lossy repair を誘発するリスクは抑制されている。
- 次の対応: なし。

## 44. undo stack が巨大 state snapshot を最大100件保持し得る

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: undo 履歴は件数上限だけで、snapshot 文字列のサイズや合計保持量に上限がない。大きな添付ファイルや画像 data URL を含む state で編集を繰り返すと、巨大な JSON 文字列が undo stack に複数保持される。
- 根拠: `UNDO_MAX_SNAPSHOT_BYTES` と `UNDO_MAX_TOTAL_BYTES` を追加し、undo / redo への snapshot 登録を `_pushUndoStackSnapshot` / `_pushRedoStackSnapshot` 経由に統一した。1件上限を超える snapshot は積まず、合計上限を超える場合は古い snapshot を削る。巨大 snapshot をスキップした場合は保存ステータスで一度だけ通知する。unit テストで上限超過 snapshot のスキップと合計 byte 上限による trim を確認済み。
- 現状: undo / redo stack は件数上限に加えて byte 上限でも管理される。
- 影響: 解消済みのため、大きな file / image block を含む状態で編集を続けても undo 履歴だけが無制限にメモリを消費するリスクは抑制されている。
- 次の対応: なし。

## 45. 保存済み単一テキスト値にサイズ上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 保存済み state や埋め込み state の page title、workspaceName、block.content、caption、table cell、spec field などの単一文字列に長さ上限がない。ページ数・ブロック数上限内でも、1フィールドだけが巨大な場合に起動時正規化・描画・検索・export が重くなる。
- 根拠: `TEXT_FIELD_MAX_CHARS`、`RICH_HTML_FIELD_MAX_BYTES`、`RAW_TEXT_BLOCK_MAX_BYTES` に用途別 helper（`_normalizePageTitleInput`、`_normalizeRichEditableContent`、`_normalizeUrlTextField` など）を集約した。`normalizeStateShape` / `sanitizeStateInPlace` に加えて、`createPage`、ページタイトル、document name、rich block、table cell、image caption、definition list、governance/spec field、image URL、page icon、code language の入力・読み込み経路でも同じ上限を適用する。上限超過時は DOM と state を同期し、編集経路では切り詰め通知を出す。unit テスト `state normalization caps oversized single text fields before render` と integration テスト `single text field limits sync interactive DOM edits and page creation` で確認済み。
- 現状: 保存済み state と通常編集・作成経路の単一文字列は上限内に丸められ、rich 編集でも表示 DOM と保存 state が同じ内容になる。
- 影響: 解消済みのため、単一フィールドだけが巨大化して起動・描画・検索・export を重くするリスクと、DOM / state 不一致による再読み込み時の予期しない欠落リスクは抑制されている。
- 次の対応: なし。

## 46. 選択ブロック cut がクリップボード失敗時にも削除する

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: 選択ブロックの cut 処理でクリップボード書き込みが失敗しても、選択ブロックを削除する経路が残っている。
- 根拠: `_setLeafNoteClipboardData` が `text/plain` / `text/markdown` / `application/x-leafnote-markdown` の設定成功可否を返すようになり、cut イベントは書き込み成功時だけ `deleteBlock` に進む。全形式の `setData` が throw する場合は `dialog.clipboardCutFailed` を表示し、選択状態とブロック state を維持する。integration テスト `block selection clipboard event failures do not delete selected blocks` で copy 失敗通知と cut 未削除を確認済み。
- 現状: Clipboard API fallback 経路と DOM cut イベント経路の両方で、クリップボード書き込み失敗時にブロックを削除しない。
- 影響: 解消済みのため、選択ブロック cut によるクリップボード未保存のデータ消失リスクは抑制されている。
- 次の対応: なし。

## 47. Markdown export / 選択コピーの生成 Markdown 総量に上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: ページ Markdown export と選択ブロック copy / cut が、生成される Markdown 全体の byte 数やブロック数を確認せず同期的に文字列化する。
- 根拠: `blocksToMarkdown` / `blockToMarkdown` は共有 byte budget を使い、親ブロック本文、子ブロック、区切り改行、table 行、raw/code fenced 出力を同じ残量から消費する。子ブロックの `blocksToMarkdown` 呼び出しにも同じ budget が渡るため、ネストした subtree でも `MARKDOWN_EXPORT_MAX_BYTES` / `CLIPBOARD_COPY_MAX_BYTES` 超過時は生成途中で `MARKDOWN_SIZE_LIMIT` になる。`_downgradeLowPriorityBlock` も `RICH_HTML_FIELD_MAX_BYTES` の budget 内で互換 Markdown 化し、超過時は元本文への fallback に切り替える。unit テスト `markdown serialization shares nested byte budgets and avoids fence collisions` と integration テスト `markdown export and selection clipboard limits reject oversized payloads safely` にネスト subtree の境界・拒否ケースを追加済み。
- 現状: top-level だけでなくネストした子ブロック subtree でも、Markdown export / 選択 copy / cut の生成量は共有 byte budget で制限される。
- 影響: 大量または大きな子ブロックを持つ list / toggle などを Markdown export、選択 copy / cut しても、上限超過時は既存通知を出して中断し、cut はブロックを削除しない。
- 次の対応: なし。

## 48. ローカル画像・添付 data URL の合計保存量に上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: ローカル画像と添付ファイルは1ファイル100MBの上限はあるが、state 全体に保存できる data URL の合計量には上限がない。
- 根拠: `LOCAL_EMBEDDED_DATA_TOTAL_MAX_BYTES` と `LOCAL_EMBEDDED_DATA_WARN_BYTES` を追加し、`_estimateLocalEmbeddedDataTotalBytes`、`_confirmLocalEmbeddedDataAllowance`、`_enforceLocalEmbeddedDataTotalLimit` で画像 data URL と添付 `fileDataUrl` の decoded bytes を合算するようにした。画像・添付の追加/置換前に予測合計を確認し、警告域は確認、上限超過は拒否する。読み込み・sanitize 時の超過 state は data URL を切り詰め、lossy repair として扱う。unit テスト `local embedded data total helpers estimate, warn, and trim excess data URLs` と既存のローカルファイル上限テストで確認済み。
- 現状: state 全体のローカル埋め込み data URL 合計は警告・拒否・読み込み時修復の対象になり、ブラウザ quota 超過まで無制限に増やせない。
- 影響: 解消済みのため、複数の大きな画像・添付による保存失敗、HTML export 巨大化、起動遅延、localStorage fallback 失敗のリスクは抑制されている。
- 次の対応: なし。

## 49. コードブロックのコピーが Clipboard API 失敗時に例外で止まる

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: コードブロック右上のコピー操作が `navigator.clipboard.writeText` を存在確認・例外処理なしで直接呼び出しており、`file://`、非セキュアコンテキスト、権限拒否、Clipboard API 不在の環境でクリック時に実行時エラーになる可能性がある。
- 根拠: `renderCodeBlock` の `.code-copy-btn` click handler を `async` 化し、`_writeClipboardTextFallback` 経由で Clipboard API、hidden textarea + `document.execCommand('copy')` fallback、失敗通知を扱うようにした。失敗時は `dialog.codeCopyFailed` を表示し、ボタンの disabled / 表示状態を戻す。integration テスト `code block copy falls back and reports failure without throwing` で Clipboard API 拒否時の fallback と完全失敗時の通知を確認済み。
- 現状: コードブロックコピーは Clipboard API 不在・拒否でも未処理例外にならず、fallback または通知に進む。
- 影響: 解消済みのため、file:// や権限拒否環境でコピー操作が壊れたままになるリスクは抑制されている。
- 次の対応: なし。

## 50. IPv4-mapped IPv6 のローカル画像URLが export fetch 制限をすり抜ける

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: HTML保存時のリモート画像インライン化は private / local network URL を fetch しない方針だが、`http://[::ffff:127.0.0.1]/...` のような IPv4-mapped IPv6 literal が `new URL()` で `::ffff:7f00:1` 形式へ正規化されると、現在の `isPrivateNetworkUrl` が private 判定できない。
- 根拠: `_expandIPv6Address` と `_ipv4OctetsFromMappedIPv6Hostname` を追加し、`::ffff:7f00:1`、`::ffff:a00:1`、`::ffff:c0a8:1` などの hex 表記を IPv4 octet へ戻して `_isPrivateIPv4Octets` に通すようにした。unit テスト `network image URL policy rejects private and IPv4-mapped local targets` と `remote image export refuses private and local network fetch targets` で mapped loopback / private は fetch されず、public mapped IPv6 は許可されることを確認済み。
- 現状: IPv4-mapped IPv6 literal でも loopback / private IPv4 宛は export fetch 前に拒否される。
- 影響: 解消済みのため、改変済み state 経由でローカルホストやプライベートネットワークへ fetch するリスクは抑制されている。
- 次の対応: なし。

## 51. private/local 画像URLが通常表示で自動ロードされる

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 画像ブロックの通常表示では private / local network URL を拒否せず、保存済み state、Markdown import、URL 入力から入った `http://127.0.0.1/...` や `http://192.168.1.20/...` の画像 URL が `<img src>` として自動ロードされる。
- 根拠: `normalizeImageUrl` が `isPrivateNetworkUrl` を呼ぶようになり、保存済み state、Markdown import、URL picker、render の各経路で private / local / localhost / loopback / link-local 画像 URL を空値化または拒否する。unit テスト `network image URL policy rejects private and IPv4-mapped local targets` で private URL が state に残らず `<img src>` にならないこと、public URL は維持されることを確認済み。
- 現状: 通常表示でも private/local 画像 URL は画像ブロックの `src` に設定されない。
- 影響: 解消済みのため、ノート表示時にユーザー操作なしで内部ネットワークへ画像 GET が発生するリスクは抑制されている。
- 次の対応: なし。

## 52. HTML保存時の自己HTML取得に timeout / size cap / 本体検証がない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: HTML保存時に現在ページのHTMLを `fetch(window.location.href)` で再取得するが、timeout、レスポンスサイズ上限、`res.ok`、取得内容が LeafNote 本体かどうかの検証がない。
- 根拠: `fetchSelfHtmlForExport`、`readResponseTextWithLimit`、`isLeafNoteSourceHtmlForExport`、`getSourceHtmlForExport` を追加し、自己HTML取得は 5秒 timeout、4MB 上限、`res.ok`、`Content-Type`、`embedded-state` / `export-btn` / `blocks` / LeafNote 本体要素の検証を通った場合だけ採用する。失敗時は `saveStatus.exportSourceFallback` を表示し、現在の `document.documentElement.outerHTML` に fallback する。unit テスト `self HTML export source fetch validates body, size, and timeout before adoption` と既存 self-contained HTML export integration で確認済み。
- 現状: 404、ログインHTML、巨大レスポンス、遅延レスポンス、LeafNote本体でないHTMLは保存元テンプレートとして採用されない。
- 影響: 解消済みのため、別HTMLに state を埋め込んだ壊れた自己完結HTMLや、遅延・巨大レスポンスによる保存停止リスクは抑制されている。
- 次の対応: なし。

## 53. PAGE_MAX_COUNT 到達時に最後のライブページを削除すると削除済みページが current に残る

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: `PAGE_MAX_COUNT` 到達済みで、ライブページが最後の1件だけの状態からそのページをゴミ箱へ移動すると、代替ページ作成が上限判定で失敗し、`currentPageId` が削除済みページを指したまま残る可能性がある。
- 根拠: `_getMovePageToTrashPlan` と `canMovePageToTrash` を追加し、削除対象 subtree を除く live page がない場合は、代替ページを作れる容量があるかを state 変更前に判定する。容量がない場合は `dialog.lastLivePageDeleteBlocked` を表示してゴミ箱移動を拒否する。`deletePage` は成功可否を返し、ページメニューは成功時だけ再描画する。`renderEditor` も deleted current page を描画しないよう補正した。unit テスト `last live page trash move keeps a live current page at page capacity` で、999件ゴミ箱 + 1件 live の拒否、998件ゴミ箱 + 1件 live の代替作成、複数 live の current 移動を確認済み。
- 現状: ゴミ箱移動後も live current page が残る不変条件が守られ、容量が足りない場合は削除前に拒否される。
- 影響: 解消済みのため、削除済みページが通常エディタに残る整合性崩れは抑制されている。
- 次の対応: なし。

## 54. Markdown export のコードフェンスが本文中フェンスで壊れる

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: コードブロックや Mermaid ブロックの本文に ````` ``` ````` や `~~~` のようなフェンス行が含まれると、Markdown export / 選択 copy / cut で生成される fenced code block が途中で閉じ、再インポートや貼り付け時に本文が分割・欠落する可能性がある。
- 根拠: `_markdownFenceForContent` / `_fencedCodeBlockMarkdown` を追加し、`code` と `mermaid` は本文中の backtick / tilde 連続数より長い fence を選んで出力する。`parseMarkdownToBlocks` の閉じ fence 判定も、開始 fence と同じ種類かつ開始長以上の fence 行だけを閉じ扱いするようにした。unit テスト `markdown serialization shares nested byte budgets and avoids fence collisions` と integration テスト `block selection copy and cut preserve fenced code payloads` で、本文中に ````` ``` `````、```` ```` ``` ````、`~~~` / `~~~~` を含む code / mermaid の round trip と copy / cut payload を確認済み。
- 現状: Markdown export / 選択 copy / cut は、本文中の fence 行と衝突しない fenced code block を生成する。
- 影響: コード例の中に Markdown fenced block を含めても、再インポートや貼り付け時にコード本文が通常ブロックへ分割されにくくなり、データ再現性が保たれる。
- 次の対応: なし。

## 55. Markdown export のインラインコードが本文中バッククォートで壊れる

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: インラインコード内にバッククォートを含むテキストを Markdown export / 選択 copy / cut すると、生成 Markdown のインラインコード区切りと本文中バッククォートが衝突し、再インポートや貼り付けで inline code の範囲が崩れる可能性がある。
- 根拠: `htmlToMarkdownInline` の `<code>` 変換を `_markdownInlineCodeSpan` 経由にし、本文中の最長 backtick run より長い delimiter を選ぶようにした。先頭/末尾が backtick または空白の場合は内側に padding space を入れ、`markdownToHtmlInline` は `_replaceMarkdownCodeSpans` で同じ長さの closing delimiter を探して padding を復元する。unit テスト `markdown inline conversion escapes delimiter collisions` で `` ` `` / `` `` `` を含む inline code の round trip を確認済み。
- 現状: rich text 内の inline `<code>` は本文中 backtick と衝突しない Markdown に直列化され、再 import / paste で `<code>` と本文が保たれる。
- 影響: 解消済みのため、inline code の一部が通常テキストとして解釈されるリスクは抑制されている。
- 次の対応: なし。

## 56. Markdown export のインラインリンクが `]` / `)` を含む本文や URL で壊れる

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: リンクテキストに `]`、リンク URL に `)` や空白を含む inline link を Markdown export / 選択 copy / cut すると、生成 Markdown のリンク区切りと本文・URL が衝突し、再インポートや貼り付けでリンク範囲や URL が崩れる可能性がある。
- 根拠: link text は `_escapeMarkdownBracketText` で `[` / `]` / `\` を escape し、URL は `_markdownLinkDestination` で空白・括弧・angle を含む場合に `<...>` destination へ逃がす。`markdownToHtmlInline` は regex ではなく `_mdParseBracketedLinkAt` / `_parseMarkdownLinkDestination` で escaped label と angle destination を parse する。unit テスト `markdown inline conversion escapes delimiter collisions` で `]` / `[` / `\` を含む text と、空白・`)`・query/hash を含む URL の round trip を確認済み。
- 現状: HTML inline link は Markdown delimiter と衝突しにくい形で export され、再 import / paste で link text と href が保たれる。
- 影響: 解消済みのため、リンク範囲や URL が途中で切れるリスクは抑制されている。
- 次の対応: なし。

## 57. Markdown export の画像 caption が `]` を含むと画像ブロックとして戻らない

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 画像ブロックの caption に `]` を含むテキストがあると、Markdown export / 選択 copy / cut で生成される `![alt](url)` の alt 部分が壊れ、再インポートや貼り付け時に画像ブロックとして復元されない可能性がある。
- 根拠: `blockToMarkdown` の `image` 分岐は caption を `_escapeMarkdownBracketText` に通し、URL も `_markdownLinkDestination` で出力する。`_mdExtractImage` は `_mdParseBracketedLinkAt(..., { image: true })` に置き換え、escaped bracket / backslash と angle destination を復元する。unit テスト `markdown serialization preserves escaped text markers and image captions` と integration テスト `block selection copy and cut preserve markdown delimiter literals` で `[` / `]` / `\` を含む caption の export / parse / copy / cut を確認済み。
- 現状: 角括弧や backslash を含む caption でも、Markdown export / 選択 copy / cut 後に画像ブロックとして復元される。
- 影響: 解消済みのため、caption delimiter collision による画像の通常テキスト化リスクは抑制されている。
- 次の対応: なし。

## 58. Markdown export の通常テキストがブロック記法へ変化し得る

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 通常テキストブロックの本文に `# 見出し`、`- item`、`![alt](url)`、`| a | b |` など Markdown のブロック開始記法に見える行が含まれると、Markdown export / 選択 copy / cut 後の再インポートや貼り付けで、元の text block ではなく heading / list / image / table などとして解釈される可能性がある。
- 根拠: text block export は `_markdownTextBlockMarkdown` / `_escapeMarkdownBlockLine` を通し、行頭の heading / list / ordered list / quote / image / link reference / table pipe / fence / thematic break / HTML block などを backslash escape する。`markdownToHtmlInline` は `MARKDOWN_ESCAPABLE_PUNCTUATION_RE` で escaped marker を復元し、table 判定は `_mdUnescapedPipeCount` / `_mdLooksLikeTableRow` に置き換えて escaped pipe を区切り扱いしない。unit テスト `markdown serialization preserves escaped text markers and image captions` と integration テスト `block selection copy and cut preserve markdown delimiter literals` で text block、Markdown import 相当 parse、選択 copy / cut の round trip を確認済み。
- 現状: 通常テキストとして書いた Markdown 風サンプルは export / paste 後も text block に戻り、heading / list / image / table へ変化しない。
- 影響: 解消済みのため、Markdown 風リテラルが別ブロックへ変換されるリスクは抑制されている。
- 次の対応: なし。
## 59. Markdown export の通常テキスト内 inline 記法が装飾へ変化し得る

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 通常テキストや装飾要素内の素の文字列に Markdown inline 記法が含まれると、export / 再 import 後に意図しない装飾へ変化する可能性があった。
- 根拠: `htmlToMarkdownInline` が text node と fallback text を `_escapeMarkdownInlineText` に通し、`markdownToHtmlInline` は escape 済み delimiter を文字として復元する。テスト `markdown export round-trips inline literal markers without accidental formatting` で素の `**bold**`、link literal、autolink literal、装飾内 delimiter の round trip を確認している。
- 現状: Markdown inline marker は通常テキストとして export され、既存装飾の境界とも衝突しない。
- 影響: 解消済みのため、Markdown 記法の説明文やサンプル文字列が再 import / paste で装飾化するリスクは確認されない。
- 次の対応: なし。

## 60. Markdown export のページタイトルが複数行で本文へ分裂し得る

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: ページタイトルの改行や末尾 `#` が Markdown export 後に本文へ分裂したり、ATX heading の closing marker として削られる可能性があった。
- 根拠: `exportPageAsMarkdown` は `_markdownHeadingPlainText` 経由で `_normalizePageTitleInput` と `_escapeMarkdownInlineText` を通した単一行タイトルを出力する。テスト `markdown page title export is single-line and preserves trailing hashes` で `Alpha\nBeta ###` が `# Alpha Beta \#\#\#` として出力され、再 parse 後もタイトル文字列が保たれることを確認している。
- 現状: export 時のタイトルは単一行化され、末尾 `#` も文字として扱われる。
- 影響: 解消済みのため、Markdown バックアップの再 import でタイトルが本文へ分裂するリスクは確認されない。
- 次の対応: なし。

## 61. 画像ブロック変換後の隠れ data URL が合計上限を迂回する

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: image から別種別へ変換した後に非表示の `url` data URL が残り、合計容量上限の集計を迂回する可能性があった。
- 根拠: `_normalizeBlockTypeSpecificFields` が非 image の `url` / `caption`、非 file の file 系フィールド、非 table の table 系フィールドを消す。`_localEmbeddedDataBytesForBlock` と `_enforceLocalEmbeddedDataTotalLimit` はブロック種別にかかわらず `url` / `fileDataUrl` の data URL を集計・削除対象にする。テスト `block type conversion preserves hidden payloads, content, and children visibly` で hidden `url` の正規化と合計上限 enforcement を確認している。
- 現状: 非 image ブロックに画像 data URL が隠れたまま保存・上限迂回する経路は塞がれている。
- 影響: 解消済みのため、変換済みブロックの隠れ data URL による保存肥大化や quota 超過リスクは確認されない。
- 次の対応: なし。

## 62. ローカル data URL 合計上限を複製・Markdown取り込みで超えられる

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: ページ複製、ブロック複製、Markdown import / paste で data URL 画像や添付を増やす際、ローカル埋め込み data URL の合計上限を超えられる可能性があった。
- 根拠: `duplicatePage` は `_estimateLocalEmbeddedDataBytesForPageSubtree` と `_localEmbeddedDataNextTotal` で複製前に上限を確認する。ブロック複製、`importMarkdownAsNewPage`、`handleBlockPaste` は追加予定ブロックを `_estimateLocalEmbeddedDataBytesForBlocks` で見積もり、`_confirmLocalEmbeddedDataAllowance` を通してから state を変更する。`local embedded data total helpers estimate, warn, and trim excess data URLs` で合計見積もり・拒否・削除 helper の挙動も確認している。
- 現状: ローカル data URL を増やす主要経路は追加前に合計容量を確認する。
- 影響: 解消済みのため、ユーザー操作だけで live state の埋め込み data URL 合計が上限を超える主要リスクは確認されない。
- 次の対応: なし。

## 63. プレーンテキスト貼り付けがインライン記法だけでブロック化する

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `**bold**` や `[link](...)` のような1行のプレーンテキスト貼り付けが Markdown block paste と判定され、カーソル位置への挿入ではなく新規ブロック化する可能性があった。
- 根拠: `looksLikeMarkdownBlockPaste` と `looksLikeMarkdownInlineOnly` が分離され、`handleBlockPaste` は inline-only Markdown を空の text block でだけ Markdown 変換し、非空ブロックでは通常テキスト挿入へ落とす。テスト `plain JSON and tag-like paste stay inline instead of Markdown blocks` で inline-only marker が非空ブロック内へ文字列として入ることを確認している。
- 現状: explicit Markdown clipboard 以外では、inline-only の通常貼り付けは非空ブロックを分割しない。
- 影響: 解消済みのため、文章途中への Markdown 記法サンプル貼り付けで段落構造が崩れるリスクは確認されない。
- 次の対応: なし。

## 64. Markdown export の添付ファイルが再 import で失われる

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: file ブロックを Markdown export して再 import / paste すると、添付本体やファイル名が file ブロックとして復元されない可能性があった。
- 根拠: `blockToMarkdown` の `file` 分岐が `[fileName](data:...)` を出力し、`_mdExtractFileLink` が data URL link を file block payload に復元する。テスト `markdown export imports files, toggle headings, rich table cells, rich captions, math, and preserved blanks` と `markdown compatibility blocks serialize and parse deferred structures` で fileName と `fileDataUrl` の round trip を確認している。
- 現状: 添付ファイルは Markdown export / parse 後も file ブロックとして復元される。
- 影響: 解消済みのため、Markdown バックアップや選択 paste で添付が通常リンク化・欠落するリスクは確認されない。
- 次の対応: なし。

## 65. ブロック種別変換で子ブロックが不可視のまま残る

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: children を持つブロックを children 非対応種別へ変換すると、子ブロックが state に残ったまま UI / Markdown から見えなくなる可能性があった。
- 根拠: `convertBlockType` は変換先が children 非対応の場合、既存 `children` を `promotedChildren` として親ブロック直後へ昇格し、変換後ブロックの `children` を空にする。テスト `block type conversion preserves hidden payloads, content, and children visibly` で toggle -> image 変換後に親本文と子本文が可視ブロックとして残ることを確認している。
- 現状: 子ブロックは不可視 payload として残らず、変換後も隣接ブロックとして操作・export 可能になる。
- 影響: 解消済みのため、種別変換でネスト済み内容が見えなくなるリスクは確認されない。
- 次の対応: なし。

## 66. トグル見出しの子ブロックが Markdown 再 import で兄弟化する

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: toggle_h1 / h2 / h3 の子ブロックが Markdown export / 再 import 後にトグル配下ではなく兄弟ブロックとして復元される可能性があった。
- 根拠: `blockToMarkdown` は toggle heading を `::: leafnote-toggle-hN open/closed` と `Title:` を持つ LeafNote 専用 fenced block として出力し、`_parseLeafNoteToggleHeadingMarkdown` が title、expanded、children を復元する。テスト `markdown export imports files, toggle headings, rich table cells, rich captions, math, and preserved blanks` で閉じた toggle_h2 と子 text / math の round trip を確認している。
- 現状: トグル見出しの展開状態と子階層は Markdown 再 import 後も保持される。
- 影響: 解消済みのため、トグル配下の内容が兄弟化して文書構造が崩れるリスクは確認されない。
- 次の対応: なし。

## 67. テーブルセルの装飾が Markdown export で失われる

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: テーブルセル内の太字、リンク、inline code、mark などの装飾が Markdown export / 再 import で失われる可能性があった。
- 根拠: `tableBlockToMarkdown` は `_markdownTableCellInline` 経由でセル HTML を Markdown inline に変換し、pipe を escape する。parse 側は table cell を `markdownToHtmlInline` に通して rich HTML へ戻す。テスト `markdown export imports files, toggle headings, rich table cells, rich captions, math, and preserved blanks` で `<b>`、link、`<code>a|b</code>`、`<mark>` の復元を確認している。
- 現状: テーブルセルの主要 inline 装飾は Markdown round trip で保持される。
- 影響: 解消済みのため、表内メモの強調・リンク・コード表現が失われるリスクは確認されない。
- 次の対応: なし。

## 68. 画像キャプションの装飾が Markdown export で失われる

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 画像キャプション内の rich text 装飾が Markdown export / 再 import 後にプレーンテキスト化する可能性があった。
- 根拠: `blockToMarkdown` の image 分岐は `_markdownImageAltInline` を通して caption HTML を Markdown inline へ変換し、`_mdExtractImage` と `markdownToHtmlInline` が caption HTML に復元する。テスト `markdown export imports files, toggle headings, rich table cells, rich captions, math, and preserved blanks` で太字、リンク、inline code、mark の caption round trip を確認している。
- 現状: 画像キャプションの主要 inline 装飾は Markdown round trip で保持される。
- 影響: 解消済みのため、画像説明の装飾やリンクが export / 再 import で失われるリスクは確認されない。
- 次の対応: なし。

## 69. Markdown import の数式ブロックが code ブロックになる

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `$$ ... $$` 形式の Markdown 数式ブロックを import すると code ブロックとして扱われる可能性があった。
- 根拠: `parseMarkdownToBlocks` は `$$` fence を検出して `blk('math', ...)` を作成し、`blockToMarkdown` の `math` 分岐も `$$` 形式で出力する。テスト `markdown export imports files, toggle headings, rich table cells, rich captions, math, and preserved blanks` で toggle 配下の math block round trip を確認している。
- 現状: `$$` 数式は math ブロックとして import / export される。
- 影響: 解消済みのため、数式メモが code 扱いになって表示・編集体験が変わるリスクは確認されない。
- 次の対応: なし。

## 70. 検索がテーブルセル・画像キャプション・添付ファイル名を対象にしない

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 検索対象が本文中心で、テーブルセル、画像キャプション、添付ファイル名、定義リストや仕様系フィールドなどの可視情報を見落とす可能性があった。
- 根拠: `_appendBlockSearchTextParts` は table cells、image caption、fileName / fileType / meta、definition list、governance / spec fields、label / refUrl / refTitle を検索テキストへ追加する。`flattenTextFromBlocksWithinBudget` はネスト内ブロックも同じ helper で走査する。テスト `search helpers include rich text display text, tables, captions, files, and definitions` で各フィールドの検索一致を確認している。
- 現状: 主要な可視 payload と metadata は検索対象に含まれている。
- 影響: 解消済みのため、表・画像・添付・定義内の語句が検索で見つからない主要リスクは確認されない。
- 次の対応: なし。

## 71. 検索が本文 HTML の表示テキストを正しく抽出しない

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `&amp;` や `<br>` を含む本文 HTML が、画面表示と異なる検索文字列として扱われる可能性があった。
- 根拠: `stripHTMLToText` は `<br>` を改行へ置換してから `textContent` で entity decode し、`_htmlFieldSearchText` が空白正規化した表示テキストを検索に使う。テスト `search helpers include rich text display text, tables, captions, files, and definitions` で `Tom &amp; Jerry<br>Line Break` が `Tom & Jerry Line Break` として検索対象になることを確認している。
- 現状: rich text の検索文字列は DOM 表示テキストに近い抽出へ統一されている。
- 影響: 解消済みのため、表示されている `&` や改行を含む語句が検索に一致しない主要リスクは確認されない。
- 次の対応: なし。

## 72. 見出し・リスト本文の改行が Markdown 再 import で別ブロック化する

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: heading、list、todo、toggle heading の本文内改行が Markdown export 後に別ブロックや子ブロックとして解釈される可能性があった。
- 根拠: `blockToMarkdown` は heading / bullet / numbered / todo / toggle heading の head 部分を `_markdownSingleLineInline` で単一行化してから出力する。テスト `markdown export imports files, toggle headings, rich table cells, rich captions, math, and preserved blanks` で `Head<br>Break`、`Item<br>Break`、`Todo<br>Break` が単一ブロックの本文として復元されることを確認している。
- 現状: 単一行 Markdown 構文へ入る本文改行は export 時に安全な空白へ丸められる。
- 影響: 解消済みのため、見出しやリスト項目の本文構造が Markdown round trip で崩れるリスクは確認されない。
- 次の対応: なし。

## 73. Markdown export がコード内の連続空行を圧縮する

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `blocksToMarkdown` の出力全体に対する改行圧縮で、code / mermaid / raw text 内の意味ある連続空行が減る可能性があった。
- 根拠: 現在の `blocksToMarkdown` は各 block の Markdown を `out.join('\n\n')` で結合し、全体への `replace(/\n{3,}/g, '\n\n')` は行っていない。テスト `markdown export imports files, toggle headings, rich table cells, rich captions, math, and preserved blanks` で code block の `a\n\n\nb` が再 parse 後も保持されることを確認している。
- 現状: ブロック内部の連続空行とブロック間 separator は区別されている。
- 影響: 解消済みのため、コードや原稿内の空行数が export / import で変わるリスクは確認されない。
- 次の対応: なし。

## 74. テーブルを別ブロック種別へ変換するとセル内容が不可視になる

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: table を別種別へ変換すると、セル内容が state に隠れたまま UI / Markdown から消える可能性があった。
- 根拠: `convertBlockType` は table -> 非 table で `_tablePreservationBlock` を作り、セル内容を Markdown table 文字列の text block として直後へ退避する。変換後の非 table 固有フィールドは `_normalizeBlockTypeSpecificFields` で整理される。テスト `block type conversion preserves hidden payloads, content, and children visibly` で table -> text 後にセル内容が可視 text として残ることを確認している。
- 現状: table 変換時のセル内容は不可視 payload ではなく可視ブロックへ退避される。
- 影響: 解消済みのため、表を別種別へ変えた操作で入力済みセルが見えなくなるリスクは確認されない。
- 次の対応: なし。

## 75. file ブロック変換で本文や添付本体が確認なしに消える

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: file から別種別、または本文ありブロックから file へ変換する際、添付本体や既存本文が不可視・消失する可能性があった。
- 根拠: `convertBlockType` は file -> 非 file で `_filePreservationBlock` を作り、添付本体があれば file block、ファイル名だけなら text block として直後へ退避する。本文ありブロックを file など本文非表示種別へ変える場合は `_richTextPreservationBlock` で本文を text block へ退避する。テスト `block type conversion preserves hidden payloads, content, and children visibly` で file payload と本文の退避を確認している。
- 現状: 種別変換で file payload や既存本文が不可視のまま失われる経路は塞がれている。
- 影響: 解消済みのため、添付ファイルや本文が変換操作で復元困難になるリスクは確認されない。
- 次の対応: なし。

## 76. 本文を持つブロックを非本文系へ変換すると本文が不可視になる

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: text / heading / quote / callout など本文を持つブロックを table / image / toc / divider などへ変換すると、既存本文が UI と Markdown export から消える可能性があった。
- 根拠: `convertBlockType` は `blockTypeUsesContent(oldType)` かつ変換先が本文非表示で、既存本文がある場合に `_richTextPreservationBlock` を作り、変換ブロック直後へ text block として挿入する。テスト `block type conversion preserves hidden payloads, content, and children visibly` で text -> table 後に `Keep text` が隣接 text block として残ることを確認している。
- 現状: 本文を持つブロックを本文非表示種別へ変換しても、本文は可視 text block へ退避される。
- 影響: 解消済みのため、表示形式変更で本文が見えなくなるリスクは確認されない。
- 次の対応: なし。

## 77. リモート画像インライン保存が合計 data URL 上限を超え得る

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: HTML 保存時にリモート画像を data URL 化する際、既存ローカル data URL と合算した 100MB 上限を超える自己完結 HTML を生成する可能性があった。
- 根拠: `inlineRemoteImagesForExport` は `embeddedTotal = _estimateLocalEmbeddedDataTotalBytes(s)` から開始し、各 remote 画像を data URL 化した後、`embeddedTotal + bytes > maxEmbeddedBytes` なら block.url を置き換えず failed に積む。テスト `remote image export enforces total embedded data cap and redirect target safety` で上限超過時は remote URL が残り、ちょうど上限内では data URL 化されることを確認している。
- 現状: リモート画像 inline は合計埋め込み容量を逐次確認し、超過分はリンクのまま残す。
- 影響: 解消済みのため、保存操作だけで上限超過の自己完結 HTML を作る主要リスクは確認されない。
- 次の対応: なし。

## 78. リモート画像 export fetch がリダイレクト後の private/local URL を検査しない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: HTML 保存時の remote image fetch が、公開 URL から private / local URL へリダイレクトされた場合に内部ネットワークへアクセスする可能性があった。
- 根拠: `fetchPublicRemoteImageResponse` は `redirect: 'manual'` で 3xx を段階的に解決し、元 URL、各 `Location` 解決後 URL、最終 `res.url` を `assertPublicRemoteImageFetchUrl` に通す。`assertPublicRemoteImageFetchUrl` は http/https 以外と `isPrivateNetworkUrl` 該当を拒否する。テスト `remote image export enforces total embedded data cap and redirect target safety` で public -> localhost redirect の拒否、public redirect の許可、redirect loop 上限を確認している。
- 現状: リダイレクトチェーン上の private / local 宛先は fetch 継続前に拒否される。
- 影響: 解消済みのため、保存操作でローカルホストや LAN へ remote image fetch するリスクは確認されない。
- 次の対応: なし。

## 79. Maskinger の入力サイズ・対応表件数に上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `Maskinger.html` は貼り付け入力と生成される対応表に上限がなく、巨大なログや多数のユニーク値を貼り付けると、同期的な正規表現処理、対応表DOM生成、`sessionStorage` 保存が重くなってブラウザ操作が止まる可能性がある。
- 根拠: `Maskinger.html` に `MASKINGER_INPUT_MAX_BYTES = 1 MiB`、`MASKINGER_INPUT_MAX_LINES = 5000`、`MASKINGER_MAX_MAPPINGS = 1000`、`MASKINGER_MAPPING_RENDER_MAX_ROWS = 200`、`MASKINGER_MAPPING_ORIGINAL_MAX_BYTES = 16 KiB`、`MASKINGER_STORAGE_MAX_BYTES = 2 MiB` を追加した。`_inputLimitViolation` が UTF-8 byte 数と行数をマスク前・復元前入力に適用し、`_estimateMappingAllowance` が対応表追加前に件数・元値サイズ・型を検査する。`_maskText` は対応表更新をトランザクション化し、上限超過時は state を rollback して UI 側で前回安全な入力・出力・対応表を維持する。`_replaceMappingsFromItems` は保存済み `sessionStorage` の対応表を読み込み時に正規化し、`_renderMappings` は先頭200件だけを描画して残件数を表示する。`_saveMappings` の失敗時もメモリ上の対応表と復元は継続される。
- 現状: Maskinger の入力、復元、対応表追加、保存済み対応表読み込み、対応表描画に上限がある。超過時は toast で通知され、前回の安全な入力・出力・対応表から不整合に進まない。
- 影響: 解消済みのため、巨大入力や大量ユニーク値で同期処理・DOM生成・`sessionStorage` 保存が無制限に膨らむ主要リスクは抑制されている。
- 次の対応: なし。

## 80. Maskinger の対応表保存容量が作成時に検査されない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: `Maskinger.html` は保存済み対応表を読み込む時だけ `MASKINGER_STORAGE_MAX_BYTES = 2 MiB` を検査しており、対応表を作成・保存する時に同じ容量予算を拒否しない。ブラウザが 2 MiB 超の `sessionStorage` 書き込みを受け入れた場合、リロード時に `_loadMappings` が保存済み対応表を「大きすぎる」として削除し、マスク済み文字列を復元できなくなる可能性がある。
- 根拠: `_serializedMappingsByteLength` / `_mappingStorageLimitViolation` を追加し、`_estimateMappingAllowance` が候補1件追加後の JSON byte 数を `MASKINGER_STORAGE_MAX_BYTES` と比較する。超過時は `mapping_storage_bytes` の limit error になり、`_maskText` の既存 rollback で `_state._mappings` と出力が前回安全状態に戻る。`_saveMappings` も保存直前に同じ容量予算を確認する。
- 現状: 対応表の作成・保存・読み込みで 2 MiB の保存容量上限が共有され、2 MiB ちょうどは保存・リロード可能、2 MiB 超過の追加は拒否される。
- 影響: 保存に成功したように見えてリロード後に対応表が破棄されるリスクは解消済み。
- 次の対応: なし。

## 81. index コピーUIの ready 判定が listener 登録完了を待たない

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `tests/run-browser.mjs` の `index.html` 用 ready 判定が copy ボタンと埋め込み source 要素の存在だけを見ており、`index.html` 末尾スクリプトが click listener を登録し終えたことを明示的に待たない。現在の `index.html` は巨大な `#leafnote-source` JSON の後に copy handler を登録するため、環境やタイミングによっては早すぎるクリックが無視される余地がある。
- 根拠: `index.html` の Copy SourceCode ボタンは初期状態で `disabled aria-disabled="true"` になり、末尾 script が click listener を登録した後に `_setCopyReady(true)` と `window.__LeafNoteIndexReady = true` を実行する。`tests/run-browser.mjs` の index readyExpression は `window.__LeafNoteIndexReady === true` を待つ。
- 現状: テストも実画面も listener 登録完了後を ready 境界として扱うため、早すぎるクリックが無反応になる余地は抑制されている。
- 影響: index copy テストのタイミング依存リスクは解消済み。
- 次の対応: なし。

## 82. index.html の leafnote-source 後に LeafNote 断片が漏れている

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: `index.html` の `#leafnote-source` は JSON としては `LeafNote.html` と一致しているが、その閉じタグ直後に LeafNote のソース断片が HTML 本文として残っている。ブラウザは後続断片を通常の HTML / script として解釈するため、トップページに巨大なコード断片が混入し、Copy SourceCode の click handler が複数回登録される可能性がある。
- 根拠: `index.html` は `LeafNote.html` を `JSON.stringify(...).replace(/</g, '\\u003c')` した `#leafnote-source` 1個だけを持つ構造に再生成済み。閉じタグ後は landing script 1個だけで、`document.addEventListener("click", ...)` も1個だけ。静的テストで source script 数、literal `<` 不在、`LeafNote.html` との一致、閉じタグ後の `const blockSelectorById` / `function parseMarkdownToBlocks` 不在を確認する。
- 現状: `#leafnote-source` 後の LeafNote 断片と copy handler 重複は除去済み。
- 影響: トップページに巨大なソース断片が表示されたり、1クリックで copy handler が複数回実行されるリスクは解消済み。
- 次の対応: なし。

## 83. Maskinger のコピー fallback が execCommand の失敗を成功表示する

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `Maskinger.html` の「コピー」ボタンは Clipboard API が使えない環境で `document.execCommand('copy')` の戻り値を確認せず、コピーが失敗しても「コピーしました」と表示する。
- 根拠: `_copyFrom` の fallback 経路は `const copied = document.execCommand('copy')` を確認し、`false` の場合は `Copy command failed` を throw して `catch` 側の「コピー失敗」表示に入る。Maskinger integration に Clipboard API 不在・`execCommand` true / false / throw の回帰テストを追加し、true の場合だけ「コピーしました」になることを確認する。
- 現状: Clipboard API が使えない環境でも `execCommand` の失敗を成功表示しない。
- 影響: コピーできていない状態をユーザーが成功と誤認するリスクは解消済み。
- 次の対応: なし。

## 84. 選択ブロックの keyboard copy/cut が execCommand 例外で fallback しない

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 選択ブロックがある状態で Cmd/Ctrl+C または Cmd/Ctrl+X を押す経路は、最初に `document.execCommand('copy' / 'cut')` を直接呼ぶ。`execCommand` が未定義または例外を投げる環境では async keydown listener が未処理例外になり、Clipboard API fallback や失敗通知へ進まない。
- 根拠: `_tryExecCommand` が `typeof document.execCommand === 'function'`、戻り値の厳密な `true` 判定、`try/catch` を一元化した。選択ブロックの keyboard copy/cut は失敗時に `_writeClipboardTextFallback` へ進み、cut は clipboard 書き込み成功後だけブロックを削除する。テスト `keyboard block copy and cut survive throwing or missing execCommand` と既存の `keyboard cut fallback deletes selected blocks only after clipboard write succeeds` で throw / missing / false、fallback 成功・失敗、失敗時の state 保持を確認した。
- 現状: keyboard copy/cut は `execCommand` の実装差で未処理例外にならず、代替コピーの成否を基準に処理する。
- 影響: 解消済みのため、コピーできていないのに cut 対象を削除したり、失敗を通知できないリスクは確認されない。
- 次の対応: なし。

## 85. 起動時 state payload の JSON parse 前サイズ上限がない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: `embedded-state` や localStorage の保存値を読み込む入口で、JSON.parse 前の raw 文字列サイズ上限がない。改変済みの共有 HTML や壊れた保存値が巨大な場合、ページ数・ブロック数・data URL・単一テキストの正規化上限に到達する前に、メインスレッドで巨大文字列の `trim()` / `JSON.parse()` が走る。
- 根拠: `STATE_PAYLOAD_MAX_BYTES = 160 MiB`、`_statePayloadLimitViolation`、`_parseStatePayloadWithLimit` を追加した。文字列長の安価な事前判定後に UTF-8 byte 数を測り、上限超過時は `JSON.parse` を呼ばない。init の embedded-state と `loadStateAsync` の localStorage が同じ helper を使い、HTML export も上限超過 state の埋め込みを拒否する。テスト `state payload parsing enforces UTF-8 byte limits before JSON.parse and keeps IndexedDB fallback` で byte 境界、multibyte、壊れた JSON、超過エラー、正常な IndexedDB への fallback を確認した。
- 現状: embedded-state 超過は明示通知後に無視され、localStorage 超過は保存値を削除せず IndexedDB または初期 state へ fallback する。
- 影響: 解消済みのため、raw state JSON が無制限に parse される経路は確認されない。
- 次の対応: なし。

## 86. 貼り付け挿入が execCommand 失敗時に消える

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: contenteditable への貼り付け処理は `preventDefault()` 後に `document.execCommand('insertHTML' / 'insertText')` を直接呼び、戻り値確認や例外時 fallback をしていない。`execCommand` が未定義・失敗・例外になる環境では、貼り付け内容が挿入されないまま処理が終わる、または handler が例外で止まる可能性がある。
- 根拠: `_insertPlainTextWithFallback` / `_insertHTMLWithFallback` が `_tryExecCommand` の失敗時に `_insertPlainTextIntoTarget` / `_insertHTMLIntoTarget` の Selection / Range 挿入へ切り替わる。各貼り付け handler は boolean 成功値を確認し、失敗時は通知して onChange / save / 後続ブロック作成を中止する。テスト `paste and code Tab use Range insertion when execCommand fails` で false / throw / missing、plain text、sanitized HTML、複数行、page title、document name を実 DOM と state で確認した。
- 現状: 主要 contenteditable 貼り付け経路は `execCommand` に依存せず、代替挿入できない場合も state を誤更新しない。
- 影響: 解消済みのため、貼り付けを `preventDefault()` した後に内容だけが失われたり、後続ブロックだけが作られるリスクは確認されない。
- 次の対応: なし。

## 87. インライン装飾コマンドが execCommand 失敗時にも保存済み扱いになる

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: rich text の Cmd/Ctrl+B/I/U/Shift+S、inline toolbar の太字・斜体・下線・取り消し線、リンク作成/解除が `document.execCommand` を直接呼び、戻り値確認や例外処理をしていない。`execCommand` が未定義・false・throw になる環境では、操作が未反映でも保存処理や toolbar 同期へ進む、または event handler が例外で止まる可能性がある。
- 根拠: `_applyInlineCommand` が execCommand の成否を正規化し、失敗時は `_applyInlineCommandRangeFallback` で `strong` / `em` / `u` / `s` の wrap・unwrap、`a` の作成・解除を行う。keyboard shortcut、inline toolbar、link dialog は成功時だけ state 同期へ進み、fallback 不能時は通知する。テスト `inline formatting and links fall back safely when execCommand is unavailable` で false / throw / missing、shortcut、toolbar、createLink、unlink、collapsed range 失敗時の state 保持を確認した。
- 現状: インライン装飾とリンク操作は `execCommand` の実装差を吸収し、未反映の操作を保存済み扱いにしない。
- 影響: 解消済みのため、装飾やリンクが未反映のまま state 更新だけが進むリスクは確認されない。
- 次の対応: なし。

## 88. コードブロックの Tab インデントが execCommand 失敗時に反映されない

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: コードブロック内で Tab を押す経路は `preventDefault()` 後に `document.execCommand('insertText', false, '  ')` を直接呼ぶため、`execCommand` が未定義・false・throw の環境ではスペース挿入も通常 Tab 動作も行われない。
- 根拠: code block の Tab handler は `_insertPlainTextWithFallback(codeInner, '  ')` を使い、execCommand の false / throw / missing 時に Selection / Range で2スペースを挿入する。成功時だけ content 同期・保存・highlight 予約へ進み、失敗時は通知する。テスト `paste and code Tab use Range insertion when execCommand fails` で throw 時の実 DOM と state 反映を確認した。
- 現状: コードブロックの Tab インデントは execCommand に依存せず、成功可否と state 更新が一致する。
- 影響: 解消済みのため、Tab を抑止したままインデントだけが消えたり、例外で編集が止まるリスクは確認されない。
- 次の対応: なし。

## 89. 互換ブロックが再読み込み時に専用UIから降格する

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `decision` / `requirement` / `open_question` / `api_spec` / `db_table` / `screen_spec` / `test_case` などの専用レンダラと編集UIを持つブロックが保存済み state や共有 HTML に含まれていても、起動時正規化で `text` ブロックへ降格されるため、再読み込み後に専用フィールド編集 UI と型情報が維持されない可能性がある。
- 根拠: `LOW_PRIORITY_COMPAT_BLOCK_TYPES` は低優先互換型だけに絞り、`decision` / `requirement` / `open_question` / `api_spec` / `db_table` / `screen_spec` / `test_case` を降格対象から外した。`DEFERRED_NATIVE_BLOCK_TYPES` も `risk` のみに限定し、Markdown parser は `decision` / `db_table` などを専用ブロックとして復元する。テスト `state normalization preserves native governance and spec block shapes` と `markdown compatibility blocks serialize while native structures parse to dedicated blocks` で型・フィールド保持を確認している。
- 現状: 保存済み state、共有 HTML、Markdown import のいずれでも対象ブロックは専用型として round trip し、専用 UI のフィールド編集対象として残る。
- 影響: 解消済みのため、仕様・決定・要求・質問情報が再読み込みだけで通常 text へ降格するリスクは確認されない。
- 次の対応: なし。

## 90. 保存側 state payload に総量上限がない

- ステータス: 完
- 種別: 新規
- 重要度: 高
- 問題: 起動時の `embedded-state` / `localStorage` 読み込みと HTML export には `STATE_PAYLOAD_MAX_BYTES` があるが、通常の自動保存や unload 同期保存は `JSON.stringify(state)` 後に同じ上限を確認せず、巨大なテキスト state を IndexedDB / localStorage へ保存しようとする。ページ数・ブロック数・単一フィールド上限はあるものの、1000ページ x 1000ブロック x 1MiB rich text のような合計量は保存側で拒否されない。
- 根拠: `_normalizeStatePayloadMaxBytes` / `_stateSnapshotWithinPayloadLimit` / `_createStatePayloadTooLargeError` / `_notifyStatePayloadTooLarge` を追加し、`_doSave` と `flushStateToLocalStorageSync` は保存処理へ進む前に同じ UTF-8 byte 上限を確認する。超過時は IndexedDB / localStorage に書かず、`saveStatus.statePayloadTooLarge` を persistent error として表示する。HTML export も remote image inline 前後の両方で同じ判定を行う。テスト `state payload save guards reject oversized snapshots before storage writes` で上限ちょうど、1 byte 超過、既存保存値維持、同期 fallback の拒否、通知表示を確認している。
- 現状: 保存側も読み込み側・export 側と同じ総量上限を共有し、超過 state は保存ストレージへ投入されない。
- 影響: 解消済みのため、160MiB 超の state を通常保存や unload fallback で書き込もうとして保存値を壊すリスクは抑制されている。
- 次の対応: なし。

## 91. 専用ブロック変換後に隠れフィールドが残る

- ステータス: 完
- 種別: 新規
- 重要度: 中
- 問題: `decision` / `requirement` / `open_question` / `api_spec` / `db_table` などの専用ブロックを通常ブロックへ変換すると、画面上は通常ブロックになる一方で、`governanceOwner`、`tableName`、`columns` などの専用フィールドが state に残り続ける可能性がある。表示・検索・Markdown export では通常ブロック扱いになるため、ユーザーは残存データを確認・編集しにくい。
- 根拠: `_clearGovernanceFields` と `_clearSpecFields` を `_normalizeBlockTypeSpecificFields` に集約し、変換先が governance/spec 以外なら専用メタデータを空にする。`convertBlockType` には `_governancePreservationBlock` / `_specPreservationBlock` を追加し、専用ブロックから通常型へ変換する際は元の専用フィールドを Markdown 形式の可視 text ブロックとして退避してから hidden field を clear する。テスト `block type conversion preserves dedicated metadata visibly and clears hidden fields` で `decision` と `db_table` の変換後 state と可視内容を確認している。
- 現状: 専用ブロックを通常ブロックへ変換しても、情報は画面上で読める Markdown として残り、元ブロックの hidden governance/spec payload は保存 state に残らない。
- 影響: 解消済みのため、UI から見えない専用情報だけが embedded state やブラウザ保存に残存するリスクは確認されない。
- 次の対応: なし。
