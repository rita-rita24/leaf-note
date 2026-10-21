# テスト方針

このドキュメントは LeafNote のテスト実行方法、coverage の定義、対象範囲、除外範囲、トラブルシュートをまとめる。既存のChromeテストはNode.js標準機能とChrome DevTools Protocolで実行する。Firefox・WebKitの追加検証には固定した開発依存のPlaywrightを使う。

## 実行方法

作業ディレクトリはリポジトリルートとする。依存関係は `npm ci` でロックファイルどおりにインストールする。

### 前提

- Node.js 22 以上と npm。テストランナーは Node.js のグローバル `WebSocket` を Chrome DevTools Protocol への接続に使用するため、Node.js 18 などでは実行できない。
- ヘッドレス起動できる Chrome または Chromium。unit テストもアプリをブラウザで読み込むため必要。ランナーは macOS の Chrome / Chromium / Brave / Edge、Linux の `/usr/bin/google-chrome` / `/usr/bin/chromium` / `/usr/bin/chromium-browser` を探す。他の場所にある場合は `CHROME_BIN` に実行ファイルの絶対パスを指定する。
- ローカルのブラウザプロセス起動と `127.0.0.1` の一時ポートへの接続が許可されていること。テストには一時プロファイルを使用する。

```sh
node --version
CHROME_BIN="/absolute/path/to/chrome" npm test
```

### 配布ファイルの同期

この作業フォルダーのアプリ本体の編集元は `leaf-note.html`。`index.html` は配布用に同じソースを `script#leafnote-source` の JSON 文字列として保持している。本体を変更したら、次の順に同期して確認する。

```sh
npm run build
npm run check:distribution
npm test
```

- `npm run build`: `leaf-note.html` を JSON 化し、`<` を `\u003c` に置き換えて `index.html` の既存の JSON ペイロードだけを更新する。ランディングページやそのスクリプトは変更しない。両ファイルの差分をレビューし、両方を配布する。
- `npm run check:distribution`: ファイルを変更せず、本体との不一致、埋め込み要素の欠落・重複、JSON 型や構文の不正、未エスケープの `<` を検出したら終了コード 1 を返す。配布用要素の構造や JSON が壊れている場合は `build` も停止するため、先にその破損を修正する。
- `npm test` の前には `pretest` が配布チェックを実行する。未同期の配布物を自動修正して隠さず、テスト開始前に失敗させる。個別の `test:unit` / `test:integration` / `test:coverage` では `pretest` は実行されないため、先に `npm run check:distribution` を実行する。

### ユーザビリティの回帰確認

`npm run test:usability` は、独立した一時ブラウザでノートの階層移動（循環・深さ制限・取り消し）、並べ替えと保存、読み位置の保持、検索抜粋と折りたたみ内への移動、削除範囲の表示、リストのインデント、HTMLバックアップのショートカットと保存状態を検証する。同じ回帰テストを `npm test` に、LeafNote の回帰テストを `npm run test:quality` にも含める。実際のユーザーデータは使わない。

クリックで開いたブロックメニューはポインターが外れても保持し、外側クリック・Esc・ウィンドウのフォーカス喪失で閉じる。この挙動とタッチ操作は `GYOMU_SOURCE="$PWD/leaf-note.html" node tests/run-gyomu-hover.mjs` で確認できる。

### ブラウザテスト

```sh
npm test
npm run test:unit
npm run test:integration
npm run test:ui
npm run test:storage
npm run test:quality
npm run test:large-storage
npm run test:file-recovery
npm run test:coverage
```

