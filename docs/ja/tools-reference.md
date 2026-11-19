# ツールリファレンス

このページでは、`flow-mcp`（`v0.2.0`）の CLI フラグ、環境変数、MCP リソース、レスポンスオブジェクト、および全 MCP ツールを説明します。

## CLI オプション

```text
flow-mcp [OPTIONS] <COMMAND>
```

`flow-mcp` には既定のサブコマンドがありません。サブコマンドを付けずに `flow-mcp` を起動すると、ヘルプを表示してステータス `2` で終了します。

### サブコマンド

| サブコマンド | 効果 |
| :--- | :--- |
| `serve` | 標準入出力で MCP ツールとリソースを提供します。`--http` を付けると Streamable HTTP で提供します。MCP クライアントはこのサブコマンドを使用します。 |
| `login [--timeout <SECS>] [--force] [--json]` | Google サインイン用に可視 Chrome ウィンドウを開き、サインインの完了まで待機します。`--timeout` は最大待機秒数です（既定 `180`、`15..=3600`）。`--force` は保存済みの Cookie とセッションを先に消去します。 |
| `status [--json]` | サインイン状態を表示します。保存済みのセッションがある場合は、バックグラウンドの Chrome を起動します。 |
| `logout [--json]` | `<home>/chrome-profile` と `<home>/cookies.json` を削除します。 |
| `doctor [--json]` | Chrome バイナリ、`<home>` とファイル権限、インスタンスロック、サインイン状態を確認します。 |

`login`、`status`、`logout` は `flow_login` と同じアクションを使用し、結果フィールドごとに `key: value` を 1 行ずつ出力します。`--json` を付けると、`flow_login` の結果オブジェクトを出力します。`doctor` はチェックごとに 1 行を出力し、ステータスは `ok`、`warn`、`fail`、`skip` のいずれかです。

サブコマンドが最後まで実行されると、終了ステータスは `0` です。未サインインの場合や `doctor` のチェックが失敗した場合も同じです。エラーが発生した場合（たとえばサインインのタイムアウトや、実行中の別の `flow-mcp` が Chrome プロファイルを使用している場合）は `1` です。フラグの値が無効な場合は `2` です。

### HTTP トランスポート

`flow-mcp serve --http <IP:PORT>` は標準入出力の代わりに、`http://<IP:PORT>/mcp` で Streamable HTTP により MCP を提供します。すべての HTTP クライアントは 1 つの Chrome プロセスと 1 つのジョブキューを共有します。

| `serve` オプション | 環境変数 | 効果 |
| :--- | :--- | :--- |
| `--http <IP:PORT>` | `FLOW_MCP_HTTP` | このアドレスで待ち受ける（例：`127.0.0.1:8765`、`0.0.0.0:8765`） |
| `--http-token <TOKEN>` | `FLOW_MCP_HTTP_TOKEN` | 各リクエストに `Authorization: Bearer <TOKEN>` を要求する |

- トークンを設定しない場合、`flow-mcp` はループバックアドレスでのみ待ち受け、ループバックの `Host` ヘッダーのみを受け付けます。
- 他のコンピューターからの接続を受け付けるには、トークンを設定してください。トークンを設定すると、`flow-mcp` は任意のアドレスと任意の `Host` ヘッダーを受け付けます。ループバック以外のアドレスでトークンを設定しない場合、`flow-mcp` はエラーで終了します。
- 同じコンピューターの他のユーザーはコマンドラインを見られるため、トークンはコマンドラインではなく `FLOW_MCP_HTTP_TOKEN` で設定してください。十分に長いランダムな値を使用してください。
- サーバーは平文の HTTP を使用します。VPN など信頼できるネットワークでのみ使用するか、前段に TLS プロキシを置いてください。

### グローバルオプション

これらのオプションはサブコマンドの前後どちらにも書けます。フラグは対応する環境変数に優先します。

