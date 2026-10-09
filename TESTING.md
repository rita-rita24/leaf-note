# テスト方針

このドキュメントは LeafNote のテスト実行方法、coverage の定義、対象範囲、除外範囲、トラブルシュートをまとめる。テストは追加ライブラリを使わず、Node.js 標準機能と Chrome DevTools Protocol で実行する方針とする。

## 実行方法

作業ディレクトリはリポジトリルートとする。追加の npm パッケージのインストールは不要。

### 前提

- Node.js 22 以上と npm。テストランナーは Node.js のグローバル `WebSocket` を Chrome DevTools Protocol への接続に使用するため、Node.js 18 などでは実行できない。
- ヘッドレス起動できる Chrome または Chromium。unit テストもアプリをブラウザで読み込むため必要。ランナーは macOS の Chrome / Chromium / Brave / Edge、Linux の `/usr/bin/google-chrome` / `/usr/bin/chromium` / `/usr/bin/chromium-browser` を探す。他の場所にある場合は `CHROME_BIN` に実行ファイルの絶対パスを指定する。
- ローカルのブラウザプロセス起動と `127.0.0.1` の一時ポートへの接続が許可されていること。テストには一時プロファイルを使用する。

```sh
node --version
CHROME_BIN="/absolute/path/to/chrome" npm test
```

### 配布ファイルの同期

アプリ本体の編集元は `src/LeafNote.html.in`、配信用の生成物は `LeafNote.html`。`index.html` は配布用に同じソースを `script#leafnote-source` の JSON 文字列として保持している。本体を変更したら、次の順に同期して確認する。

```sh
npm ci
npm run build
npm run check:distribution
npm test
```

- `npm run build`: 編集元のJavaScriptを圧縮して `LeafNote.html` を生成し、そのHTMLを JSON 化して、`<` を `\u003c` に置き換えて `index.html` の既存の JSON ペイロードだけを更新する。ランディングページやそのスクリプトは変更しない。両ファイルの差分をレビューし、両方を配布する。
- `npm run check:distribution`: ファイルを変更せず、圧縮HTMLの生成元との不一致、および本体との不一致、埋め込み要素の欠落・重複、JSON 型や構文の不正、未エスケープの `<` を検出したら終了コード 1 を返す。配布用要素の構造や JSON が壊れている場合は `build` も停止するため、先にその破損を修正する。
- `npm test` の前には `pretest` が配布チェックを実行する。未同期の配布物を自動修正して隠さず、テスト開始前に失敗させる。個別の `test:unit` / `test:integration` / `test:coverage` では `pretest` は実行されないため、先に `npm run check:distribution` を実行する。

### ブラウザテスト

```sh
npm test
npm run test:unit
npm run test:integration
npm run test:coverage
```

- `npm test`: unit / integration をまとめて実行する総合コマンド。
- `npm run test:unit`: UI 操作を主目的にしない純粋関数や状態変換を、Chrome DevTools Protocol ランナー経由でアプリのテスト API から検証する。
- `npm run test:integration`: Chrome を起動し、Chrome DevTools Protocol 経由で実画面上の操作、永続化、DOM 反映を検証する。
- `npm run test:coverage`: integration 実行時に Chrome DevTools Protocol の precise coverage を取得し、対象スクリプトの coverage を集計する。

## Coverage 定義

coverage は Chrome DevTools Protocol で取得した JavaScript の precise coverage を基準にする。

- 分母: `LeafNote.html` に含まれるアプリケーション JavaScript のうち、実行可能な関数範囲。
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
- coverage が 0% になる場合は、coverage 開始前に対象ページを読み込んでいないか、または対象 URL のフィルタが `LeafNote.html` / `index.html` と一致しているか確認する。
- integration test がタイムアウトする場合は、画面操作後に DOM 更新、保存完了、非同期処理完了を待つ条件が具体的か確認する。

## 配信用HTMLの生成