- `npm test`: unit / integration をまとめて実行する総合コマンド。
- `npm run test:unit`: UI 操作を主目的にしない純粋関数や状態変換を、Chrome DevTools Protocol ランナー経由でアプリのテスト API から検証する。
- `npm run test:integration`: Chrome を起動し、Chrome DevTools Protocol 経由で実画面上の操作、永続化、DOM 反映を検証する。
- `npm run test:ui`: 本体・配布ページを320/768/1280pxで表示し、横方向のはみ出し、ライト／ダーク、キーボードフォーカス、強制カラーモード、設定ダイアログを検証する。フォーカス直後に枠線が内側に収まり、重複した影や寸法変化がないことも確認する。`MODERN_UI_BASELINE=/absolute/path/to/before` を指定すると、独立した一時ブラウザの変更前HTMLと各要素の寸法・配色を比較する。比較元の本体ファイル名だけ異なる場合は `MODERN_UI_BASELINE_APP`、スクリーンショット保存先は `MODERN_UI_SCREENSHOTS` で指定できる。
- `npm run test:storage`: 保存競合・破損復旧・容量不足など保存関連の実ブラウザテストだけを実行する。
- `npm run test:quality`: 追加の内部品質回帰テストを実行する。ごみ箱の親子関係、保存停止中のUndo、結合・変換での本文保全、壊れたJSON、添付復号、ダウンロード失敗、保存の待機上限を含む。`npm test` / `test:unit` / `test:coverage` にも含まれる。
- `npm run test:large-storage`: 12MiBの合成添付（JSONは約16MiB）を保持する文書を24回更新し、IndexedDBの完全一致、localStorageへ退避できない場合の保存失敗判定、直前の保存内容・未保存編集の保持、復旧を確認する。`LARGE_STORAGE_REPORT=reports/large-storage.json` で結果を保存できる。重い試験のため通常の `npm test` とは分ける。
- `npm run test:file-recovery`: 配布HTMLを `file://` で直接開き、テスト用Chromeの強制終了後に保存済みstateが戻ることを確認する。保存待ちを保持して強制終了するケースでは、未保存入力が失われても直前の保存済みstateは壊れないことを確認する。
- `npm run test:coverage`: integration 実行時に Chrome DevTools Protocol の precise coverage を取得し、対象スクリプトの coverage を集計する。

`test:ui` に含まれる `tests/modal-ui-regressions.mjs` は、検索・設定・ごみ箱・ヘルプ・通知・確認・入力・保存と長文表示を、日本語／英語、ライト／ダーク、320／768／1280pxの組み合わせで検証する。閉じるボタンと操作ボタンの可視性、本文だけのスクロール、入力のラベル、初期フォーカス、Tab循環、×・Esc・背景クリックで閉じた後のフォーカス復帰、外側へのドラッグで誤って閉じないこと、重なった確認ダイアログの独立した終了を確認する。

## 保存の信頼性と連続運転

### 保存の連続運転テスト

```sh
npm run test:soak
SOAK_SECONDS=3600 SOAK_REPORT=reports/storage-soak.json npm run test:soak
SOAK_SECONDS=600 SOAK_RELOAD_SECONDS=0 SOAK_CRASHES=0 SOAK_REPORT=reports/storage-continuous.json npm run test:soak
```

`tests/run-soak.mjs` は標準で実時間15分間実行する。`SOAK_SECONDS` は10〜86400秒、`SOAK_REPORT` は結果JSONの任意の出力先。開始前に配布ソースの同期を検査する。短い時間への変更は検証器の動作確認用であり、長時間検証の代わりにはならない。

`SOAK_RELOAD_SECONDS=0 SOAK_CRASHES=0` は再読み込みと強制終了を行わず、同じタブでのメモリ保持を確認する。通常モードの定期的な再読み込みでリークが隠れることを避けるため、両方の実行結果を区別して記録する。最後のHTML復元確認はどちらのモードでも行う。

- 専用の一時ChromeプロファイルとループバックHTTPサーバーを使用する。ユーザーのブラウザ・ノート・実ファイルは使わない。
- 合成データ20ページ・800本文ブロックと128KiB添付1件を使い、DOMへの編集、ページ切替、保存、保存内容との一致確認を繰り返す。
- 約30秒ごとに実際に再読み込みし、保存済みstate全体を比較する。約60秒ごとにアイドル自動保存後の不変性と、GC後のJavaScript heap・DOM node数を記録する。
- 保存容量不足とIndexedDB停止を差し込み、既存データの保持・localStorage退避・通常保存への復帰を確認する。重複保存で古い要求が棄却された場合は、最新の要求が完了するまで有限回待つ。
- 実行時間の1/3・2/3時点でテスト用ChromeだけをSIGKILLし、同じ一時プロファイルで起動し直して、直前に保存完了したstateの完全一致を確認する。
- 最後に既存のHTML保存操作でバックアップを生成し、テスト用originの保存領域を全削除する。ブラウザ内のコピーが失われることと、HTMLからページ・添付・文書名を復元できることを検証する。
- 未処理例外、内容の不一致、保存後のデータ消失で失敗する。GC後のheap増加64MiB以上も失敗として扱い、保存確認時間の中央値・95パーセンタイルを記録する。