| オプション | 環境変数 | 効果 | 既定値と範囲 |
| :--- | :--- | :--- | :--- |
| `--home <PATH>` | `FLOW_MCP_HOME` | `flow-mcp.db`、`downloads/`、`cookies.json`、`chrome-profile/` のルートディレクトリを設定する | `~/.flow-mcp` |
| `--chrome <PATH>` | `FLOW_MCP_CHROME` | Chrome または Chromium バイナリのパスを設定する | OS パスおよび Playwright キャッシュ |
| `--cdp-port <PORT>` | `FLOW_MCP_CDP_PORT` | ローカル Chrome DevTools Protocol TCP ポートを固定する | エフェメラルポート。`1..=65535` |
| `--pause <MIN[,MAX]>` | `FLOW_MCP_PAUSE` | キュー実行ジョブ間のランダムな休止秒数を設定する。値が 1 つの場合は固定の休止、`0` は休止なし | `25,70`。`0..=86400`、`MIN` は `MAX` 以下 |
| `--headless` | `FLOW_MCP_HEADLESS` | バックグラウンドの Chrome をウィンドウ表示ではなく `--headless=new` で実行する。ディスプレイのないマシンで使う。Google Flow はヘッドレス Chrome の生成を不審なアクティビティとして拒否することがある | オフ：Chrome はウィンドウを表示する。ジョブ実行中はそのウィンドウを閉じたり操作したりしない |
| `-h`, `--help` | — | ヘルプを表示して終了する | — |
| `-V`, `--version` | — | バージョンを表示して終了する | — |

値が無効な場合、`flow-mcp` は標準エラー出力にエラーを書き込み、Chrome を起動する前に終了します。

### 0.3 からのアップグレード

- MCP クライアント設定の `"args"` に `serve` を追加します。
- `FLOW_MCP_CHROME_CDP_PORT` を `FLOW_MCP_CDP_PORT` に置き換えます。
- `FLOW_MCP_PAUSE_MIN_S` と `FLOW_MCP_PAUSE_MAX_S` を `FLOW_MCP_PAUSE`（たとえば `25,70`）に置き換えます。

## MCP リソース仕様

- **`resources/list`**：`<home>/downloads` 上の既存ファイルを返します（1 ページ `100` エントリ、`cursor` は整数オフセット文字列）。`flow://downloads/<id>` URI、MIME タイプ、バイトサイズを含みます。
- **`resources/templates/list`**：`flow://downloads/{id}`（SQLite 行 ID）と `flow://downloads/asset/{asset_id}`（Flow アセット ID の最新ダウンロード）を公開します。
- **`resources/read`**：`64 MiB` 以下のファイルに対して Base64 `blob` ペイロードと MIME タイプを返します。より大きなファイルでは invalid-params エラーを返し、`flow_downloads` `action="read_chunk"` を案内します。
- **`resource_link` ブロック**：クライアントが MCP プロトコル `2025-06-18` 以降をネゴシエートした場合（またはバージョンを省略した場合）、`flow_download` は JSON ペイロードに加えて `resource_link` ブロックを追加します。

## 共通レスポンスオブジェクト

![JobQueue 状態遷移と 45 秒インライン待機タイムライン](../assets/ja/job-queue-lifecycle.svg)

- **`JobView`**（`flow_generate`、`flow_agent_images`、`flow_edit`、`flow_video` `extend`、`flow_character`、`flow_character_edit`、`flow_wait`、`flow_cancel`、`flow_retry`）：
  - フィールド：`id`（8 文字文字列）、`status`（`"queued"`、`"running"`、`"done"`、`"failed"`、`"cancelled"`）、`prompt`、`name?`、`mode?`、`model?`、`created_at?`、`started_at?`、`finished_at?`（Unix ミリ秒）、`progress?`、`files?`、`created?`、`resources?`、`error?`、`retried_from?`。
