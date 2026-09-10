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

アプリ本体の編集元は `LeafNote.html`。`index.html` は配布用に同じソースを `script#leafnote-source` の JSON 文字列として保持している。本体を変更したら、次の順に同期して確認する。

```sh
npm run build
npm run check:distribution
npm test
```

- `npm run build`: `LeafNote.html` を JSON 化し、`<` を `\u003c` に置き換えて `index.html` の既存の JSON ペイロードだけを更新する。ランディングページやそのスクリプトは変更しない。両ファイルの差分をレビューし、両方を配布する。
- `npm run check:distribution`: ファイルを変更せず、本体との不一致、埋め込み要素の欠落・重複、JSON 型や構文の不正、未エスケープの `<` を検出したら終了コード 1 を返す。配布用要素の構造や JSON が壊れている場合は `build` も停止するため、先にその破損を修正する。
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