この試験はOSの電源断、ディスク故障、OSによるメモリ圧迫、Safari / Firefox、モバイル端末を再現しない。15分の成功を数日・数か月の保証とは扱わない。記録する保存時間にはテスト用の読み出し・照合と障害回復の待機も含まれ、画面入力の応答時間そのものではない。

### 保存構造と保護の確認

Web Locks対応環境では、通常保存とlocalStorageへの退避保存に共通の保存権を、最初に取得したタブが閉じるまで保持する。保存ごとの排他だけでは、IndexedDBに成功してlocalStorageのコピーだけ更新できない場合や、別タブが古いコピーを読む場合を保護できないため。同じ保存先を開いた別タブの保存を停止し、未保存の編集と既存のHTML書き出しを維持する。終了時の同期退避も保存権のあるタブだけが行う。保存権の取得を拒否されたタブは、元のタブを閉じた後も再読み込みまで保存を再開しない。Web Locks非対応環境では、既存のtransaction内の比較と他タブ通知による保護を継続するが、同じ保証にはならない。

`tests/storage-writer-regressions.mjs` は `npm test` / `test:integration` / `test:storage` に含まれる。追加6件だけを実行する場合は `node tests/run-browser.mjs storage-writer` を使う。実際のlocalStorage容量超過、通知欠落、古い読み出し値、未保存タブの終了処理、保存権の解放と再取得を検証する。`STORAGE_WRITER_SOURCE=/absolute/path/to/LeafNote.html` で修正前ソースにも同じ試験を適用できる。[修正・検証記録](reports/storage-writer-fix-2026-09-23.md)。

IndexedDBの `state` storeには、現在の `app-state` と、同じ文書の直前の異なる保存状態 `app-state-previous` を保持する。2件は同じreadwrite transactionで更新し、対応ブラウザには `durability: 'strict'` を指定する。同一状態の再保存で予備を潰さず、別文書に切り替える場合は古い文書の予備を持ち越さない。

起動時は基本構造が読める保存候補だけを比較する。IndexedDBの現在値が壊れていれば予備を読み、localStorageの正常な最新値も比較する。どの保存候補も壊れている場合は、空の初期文書で原本を上書きしない。IndexedDBのopenが停止した場合は4秒で待機を打ち切り、利用できるlocalStorageへ進む。

予備は1世代だけで、内容が論理的に正しいことまで自動判定する仕組みではない。保存容量は現在の文書に加えて最大1世代分増える。ブラウザ内の全コピーは同じ削除範囲にあるため、ブラウザ外のHTMLバックアップの代わりにはならない。

通常の保存回帰テストには、Chromeの `Storage.overrideQuotaForOrigin` でテストoriginを128KiBに制限し、ランダムな8MiB添付の保存を試すケースも含む。IndexedDBとlocalStorageの両方で実際に容量不足になっても元の保存値と編集中の内容を維持し、制限解除後に再保存できることを確認する。OSの空きディスクを埋めるテストではない。

## 内部品質の追加検証

`tests/polish-quality-regressions.mjs` は `test:quality` / `test:unit` / `npm test` に含まれる追加8件。種類変更時の仕様・決定事項の保全と容量超過時の原本保持、大きい本文のMarkdown変換での改行保持、既存欄へのキーボード移動、修飾キー付きBackspace、Unicode検索強調、検索IMEと終了後タイマー、画像の代替テキスト同期を検証する。単独実行は `node tests/run-polish-quality.mjs`。`QUALITY_POLISH_SOURCE`で比較対象HTMLを指定できる。`tests/run-polish-input-audit.mjs` は `QUALITY_BASELINE_DIR` の変更前ソースと実キー入力・IME・検索結果のDOM更新数を比較する。[全262件と画面比較の記録](reports/quality-polish-2026-09-23.md)。