- **`DownloadRecord`**（`flow_download`、`flow_downloads`）：
  - フィールド：`id`、`asset_id`、`project_id?`、`project_title?`、`name`、`kind`、`prompt?`、`source_url?`、`file_path`、`file_name`、`mime_type?`、`size_bytes`、`asset_created_at?`、`downloaded_at`（Unix ミリ秒）、`exists`（bool）、`resource_uri`（`flow://downloads/<id>`）。

---

## 1. セッション・プロジェクトツール

### `flow_status`

Google Flow 認証状態、アクティブプロジェクト、`JobQueue`、SQLite インデックス件数、Chrome 準備状態を確認します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `probe` | `boolean` | いいえ | ページ遷移なしで現在の Chrome ページを確認する場合は `true` を設定します。既定は `false`。 |

`{ flow: FlowStatus, queue: [...], downloads_count, home, db_path, downloads_dir, cookies_saved, profile_dir, ... }` を返します。プロジェクトを自動的に開いたり作成したりしません。

アクティブなページがプロジェクトの場合、`flow.frontend` に `build`（Flow フロントエンドのビルドラベル。`null` の場合あり）、`ok`、`checks` が入ります。各チェックには `name`、`ok`、`detail` があり、このフロントエンドビルドのプロジェクト store をランタイムが使えるかを示します。チェックはプロジェクトを変更しません。 `operations` には、現在のビルドと store で `collection_write` と `asset_trash_store` が使えるかが表示されます。各操作には `ok` と `failed_checks` が含まれます。

### `flow_login`

Chrome 経由でサインインするか、Flow Cookie を管理します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `action` | `string` | いいえ | `"login"`（`"start"`・既定）、`"sync_cookies"`（`"import_cookies"`）、`"save_cookies"`、`"status"`、または `"logout"`（`"reset_session"`、`"clear_cookies"`）。 |
| `wait` | `boolean` | いいえ | `"login"` 時にサインイン完了まで Chrome をポーリングします。既定は `true`。 |
| `timeout_secs` | `integer` | いいえ | `wait=true` 時の最大待機秒数。既定は `180`。 |
| `force` | `boolean` | いいえ | `LoginChrome` 開始前に保存済み Cookie とプロファイルを削除します。既定は `false`。 |
| `cookies` | `object[]` | いいえ | `"sync_cookies"` 用の Cookie 配列。このフィールドを省略すると、`flow-mcp` は `<home>/cookies.json` を読み込みます。 |

### `flow_new_project`

Flow ホームページを開き、プロジェクトを作成して、必要に応じてタイトルを設定します。`created`、`clicked`、`project_id`、`title`、`url` を返します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `title` | `string` | いいえ | 作成後に `flow-mcp` が適用するプロジェクトタイトル。 |

### `flow_projects`

Google Flow プロジェクトを一覧表示、作成、開く、名前変更、または削除します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `action` | `string` | いいえ | `"list"`（既定）、`"create"`、`"open"`、`"rename"`、または `"delete"`。 |
| `id` | `string` | いいえ | `"open"`、`"rename"`、または `"delete"` 用の対象プロジェクト ID。 |
| `title` | `string` | いいえ | `"create"` または `"rename"` 用の新しいタイトル、あるいは `"open"` / `"delete"` 用の大文字小文字を区別しないタイトル一致。 |

---

## 2. キャラクター・ボイスツール

### `flow_voices`

Google Flow でキャラクターボイスピッカーを開き、リスト全体をスクロールしてすべてのボイスを一覧表示します。保存済みのカスタムボイスには `"custom": true` が付きます。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `character` | `string` | いいえ | ボイスピッカーを開くための任意の対象キャラクター ID または名前。 |

### `flow_character`