`npm ci` 後、編集するアプリ本体は `src/LeafNote.html.in` です。`npm run build` でJavaScriptを圧縮した `LeafNote.html` と、それを内包する `index.html` を生成します。圧縮器は開発時だけ使い、実行時の追加通信・依存はありません。`npm run check:distribution` は両方の生成物を確認します。生成された `LeafNote.html` の直接編集は次のビルドで上書きされます。


## 2026-10-10 source standards and regression gates

Edit `src/LeafNote.html.in` and rebuild; do not patch generated `LeafNote.html` or the JSON payload in `index.html`. Runtime HTML stays portable and offline. Development requires Node.js 22.13+ (22.x) or 24+ because ESLint 10 requires these versions. CI checks maintained Node 22, LTS 24 and current 26. This does not change browser requirements.

Run `npm ci`, `npm run build`, `npm test`, `npm run test:modernization`, and `node tests/check-drag-performance.mjs LeafNote.html`. `npm run check:source` parses all active HTML scripts, CSS and JavaScript using Acorn (ECMAScript 2026), parse5, PostCSS and selected ESLint correctness rules. It checks optional catch bindings and selected legacy APIs. `npm run check:format` checks all active JavaScript modules and the package manifest. No existing source file is blanket-excluded. Git metadata, installed dependency code and historical reports/release snapshots are listed exclusions. Generated application JS is parsed but must be changed through its source. JSON data scripts are parsed as JSON. Dynamically assembled test expressions are covered by browser execution; static analysis does not fully validate their interpolated output. YAML needs GitHub's workflow validator; CSS parsing is not a browser compatibility test, and HTML parsing is not a full conformance validator.

Use `const` for bindings that do not change, optional catch bindings when the exception is intentionally unused, standard DOM operations, cancellable asynchronous work, and bounded caches keyed by actual input values. Keep plain conditionals, loops and callbacks when appropriate. Avoid `var`, `substr`, `getYear`, `setYear`, `Range.detach`, global `escape`/`unescape`, wrapper constructors and asynchronous Promise executors. Never replace falsy defaults mechanically or alter supported browser requirements to adopt new syntax.

Known compatibility exceptions: `document.execCommand` remains confined to native rich editing/copy fallbacks; Clipboard API is the preferred async path. Removing it would change native undo or disable copying in offline/non-secure or denied-permission contexts. IME keyCode/which 229 guards remain alongside `isComposing` for existing composition edge cases and regression coverage. Resolve these only after equivalent native undo, clipboard and supported IME behavior is demonstrated in Chrome, Firefox and Safari. Prism is an optional externally supplied host global accessed explicitly as `window.Prism`; no runtime Prism dependency is added.