`tests/complete-quality-regressions.mjs` は `test:quality` / `test:unit` / `npm test` に含まれる追加8件。数式プレビューの蓄積、変更のないプレビューの再生成、表・キャプション等の装飾同期、画像エラー後の置換操作、native入力欄のIME・容量上限での貼り付け・確認後の選択復元・Undo/Redoを検証する。単独実行は `node tests/run-complete-quality.mjs`。`tests/run-complete-input-audit.mjs` は `QUALITY_BASELINE_DIR` の変更前HTMLと比較し、CDPの入力・IME・ネイティブ編集コマンドとDOM更新数を検査する。[改善内容と全254件の検証記録](reports/quality-complete-2026-09-23.md)。

`tests/silent-quality-regressions.mjs` は `test:quality` / `test:unit` / `npm test` に含まれる追加16件。タイトル・文書名のUndo/Redoと表示の一致、選択方向・改行位置、IME、モーダル背後の切り取り防止、ブラウザのTabショートカット、サイドバーのフォーカスとDOM保持、ToDoのチェック状態、Markdown取り込み・貼り付け時の欠落防止を検証する。単独実行は `node tests/run-silent-quality.mjs`。改善内容・修正前の再現ログ・最終244件の記録は [追加品質レポート](reports/quality-next-2026-09-23.md) を参照。

`tests/run-silent-audit.mjs` は変更前の3つのHTMLを置いたディレクトリを `QUALITY_BASELINE_DIR` に指定して実行する。静的HTML/CSS・辞書・320/768/1280pxの表示テキスト/操作部品/スクリーンショットの同一性、タイトル入力時のページ項目再生成数、Chrome DevTools Protocolによる実入力のUndoとIMEを検査する。`QUALITY_AUDIT_REPORT` でJSONの出力先を指定できる。変更前後には独立した一時ブラウザプロファイルを用い、共有保存先の競合を画面差分と誤認しない。

`tests/ten-rounds-regressions.mjs` は `test:quality` / `test:unit` / `npm test` に含まれる。修飾キー付きの矢印操作、改行境界、コードのTabと容量上限、Unicode境界、タイトルの貼り付け保護、コピー時の選択復元、IME確定、番号の不要更新、保存用通信の解放、Markdown自動変換の装飾保持を検証する。10回を順番に調査・修正・検証した記録は [10回の改善レポート](reports/ten-rounds-quality-2026-09-23.md) を参照。

```sh
node tests/run-ten-rounds.mjs
ROUND=7 node tests/run-ten-rounds.mjs
```

上のコマンドは今回の追加回帰だけ、または指定回だけを実行する。一時Chromeプロファイルを使用する。実行時刻・対象ソースのSHA-256・成功件数を出力する。配布チェックは別途 `npm run check:distribution` で実行する。

`tests/interaction-regressions.mjs` は `test:quality` / `test:unit` / `npm test` に含まれる。コード色付け時の選択方向・長文の選択位置・IME確定・不要な色付けの抑制、入れ子へのファイルドロップ、最前面だけを閉じるEscape、モーダル中の文書操作防止、担当者欄の空白、表の端からのTab移動を検証する。ケース間で残ったモーダルはランナーが片付け、別ケースへ持ち越さない。


`tests/editing-regressions.mjs` は `test:quality` / `test:unit` / `npm test` に含まれる。タイトル・文書名の空白と全削除、複数行貼り付けの選択範囲・末尾の装飾・改行コード・空行・Undo / Redo、本文と表への貼り付け時の容量保護、サニタイズ後の選択方向と改行位置、検索入力直後のEnter、IME変換中の装飾操作、空のh4からの改行を検証する。


追加の品質回帰では、固定seedの参照モデルと2,048手順のページ作成・削除・復元・完全削除を比較し、途中で保存形式への往復を挟む。破損JSONについても112通りのフィールド型を検証する。これらの件数は通常のテスト件数とは別に扱う。

保存の追加保護として、同じsnapshotの保存要求は実行中のPromiseを共有する。IndexedDB transactionとWeb Locksの取得待ちは15秒で打ち切る。ロックを取れない場合には、競合保護なしの書き込みへ切り替えない。Undo用の編集前snapshotはディスク保存の成功とは独立して保持し、単独snapshot上限を超える場合は余分な全文コピーを保持しない。

Chrome以外のChromium系ブラウザは `CHROME_BIN` を指定して同じ検証器で実行できる。2026-09-22の追試ではChromeとBraveを使用した。Braveの成功はSafari / Firefoxの代用とは扱わない。連続試験・大容量試験のJSONには、検証した `leaf-note.html` のSHA-256を記録する。