`JobQueue` へキャラクター作成ジョブを登録し、メタデータ（`id`、`project_id`、`name`、`bio`、`voice`、`ref_asset_ids`）を SQLite に保存します。`JobView` を返します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `name` | `string` | はい | キャラクター表示名。 |
| `description` | `string` | いいえ | 外見説明。`bio` を省略すると、`flow-mcp` はこのテキストを `bio` として使用します。 |
| `bio` | `string` | いいえ | 紹介文または性格メモ。 |
| `voice` | `string` | いいえ | ボイス名（たとえば `"Kore"`、`"Charon"`、または `flow_voices` から取得した名前）。 |
| `voice_sample` | `string` | いいえ | カスタムボイスの Sample dialogue(最大 120 文字)。ベースボイスとして `voice` が必要です。 |
| `voice_performance` | `string` | いいえ | カスタムボイスの Customize performance テキスト(言語、年齢、口調、速さ)。ベースボイスとして `voice` が必要です。 |
| `voice_name` | `string` | いいえ | 保存するカスタムボイス名。既定値はキャラクター名です。 |
| `asset_ids` | `string[]` | いいえ | キャラクターの外見として添付する既存プロジェクト画像アセット ID。 |
| `refs` | `string[]` | いいえ | 外見としてアップロードするローカル参照画像ファイルパス。 |
| `prompt` | `string` | いいえ | エディタ内でキャラクター外見を生成するためのプロンプト。 |

`voice_sample` または `voice_performance` を指定すると、`flow-mcp` はベースの `voice` を選び、Sample dialogue と Customize performance を入力してカスタムボイスとして保存し、キャラクターに追加します。Google Flow は先に試聴音声を生成するため、30〜60 秒かかることがあります。

### `flow_character_edit`

`/character/<id>` 用の更新ジョブを登録し、SQLite のキャラクターメタデータを更新します。`JobView` を返します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `name` | `string` | はい | 一致させる既存キャラクター ID または名前部分文字列。 |
| `new_name` | `string` | いいえ | 更新後の表示名。 |
| `bio` | `string` | いいえ | 更新後の紹介文またはメモ。 |
| `voice` | `string` | いいえ | 更新後のボイス名。 |
| `voice_sample` | `string` | いいえ | カスタムボイスの Sample dialogue(最大 120 文字)。ベースボイスとして `voice` が必要です。 |
| `voice_performance` | `string` | いいえ | カスタムボイスの Customize performance テキスト(言語、年齢、口調、速さ)。ベースボイスとして `voice` が必要です。 |
| `voice_name` | `string` | いいえ | 保存するカスタムボイス名。既定値はキャラクター名です。 |
| `asset_ids` | `string[]` | いいえ | 外見として添付するプロジェクト画像アセット ID。 |
| `refs` | `string[]` | いいえ | アップロードするローカル参照画像パス。 |
| `prompt` | `string` | いいえ | キャラクターエディタ内での編集または外見生成プロンプト。 |
| `replace_portrait` | `boolean` | いいえ | `asset_ids` で新しいポートレートを添付する前に、現在のポートレートを削除します。 |

### `flow_characters`

アクティブプロジェクト内のキャラクターを一覧表示します。ライブ Flow タイルと SQLite に保存された `bio`、`voice`、`ref_asset_ids` フィールドを統合します。パラメータは不要です。

### `flow_voice_preview`

キャラクターエディタを開いてボイスの試聴を再生し(または `voice` とテキストで保存せずに試聴し)、音声を `<home>/downloads/voice-<キャラクター ID>-<saved またはボイス名>-<ミリ秒時刻>.<拡張子>` に保存します。`file`、`mime_type`、`bytes`、およびキャラクターページに表示されるボイス文字列を返します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `character` | `string` | はい | キャラクター ID または名前部分文字列。 |
| `voice` | `string` | いいえ | 試聴するベースボイス。指定すると、`flow-mcp` はボイスダイアログで試聴を生成し、ボイスを保存しません。 |
| `voice_sample` | `string` | いいえ | `voice` と一緒に試聴する Sample dialogue(最大 120 文字)。 |
| `voice_performance` | `string` | いいえ | `voice` と一緒に試聴する Customize performance テキスト。 |

---

## 3. 生成・編集ツール

### `flow_generate`