Official references checked 2026-10-10: [ECMAScript 2026](https://262.ecma-international.org/), [HTML Living Standard](https://html.spec.whatwg.org/), [DOM Standard](https://dom.spec.whatwg.org/), [UI Events](https://www.w3.org/TR/uievents/), [Clipboard](https://w3c.github.io/clipboard-apis/), [CSS Cascade](https://www.w3.org/TR/css-cascade-5/), [ESLint 10](https://eslint.org/blog/2026/02/eslint-v10.0.0-released/), [Node releases](https://nodejs.org/en/about/previous-releases), [Prettier options](https://prettier.io/docs/options.html).

Performance endpoints must distinguish CPU helper time, correct DOM plus next animation-frame proxies, actual recorded paint events, and persisted data readback. Do not report a rendering proxy as actual pixels, INP or drag smoothness. Preserve source hashes, browser version, CPU/network emulation, data, trials, raw samples and unmeasured cases. Treat differences within trial variability as unconfirmed. Deployment requires the previous production baseline, a reproducible build and successful regression checks. Verify deployed file hashes before comparing production samples. Roll back by reverting the release commit and verifying the prior HTML hashes and critical editing/saving operations.

## 2026-10-10: 選択座標と複数ブラウザの検証

範囲選択中の座標は文書座標で保持し、DOM変更・サイズ変更・画像読み込み・フォント読み込み・エディター以外のスクロールで無効化する。選択クラスだけの変更は座標に影響しないため再取得しない。実行中のアニメーションや監視APIがない環境では毎回取得する。mouseupでは必ず最新の座標を使い、blur・非表示への移行でも監視と保留フレームを解放する。これは既存の対応ブラウザの最低条件を引き上げない。

```sh
npm ci
npx playwright install firefox webkit
npm run test:selection
node tests/selection-geometry-regressions.mjs LeafNote.html firefox
node tests/selection-geometry-regressions.mjs LeafNote.html webkit
node tests/run-cross-browser.mjs firefox
node tests/run-cross-browser.mjs webkit
npm run test:leaf-note
```

`test:leaf-note`はLeafNote、配布ページ、保存と保存権の検証を明示的に対象とする。`npm test`は従来どおりMaskingerも対象とする。作業フォルダーでは以前からMaskingerが削除されており、`npm test`全体の成功を主張しない。本番リリースのCIは3画面すべてを検証する。

PlaywrightのWebKitは実機Safariではない。Chrome専用のタッチエミュレーションを使う2テストは複数ブラウザランナーで未検証として出力し、Chromeの総合テストでは実行する。最低対応ブラウザ・WebViewは未指定なので別途確定が必要。アプリ自身の構文/APIの最低条件は変更しない。

`measure-screen-actions.mjs`と`measure-selection.mjs`は一時プロファイルの合成データだけを使う。ハンドラーCPU、正しいDOMと次フレーム、強制保存と読み直しを区別する。DOMと次フレームの時間を画面の表示完了やINPと呼ばない。`trace-selection-frames.mjs`は入力・合成・presentationを含む生トレースを保存し、EventLatencyは対応する開始/終了IDを使って集計する。ヘッドレス合成のpresentationは実機ディスプレイの提示を証明しない。並行した測定は探索用として別ファイルに保存する。

`inventory-ui.mjs`は編集元、独自のindex、Maskingerから静的な操作登録・動的UIの作成箇所・バックグラウンド処理を抽出する。登録数は利用者の操作数ではない。代表ケースの対応表と未計測の指標を併記する。生成されたアプリとindex内の同一JSONコピーは重複集計しない。

Maskingerの対応表は専用の追加関数で管理し、正規化済み文字列フィールドをその場で変更しない。UTF-8容量は空配列2バイト＋各JSONレコード＋区切りカンマを加算し、巻き戻し時には全体から再計算する。表示と復元索引は対応表の変更で無効化する。clearでは旧索引を即時破棄する。`maskinger-incremental-regressions.mjs`でUnicode・制御文字・孤立サロゲート、同件数置換、保存容量の厳密な境界、超過時の巻き戻しと保存データ、破棄後の復元を検証する。

Python 3.15.0 is stable, but actions/python-versions has no stable Ubuntu 24.04 binary on the audit date. Production manages no Python sources, so its Node/browser jobs do not provision an unused Python runtime. The working source has four Python scripts and requires separate Python syntax validation; this environment constraint is recorded rather than using a release candidate.

### Cross-store persistence and focused history

`node tests/storage-mirror-regressions.mjs LeafNote.html [chrome|firefox|webkit]` runs five isolated browser contexts. It suppresses cross-tab notifications, injects a localStorage mirror write failure after a successful IndexedDB commit, and checks that a fallback-only tab keeps its draft without overwriting stored content. It also checks owner close, denied-tab retry and a fresh reload. Web Locks grants one writer per open document session; a denied tab must reload before saving. Browsers without Web Locks retain the existing fallback path and are not covered by this ownership guarantee.

`node tests/history-focused-regressions.mjs LeafNote.html [chrome|firefox|webkit]` checks focused title and document-name undo/redo five times, plus language, theme and width restoration. Content history with unchanged language preserves the fixed labels and color menu instead of recreating them. Full block rendering remains in place.