## Coverage 定義

coverage は Chrome DevTools Protocol で取得した JavaScript の precise coverage を基準にする。

- 分母: `leaf-note.html` に含まれるアプリケーション JavaScript のうち、実行可能な関数範囲。
- 分子: テスト実行中に V8 が実行済みとして報告した関数範囲。
- 集計単位: 関数 coverage を主指標とし、必要に応じて byte range coverage を補助情報として扱う。
- 判定対象: アプリケーション本体の挙動に関わる inline script。
- 判定対象外: HTML/CSS、テストコード、Node.js 側のテストハーネス、Chrome DevTools Protocol 接続処理、外部ブラウザ実装。

coverage は品質確認の補助指標であり、ユーザー操作の成功、保存データの整合性、セキュリティ回帰テストの結果を優先して判定する。

## 対象範囲

unit test では次の範囲を優先する。

- 状態 revision の比較と選択。
- HTML / 属性 / URL のサニタイズ境界。
- Markdown 変換のリンク生成。
- 保存データの正規化、移行、フォールバック判定。

integration test では次の範囲を優先する。

- 初回表示と主要 UI の起動。
- ドキュメント作成、編集、保存、再読み込み後の復元。
- IndexedDB と localStorage の復元優先順位。
- ダイアログ入力値に引用符などを含めた場合の属性安全性。
- Markdown リンクに引用符などを含めた場合の属性安全性。
- ファイル添付時の保存、復元、容量増加時の挙動。
- 同一 origin の複数タブで競合する編集と終了時保存。正常な IndexedDB、localStorage へのフォールバック、両者が混在する場合を含む。
- IndexedDB の読み取りエラー、トランザクション中断、書き込み時の同期例外からの復帰と接続解放。
- Undo / Redo の未保存判定、保存 revision、エクスポート済み HTML の再読み込み時の復元。
- 別文書の埋め込み状態と既存ブラウザ保存の保護、競合中の HTML バックアップ。
- 閉じたサイドバーへのフォーカス侵入防止、設定の再描画後のフォーカス、モーダルの背後への操作防止。
- 配布 HTML ダウンロードの本体との完全一致、失敗時の復帰、コピー失敗時の一時要素の解放、320 / 768 / 1280px の表示範囲。

複数タブの保存テストはループバック HTTP サーバーで同一 origin を作る。保存内容はテスト用の合成データで、サーバーと一時プロファイルは終了時に片付ける。ダウンロードのテストは Blob 内容とファイル名を確認し、OS の保存ダイアログ操作は対象にしない。

## 除外範囲

次の項目は自動テストの必須対象外とする。

- ブラウザ本体、IndexedDB 実装、localStorage 実装の内部挙動。
- OS や Chrome のファイル選択ダイアログそのもの。
- スクリーンショットのピクセル完全一致。
- README やライセンスなどドキュメント本文の表記確認。
- 手動確認が前提のアクセシビリティ、表示崩れ、長時間利用時の体感性能。

## トラブルシュート

- `npm` scripts が見つからない場合は、`package.json` に `test` / `test:unit` / `test:integration` / `test:coverage` が定義されているか確認する。
- Chrome 起動に失敗する場合は、Chrome がインストール済みであること、ヘッドレス起動を妨げる既存プロセスや権限設定がないことを確認する。
- `WebSocket is not defined` が出る場合は、`node --version` を確認して Node.js 22 以上で実行する。
- 配布チェックで不一致が出る場合は `npm run build` で同期して差分を確認する。要素の欠落・重複や JSON の破損は `index.html` の `script#leafnote-source` を修正してから再実行する。
- DevTools Protocol 接続に失敗する場合は、Chrome の remote debugging port がテストハーネス側の接続先と一致しているか確認する。
- IndexedDB / localStorage の結果が不安定な場合は、テストごとに origin と保存領域を初期化しているか確認する。
- coverage が 0% になる場合は、coverage 開始前に対象ページを読み込んでいないか、または対象 URL のフィルタが `leaf-note.html` / `index.html` と一致しているか確認する。
- integration test がタイムアウトする場合は、画面操作後に DOM 更新、保存完了、非同期処理完了を待つ条件が具体的か確認する。


## Source modernization gates (2026-10-10)