`JobQueue` へ Veo 動画または Imagen 画像の生成ジョブを登録します。`JobView` を返します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `prompt` | `string` | はい | `flow-mcp` が Google Flow へ送信するテキストプロンプト。 |
| `mode` | `string` | いいえ | `"video"`（既定）または `"image"`。 |
| `model` | `string` | いいえ | モデル上書き。既定は `"veo-3.1-fast"`（`video`）または `"nano-banana-2"`（`image`）。 |
| `aspect` | `string` | いいえ | アスペクト比：`"16:9"`（既定）、`"9:16"`、または `"1:1"`。 |
| `count` | `integer` | いいえ | 出力バッチ数（`1..=4`）。既定は `2`。 |
| `frames` | `string[]` | いいえ | 送信前にアップロードするローカル参照またはキーフレーム画像パス。 |
| `asset_ids` | `string[]` | いいえ | 素材またはフレームとして添付する既存プロジェクト画像アセット ID。 |
| `characters` | `string[]` | いいえ | プロンプトコントロールへ添付するキャラクター ID または名前。 |
| `video_type` | `string` | いいえ | 動画生成モード：`"frames"` または `"ingredients"`。 |
| `duration` | `string` | いいえ | 動画尺設定（たとえば `"5s"` または `"8s"`）。 |
| `resolution` | `string` | いいえ | 動画解像度設定（たとえば `"720p"`、`"1080p"`、または `"4K"`）。 |
| `name` | `string` | いいえ | ジョブ用の任意のシーンまたはアセットラベル。 |
| `download` | `boolean` | いいえ | 完了時に生成アセットを `<home>/downloads` へダウンロードします。既定は `true`。 |
| `character_role` | `string` | いいえ | SQLite `character_looks` のキー。`prompt` へ `", character {role}: {look}"` を追加します。 |
| `character_look` | `string` | いいえ | `character_role` の下で外見テキストを SQLite に保存し、`prompt` へ追加します。 |

### `flow_agent_images`

Flow Agent モードバッチ画像ジョブを登録します（`mode="image"`、`480` 秒待機ウィンドウ、`"agent finished without creating"` で `1x` リトライ）。`JobView` を返します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `prompt` | `string` | はい | Flow Agent モード用のバッチ画像プロンプト。 |
| `model` | `string` | いいえ | モデル上書き。既定は `"nano-banana-2"`。 |
| `aspect` | `string` | いいえ | アスペクト比（既定 `"16:9"`、`"9:16"`、または `"1:1"`）。 |
| `count` | `integer` | いいえ | 出力数（`1..=4`）。既定は `2`。 |

### `flow_edit`

UI 編集トリガーまたは `/edit/<id>` を通じて既存の画像または動画アセットの編集ジョブを登録します。`JobView` を返します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `match` | `string` | はい | ソースアセットに一致する大文字小文字を区別しないアセット ID、名前、またはプロンプト部分文字列。 |
| `prompt` | `string` | はい | 一致したアセットに対する編集指示。 |

---

## 4. 動画・シーンツール

### `flow_video`

非破壊トリムを適用するか、動画延長ジョブをキューへ登録します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `action` | `string` | はい | `"trim"`（即時 RPC 更新）または `"extend"`（`JobQueue` ジョブを登録して `JobView` を返す）。 |
| `match` | `string` | はい | 動画アセット ID、完全一致名、または大文字小文字を区別しない部分文字列。 |
| `start_seconds` | `number` | いいえ | `"trim"` 用の開始タイムスタンプ秒（`null` で開始境界をクリア）。 |
| `end_seconds` | `number` | いいえ | `"trim"` 用の終了タイムスタンプ秒（`null` で終了境界をクリア）。 |
| `prompt` | `string` | いいえ | `"extend"` 用の延長プロンプト。 |
| `scene_id` | `string` | いいえ | 延長先とする任意の既存シーン ID。 |

### `flow_scenes`

