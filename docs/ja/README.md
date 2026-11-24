# flow-mcp

[![English](https://img.shields.io/badge/English-64748b?style=flat-square&logoWidth=16&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAxOCI%2BPGNsaXBQYXRoIGlkPSJ1Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMTgiIHJ4PSIyIi8%2BPC9jbGlwUGF0aD48ZyBjbGlwLXBhdGg9InVybCgjdSkiPjxyZWN0IHdpZHRoPSIyNCIgaGVpZ2h0PSIxOCIgZmlsbD0iI2ZmZiIvPjxwYXRoIHN0cm9rZT0iI2IyMjIzNCIgc3Ryb2tlLXdpZHRoPSIxLjQiIGQ9Ik0wIC43aDI0TTAgMy41aDI0TTAgNi4zaDI0TTAgOS4xaDI0TTAgMTEuOWgyNE0wIDE0LjdoMjRNMCAxNy4zaDI0Ii8%2BPHJlY3Qgd2lkdGg9IjEwLjQiIGhlaWdodD0iOS44IiBmaWxsPSIjM2MzYjZlIi8%2BPHBhdGggc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjEuMyIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBkPSJNMi4xIDIuMWguMDFNNS4yIDIuMWguMDFNOC4zIDIuMWguMDFNMy42IDQuOWguMDFNNi44IDQuOWguMDFNMi4xIDcuN2guMDFNNS4yIDcuN2guMDFNOC4zIDcuN2guMDEiLz48L2c%2BPC9zdmc%2B)](../../README.md)
[![简体中文](https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-64748b?style=flat-square&logoWidth=16&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAxOCI%2BPHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjE4IiByeD0iMiIgZmlsbD0iI2RlMjkxMCIvPjxwYXRoIGZpbGw9IiNmZmRlMDAiIGQ9Ik00LjggMi40IDYuMyA3LjEgMi4zIDQuMiA3LjMgNC4yIDMuMyA3LjF6TTguNCAyLjYgOS41IDEuMyA5LjQgMy4wIDguNSAxLjUgMTAuMSAyLjF6TTEwLjAgNC4wIDExLjUgMy4xIDEwLjggNC43IDEwLjUgMy4wIDExLjcgNC4yek0xMC4wIDYuMiAxMS43IDYuMCAxMC40IDcuMiAxMC44IDUuNSAxMS41IDcuMXpNOC41IDcuNiAxMC4xIDguMSA4LjUgOC42IDkuNSA3LjIgOS41IDkuMHoiLz48L3N2Zz4%3D)](../zh-CN/README.md)
![日本語](https://img.shields.io/badge/%E6%97%A5%E6%9C%AC%E8%AA%9E-2563eb?style=flat-square&logoWidth=16&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAxOCI%2BPHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjE4IiByeD0iMiIgZmlsbD0iI2ZmZiIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iOSIgcj0iNSIgZmlsbD0iI2JjMDAyZCIvPjwvc3ZnPg%3D%3D)

`flow-mcp` は、Google Flow（`Veo` および `Imagen`）向けの単一バイナリ Rust 製 stdio Model Context Protocol（MCP）サーバーです。`rmcp` を使用し、標準入出力を通じて MCP ツールとダウンロードリソースを提供します。

`ChromeEngine` は `<home>/chrome-profile`（Unix 権限 `0700`）で永続的な Chrome または Chromium プロファイルを管理します。バックグラウンド処理中はローカルの Chrome DevTools Protocol（CDP）でウィンドウ表示の Chrome に接続します。Google Flow がヘッドレス Chrome からの生成を拒否することがあるためです。`--headless` オプションを指定するとヘッドレス Chrome（`--headless=new`）を使います。`flow_login` で Google ログインを行うときは、CDP フラグなしの標準的な可視 Chrome ウィンドウを開きます。これにより Google 認証と Device Bound Session Credentials（DBSC）が正常に完了します。

単一ワーカーの `JobQueue` は、生成・編集・動画延長・キャラクタージョブをランダムな休止を挟んで 1 件ずつ順番に実行します。メディアファイルを自然なファイル名のまま `<home>/downloads` へダウンロードし、SQLite にインデックスを登録します。

![flow-mcp ランタイムアーキテクチャ](../assets/ja/architecture.svg)

## クイックインストール

ホストマシンに Node.js `18` 以上および Google Chrome または Chromium をインストールします：

```sh
npx -y @flow-mcp/cli --help
```

または CLI をグローバルにインストールします：

```sh
npm install --global @flow-mcp/cli
flow-mcp --help
```

`@flow-mcp/cli` を導入すると、`npm` は対応するオプショナルパッケージ（`@flow-mcp/darwin-arm64`、`@flow-mcp/darwin-x64`、`@flow-mcp/linux-arm64`、`@flow-mcp/linux-x64`、`@flow-mcp/win32-arm64`、または `@flow-mcp/win32-x64`）をインストールします。Linux パッケージは `glibc` を使用します。Alpine Linux などの `musl` システムでは、ソースからビルドしてください。

> [!IMPORTANT]
> `--omit=optional` および `--no-optional` は指定しないでください。これらのフラグはネイティブバイナリパッケージをスキップします。実行時にはホストマシンに Google Chrome または Chromium も必要です。

[GitHub Releases](https://github.com/ByteLandTechnology/flow-mcp/releases) から単体バイナリをダウンロードすることもできます：

| プラットフォーム | x86_64 | ARM64 |
| :--- | :--- | :--- |
| macOS | `flow-mcp-macos-x86_64` | `flow-mcp-macos-arm64` |
| Linux | `flow-mcp-linux-x86_64` | `flow-mcp-linux-arm64` |
| Windows | `flow-mcp-windows-x86_64.exe` | `flow-mcp-windows-arm64.exe` |

ソースからビルドするには、Rust `1.88`（以上）と Node.js をインストールします。コンパイル時に `esbuild` が `ts/index.ts` をバンドルするため、コンパイル後のバイナリは実行時に Node.js を必要としません：

```sh
git clone https://github.com/ByteLandTechnology/flow-mcp.git
cd flow-mcp
npm ci
cargo build --release
```

MCP stdio クライアント設定（`mcpServers`）へ `@flow-mcp/cli` を追加します：

```json
{
  "mcpServers": {
    "flow-mcp": {
      "command": "npx",
      "args": ["-y", "@flow-mcp/cli", "serve", "--home", "/path/to/.flow-mcp"],
      "env": {
        "FLOW_MCP_PAUSE": "25,70"
      }
    }
  }
}
```

## ドキュメント構成

タスクごとに各ガイドセクションを参照してください：

| ガイド | 区分 | 主なトピック |
| :--- | :--- | :--- |
| [クイックスタート](quickstart.md) | チュートリアル | `flow-mcp` の導入、クライアント設定、サインイン、動画生成 |
| [アーキテクチャ](architecture.md) | 解説 | デュアルモード `ChromeEngine`、DBSC 引き継ぎ、`JobQueue`、45 秒待機上限、`<home>` セキュリティ |
| [ワークフロー](workflows.md) | 手順 | 動画・画像ジョブ、キャラクター、編集、シーン、`read_chunk`、Cookie 同期 |
| [ツールリファレンス](tools-reference.md) | リファレンス | CLI オプション、環境変数、MCP リソース、全 MCP ツール |

## ツール概要とメディアワークフロー

![エンドツーエンド制作ワークフロー](../assets/ja/media-workflows.svg)

| 領域 | ツール | 用途 |
| :--- | :--- | :--- |
| セッション・プロジェクト | `flow_status`、`flow_login`、`flow_new_project`、`flow_projects` | セッション状態とフロントエンドビルドの準備状況の確認、Chrome サインイン、プロジェクト管理 |
| キャラクター・ボイス | `flow_voices`、`flow_character`、`flow_character_edit`、`flow_characters`、`flow_voice_preview` | Flow ボイス一覧取得、キャラクターとカスタムボイスの作成・更新、ボイス試聴、SQLite プロファイル保存 |
| 生成と編集 | `flow_generate`、`flow_edit` | 動画と画像を生成し、アセットを編集 |
| Agent チャット | `flow_agent` | セッションの管理と Flow Agent とのメッセージ送受信 |
| 動画・シーン | `flow_video`、`flow_scenes` | 元ファイルを変更しない動画トリム、クリップ延長、シーンタイムライン管理 |
| キュー制御 | `flow_wait`、`flow_cancel`、`flow_retry` | ジョブ完了待機（`PATIENCE_MS = 45s`）、ジョブ停止、失敗ジョブ再実行 |
| ライブラリ・メディア | `flow_assets`、`flow_rename`、`flow_collections`、`flow_download`、`flow_downloads`、`flow_trash` | メディアのアップロード、タイル絞り込み、名前変更、コレクション分類、ダウンロード、チャンク読取、ゴミ箱移動 |

すべてのパラメータとレスポンスフィールドは [ツールリファレンス](tools-reference.md) を参照してください。