Run `npm run check` for active inline JS, CSS, JS modules, JSON, module formatting and embedded distribution checks. `npm run test:modernization` verifies HTML serialization equivalence, search freshness/IME/cache disposal, scoped gutter updates and persisted state. `npm run format` formats all active JS modules and package.json. Acorn parses ECMAScript 2026; selected ESLint rules check correctness, const bindings, var and unused catch bindings. Metadata, dependencies and frozen historical reports are distinguished from active managed sources. Python measurement scripts were separately compiled for syntax. Dynamic generated test expressions, full HTML conformance, browser compatibility and GitHub YAML interpretation need additional runtime validation; parser success alone cannot establish these.

The working folder uses `leaf-note.html`. Production source snapshots use `src/LeafNote.html.in` and generated `LeafNote.html`. Keep local and historical production results distinct.

Node 22.13+ (22.x) or 24+ is required by ESLint 10; production remains static HTML without a Node runtime. Existing browser requirements remain unchanged. Prefer const and optional catch bindings, standard DOM APIs and bounded value-keyed caches. Retain final input/drop/save contracts when coalescing work. Keep execCommand only for existing native editing and offline clipboard fallback behavior, and keyCode/which 229 only for existing IME compatibility alongside isComposing. JSON snapshot copies intentionally preserve JSON serialization semantics, which differ from structuredClone. Vendor font/scrollbar/color-control styles retain current pixels until the minimum supported browsers and equivalent standard styling are established.

Official references checked 2026-10-10: https://262.ecma-international.org/ ; https://html.spec.whatwg.org/ ; https://dom.spec.whatwg.org/ ; https://www.w3.org/TR/uievents/ ; https://w3c.github.io/clipboard-apis/ ; https://www.w3.org/TR/css-cascade-5/ ; https://eslint.org/blog/2026/02/eslint-v10.0.0-released/ . Detailed production evidence and remaining work are in reports/modernization-2026-10-10.

## 2026-10-10: 選択座標と複数ブラウザの検証

範囲選択中の座標は文書座標で保持し、DOM変更・サイズ変更・画像読み込み・フォント読み込み・エディター以外のスクロールで無効化する。選択クラスだけの変更は座標に影響しないため再取得しない。実行中のアニメーションや監視APIがない環境では毎回取得する。mouseupでは必ず最新の座標を使い、blur・非表示への移行でも監視と保留フレームを解放する。これは既存の対応ブラウザの最低条件を引き上げない。

```sh
npm ci
npx playwright install firefox webkit
npm run test:selection
node tests/selection-geometry-regressions.mjs leaf-note.html firefox
node tests/selection-geometry-regressions.mjs leaf-note.html webkit
node tests/run-cross-browser.mjs firefox
node tests/run-cross-browser.mjs webkit
npm run test:leaf-note
```

`npm test` と `test:leaf-note` はLeafNote、配布ページ、保存と保存権の検証を対象とする。GitHub Actionsは無効化済みで、ワークフローを追加しない。

PlaywrightのWebKitは実機Safariではない。Chrome専用のタッチエミュレーションを使う2テストは複数ブラウザランナーで未検証として出力し、Chromeの総合テストでは実行する。最低対応ブラウザ・WebViewは未指定なので別途確定が必要。アプリ自身の構文/APIの最低条件は変更しない。

`measure-screen-actions.mjs`と`measure-selection.mjs`は一時プロファイルの合成データだけを使う。ハンドラーCPU、正しいDOMと次フレーム、強制保存と読み直しを区別する。DOMと次フレームの時間を画面の表示完了やINPと呼ばない。`trace-selection-frames.mjs`は入力・合成・presentationを含む生トレースを保存し、EventLatencyは対応する開始/終了IDを使って集計する。ヘッドレス合成のpresentationは実機ディスプレイの提示を証明しない。並行した測定は探索用として別ファイルに保存する。

`inventory-ui.mjs`は編集元と独自のindexから静的な操作登録・動的UIの作成箇所・バックグラウンド処理を抽出する。登録数は利用者の操作数ではない。代表ケースの対応表と未計測の指標を併記する。生成されたアプリとindex内の同一JSONコピーは重複集計しない。