Flow シーンタイムラインの一覧表示、作成、クリップ追加、名前変更、またはゴミ箱移動を行います。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `action` | `string` | いいえ | `"list"`（既定）、`"create"`、`"add_clips"`、`"rename"`、または `"trash"`。 |
| `id` | `string` | いいえ | 対象シーン ID（`"add_clips"` と `"rename"` に必要、`"trash"` では任意）。 |
| `name` | `string` | いいえ | `"create"` や `"rename"` 用のシーン名、または `"trash"` 用の任意一致文字列。 |
| `asset_ids` | `string[]` | いいえ | ソースクリップアセット ID（`"create"` では任意、`"add_clips"` では空でない配列が必要）。 |
| `position` | `integer` | いいえ | `"add_clips"` 用の挿入クリップインデックス。 |

---

## 5. キュー制御ツール

### `flow_wait`

キュー待機中または実行中のジョブ完了を待ちます。1 回の呼び出しあたり最大 `45` 秒（`PATIENCE_MS`）ブロックし、実行継続中であれば `{"pending": true, "jobs": [...]}` を返します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `ids` | `string[]` | いいえ | 待機する特定の 8 文字ジョブ ID。`ids` と `id` を両方省略すると、`flow-mcp` はすべてのジョブを待機します。 |
| `id` | `string` | いいえ | `ids` を省略したときの単一ジョブ ID。 |
| `timeout` | `integer` | いいえ | 最大総待機目標（秒）。既定は `600`、内部上限は `24` 時間。 |

### `flow_cancel`

`"queued"` ジョブを直ちに削除するか、`"running"` ジョブを停止します。未知の ID では失敗します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | はい | `JobQueue` の 8 文字ジョブ ID。 |

### `flow_retry`

`retried_from` に `id` を設定して、失敗またはキャンセル済みジョブを再度キューへ登録します。未知の ID では失敗します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | はい | 元の 8 文字ジョブ ID。 |

---

## 6. ライブラリ・コレクション・ダウンロードツール

### `flow_assets`

Flow Angular `lService` スナップショットから読み取ったプロジェクトタイルを一覧表示します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `query` | `string` | いいえ | アセット ID、名前、またはプロンプトに一致する大文字小文字を区別しない部分文字列。 |
| `kind` | `string` | いいえ | `"image"`、`"video"`、`"scene"`、`"character"`、または `"all"`（既定）で絞り込みます。 |
| `collection` | `string` | いいえ | コレクション ID、名前部分文字列、`"all"`、`"none"`、または `"uncollected"` で絞り込みます。 |
| `limit` | `integer` | いいえ | 返す最大項目数（`>= 1`）。 |

### `flow_rename`

アセット、キャラクター、シーン、またはコレクションを一括リネームし、RPC またはスナップショットで確認します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `items` | `object[]` | はい | `{"id": "...", "name": "..."}` エントリの空でない配列。 |

ページに表示されている画像または動画のタイルでは、`flow-mcp` はまずタイルメニューの **Rename** 項目を使い、ページのリネーム用コントロールに新しい名前を入力します。それ以外の場合は store mutation を送信します。結果の `items` の各エントリには `method`（`menu:rename` または `mutation`）が含まれます。 コレクションの名前変更は、プロジェクトのデータを再取得して確認します。

### `flow_collections`

プロジェクトコレクションの一覧表示、作成、名前変更、追加、除外、または削除を行います。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `action` | `string` | はい | `"list"`、`"create"`、`"rename"`、`"add"`、`"remove"`、または `"delete"`。 |
| `name` | `string` | いいえ | `"create"` または `"delete"` 用のコレクション名。 |
| `from` | `string` | いいえ | `"rename"` または `"delete"` 用の既存コレクション ID または名前。 |
| `to` | `string` | いいえ | `"rename"` 用の新しいコレクション名。 |
| `collection` | `string` | いいえ | `"add"` または `"delete"` 用の対象コレクション ID または名前（`"add"` は存在しない場合に作成します）。 |
| `ids` | `string[]` | いいえ | コレクションへ移動（`"add"`）または除外（`"remove"`）する正確なアセットまたはキャラクター ID。 |

先に Google Flow のプロジェクトを開いてください。すべてのコレクション操作にはプロジェクトの store を使います。同じ名前のコレクションが複数ある場合は、コレクション ID を指定してください。

書き込みのたびに、同じプロジェクトのデータを再取得して結果を確認します。対応する Flow ビルドでは、まず既定の名前でコレクションを作成し、その後で指定された名前に変更します。結果を確認できない場合は、操作と ID を含む `outcome_unknown` を返します。書き込み形式を確認できていないビルドでは `unsupported_front_end` を返します。

現在の Flow ビルドでは、メンバーの移動とコレクションの削除は別々のリクエストです。`"delete"` はメンバーを移動する前に `collection_delete_unavailable` を返します。

### `flow_download`

一致するプロジェクトの画像または動画を `<home>/downloads` へダウンロードし、`flow-mcp.db` に登録します。最大 `45` 秒まで待機し（タイムアウト時は `pending: true`）、`{"file", "resource_uri", "record"}` を返します。クライアントが MCP `2025-06-18` 以降に対応している場合は、`resource_link` も返します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `match` | `string` | はい | プロジェクトアセットに一致する正確なアセット ID、完全一致名、または大文字小文字を区別しない部分文字列。 |

### `flow_downloads`

`<home>/downloads` と `flow-mcp.db` 内の登録済みダウンロードを検索、確認、Base64 スライス読取、整理、削除、または消去します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `action` | `string` | いいえ | `"list"`（既定）、`"get"`、`"read_chunk"`、`"delete"`、`"prune"`、または `"clear"`。 |
| `id` | `integer` | いいえ | `"get"`、`"read_chunk"`、または `"delete"` 用の SQLite ダウンロード行 ID（`>= 1`）。 |
| `asset_id` | `string` | いいえ | `"get"`、`"read_chunk"`、または `"delete"` 用の Flow アセット ID。 |
| `query` | `string` | いいえ | ID、名前、プロンプト、ファイル名、またはパスに一致する大文字小文字を区別しない部分文字列（`"list"`）。 |
| `kind` | `string` | いいえ | `"list"` 用のフィルタ：`"image"`、`"video"`、`"scene"`、`"character"`、または `"all"`（既定）。 |
| `project_id` | `string` | いいえ | `"list"` 用のプロジェクト ID フィルタ。 |
| `existing_only` | `boolean` | いいえ | `"list"` 時にディスク上に存在するファイルの行のみを返します。既定は `false`。 |
| `limit` | `integer` | いいえ | `"list"` 用のページ上限（`1..=500`、既定 `50`）。 |
| `offset` | `integer` | いいえ | `"read_chunk"` 用の開始バイトオフセット。既定は `0`。 |
| `length` | `integer` | いいえ | `"read_chunk"` 用のスライスバイト長（`1..=4194304`、既定 `1048576` / `1 MiB`）。 |
| `older_than_days` | `integer` | いいえ | `action="clear"` 時の経過日数フィルタ。 |

### `flow_trash`

Google Flow 内で一致するアセット、キャラクター、シーン、またはコレクションをゴミ箱へ移動します。

| パラメータ | 型 | 必須 | 説明 |
| :--- | :--- | :--- | :--- |
| `match` | `string` | はい | アセットまたはコレクションの ID、名前、またはプロンプトに一致する大文字小文字を区別しない部分文字列。 |

`flow-mcp` はまずページのタイルメニューで **Move to trash** をクリックします。ページにタイルまたはメニューが表示されていない場合は、リクエスト形式を検証済みのビルドで store を使います。ビルドまたは store のチェックに失敗すると `unsupported_front_end` を返します。結果には `method` と `confirmed` が含まれます。プロジェクト store がその項目をゴミ箱内または削除済みと示すと、`confirmed` は `true` になります。操作前に store の tile map にその項目がない場合（シーンクリップなど）、`confirmed` は `null` になります。 コレクションの場合は `flow_collections` と同じ削除チェックを行い、`collection_delete_unavailable` を返します。