Python 3.15.0の公式安定ソースを一時構築し、4本の測定用PythonをAST検査した（2026-10-10）。`PYTHON_BIN`で検査interpreterを指定できる。Ubuntu24.04のactions/python-versionsには安定3.15 binaryが未提供だったため、作業CI設定には提供済みの保守版3.14.8を使う。本番管理ソースにPythonはないので本番Node/browser CIには不要なPython setupを含めない。一時3.15 buildは構文検査用で、SSLなどoptional moduleの完全なruntime環境ではない。測定接続の解放はfinallyで行い、profileの削除は所有権を確認するstopBrowserに一本化する。

`browser-ime-regressions.mjs` runs five Chrome-generated composition trials for text, title, deferred search, cancellation and persisted readback. The CDP test transport is experimental; the application adds no experimental runtime API. Start/update and preedit input events are trusted; Chromium reports compositionend as untrusted in this transport. Raw flags are retained. This does not verify OS candidate selection, physical IME keys, Firefox or Safari IME.

`checkbox-keyboard-regressions.mjs SOURCE [chrome|firefox|webkit]` locates the native checkbox by accessible name and uses trusted Space key dispatch to toggle twice while preserving focus and checking persisted readback, five trials per engine. This is not a physical keyboard or screen-reader test. Cross-block metadata aliases are rejected for subsequent reuse so JSON history restores independent objects.

### Sidebar resize finalization

`sidebar-resize-regressions.mjs SOURCE [chrome|firefox|webkit]` checks latest-value frame batching, immediate final width and localStorage readback, bounds, double-click reset, blur/visibility cleanup, inactive movement and repeated gestures. Working source retains its existing pointer capture, keyboard controls and preferred-width behavior. Production retains mouse input and its existing bounds. The frame scheduler uses existing standard requestAnimationFrame/cancelAnimationFrame and flushes synchronously when animation APIs are unavailable. No new minimum API requirement is introduced. Pending updates must flush before finalization/persistence and cancel before reset.

`measure-sidebar-resize.mjs SOURCE OUTPUT` uses 60 synthetic move events in one task, and separates handler, finalization and two-frame proxies. It is not native input latency. `measure-native-resize.mjs SOURCE OUTPUT` checks 300 native CDP moves at 100/1000 blocks and ten final saved widths, with raw compositor traces. Inputs are self-paced, not fixed-frequency physical dragging, FPS or INP. Run timing measurements sequentially without other browser workloads.

`block-drag-regressions.mjs SOURCE [chrome|firefox|webkit] [OUTPUT]` uses browser mouse dragTo for before/after, numbered, nested and TOC fixtures, checking model/DOM order, undo/redo, cleared markers and final forced persistence/readback. Nested drops belong to their nearest block; propagation must not move the same block again or duplicate file insertion. This is separate from direct API move tests and does not measure physical pointer/touch latency. Raw event trust flags are recorded.

### Search result navigation and manual release

`node tests/search-navigation-regressions.mjs SOURCE [chrome|firefox|webkit] [OUTPUT]` checks wraparound, repeated hover, the selected DOM/index invariant, IME composition, Enter to open/create and Escape. Five trials use 600 synthetic keys and 600 synthetic hover events each. Instrumented class removals and handler CPU are separate from native input latency. Search retains its existing 50-result limit, query debounce and composition rules. Selection changes update only the old and new candidates; hovering the already-selected candidate does not rewrite its class.

`node tests/measure-native-search.mjs SOURCE OUTPUT` measures 500 trusted Chrome DevTools ArrowDown key events across five trials at CPU throttling rate 4 and 1280×800. Each key is followed by two animation frames. Handler CPU samples and protocol/frame-paced total duration are recorded separately; neither is INP, physical FPS or proof of displayed pixels. Run before/after timing measurements sequentially.

GitHub Actions stays disabled. There are no repository workflows; do not restore the old quality workflow. Existing GitHub Pages content stays online, but its branch-triggered publication was stopped. GitHub Pages deployments internally require Actions even when using branch publication. Until a separate manual deployment destination is specified, a commit or release ZIP is not a production deployment, and local after-results must not be reported as production after-results. The current checkout's static release contains `index.html`, `leaf-note.html`, `.nojekyll` and `LICENSE`. Migrating hosting also changes the origin of IndexedDB/localStorage; provide an explicit export/import migration route before directing existing users to a new origin.
