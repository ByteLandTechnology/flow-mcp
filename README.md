# flow-mcp

![English](https://img.shields.io/badge/English-2563eb?style=flat-square&logoWidth=16&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAxOCI%2BPGNsaXBQYXRoIGlkPSJ1Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMTgiIHJ4PSIyIi8%2BPC9jbGlwUGF0aD48ZyBjbGlwLXBhdGg9InVybCgjdSkiPjxyZWN0IHdpZHRoPSIyNCIgaGVpZ2h0PSIxOCIgZmlsbD0iI2ZmZiIvPjxwYXRoIHN0cm9rZT0iI2IyMjIzNCIgc3Ryb2tlLXdpZHRoPSIxLjQiIGQ9Ik0wIC43aDI0TTAgMy41aDI0TTAgNi4zaDI0TTAgOS4xaDI0TTAgMTEuOWgyNE0wIDE0LjdoMjRNMCAxNy4zaDI0Ii8%2BPHJlY3Qgd2lkdGg9IjEwLjQiIGhlaWdodD0iOS44IiBmaWxsPSIjM2MzYjZlIi8%2BPHBhdGggc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjEuMyIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBkPSJNMi4xIDIuMWguMDFNNS4yIDIuMWguMDFNOC4zIDIuMWguMDFNMy42IDQuOWguMDFNNi44IDQuOWguMDFNMi4xIDcuN2guMDFNNS4yIDcuN2guMDFNOC4zIDcuN2guMDEiLz48L2c%2BPC9zdmc%2B)
[![简体中文](https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-64748b?style=flat-square&logoWidth=16&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAxOCI%2BPHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjE4IiByeD0iMiIgZmlsbD0iI2RlMjkxMCIvPjxwYXRoIGZpbGw9IiNmZmRlMDAiIGQ9Ik00LjggMi40IDYuMyA3LjEgMi4zIDQuMiA3LjMgNC4yIDMuMyA3LjF6TTguNCAyLjYgOS41IDEuMyA5LjQgMy4wIDguNSAxLjUgMTAuMSAyLjF6TTEwLjAgNC4wIDExLjUgMy4xIDEwLjggNC43IDEwLjUgMy4wIDExLjcgNC4yek0xMC4wIDYuMiAxMS43IDYuMCAxMC40IDcuMiAxMC44IDUuNSAxMS41IDcuMXpNOC41IDcuNiAxMC4xIDguMSA4LjUgOC42IDkuNSA3LjIgOS41IDkuMHoiLz48L3N2Zz4%3D)](docs/zh-CN/README.md)
[![日本語](https://img.shields.io/badge/%E6%97%A5%E6%9C%AC%E8%AA%9E-64748b?style=flat-square&logoWidth=16&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAxOCI%2BPHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjE4IiByeD0iMiIgZmlsbD0iI2ZmZiIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iOSIgcj0iNSIgZmlsbD0iI2JjMDAyZCIvPjwvc3ZnPg%3D%3D)](docs/ja/README.md)

`flow-mcp` is a single-binary Rust stdio Model Context Protocol (MCP) server for Google Flow (`Veo` and `Imagen`). It serves MCP tools and download resources through `rmcp` over standard input and output.

`ChromeEngine` manages a persistent Chrome or Chromium profile in `<home>/chrome-profile` (`0700` permissions on Unix). During background work, it connects over local Chrome DevTools Protocol (CDP) to headless Chrome (`--headless=new`). During Google Sign-In in `flow_login`, it opens a visible Chrome window without CDP flags. This lets Google authentication and Device Bound Session Credentials (DBSC) finish normally.

A single-worker `JobQueue` runs generation, edit, video extend, and character jobs one at a time with random pauses. It downloads media files with natural names into `<home>/downloads` and indexes them in SQLite.

![flow-mcp runtime architecture](docs/assets/en/architecture.svg)

## Quick install

Install Node.js `18` or newer and Google Chrome or Chromium on your host computer:

```sh
npx -y @flow-mcp/cli --help
```

Or install the CLI globally:

```sh
npm install --global @flow-mcp/cli
flow-mcp --help
```

With `@flow-mcp/cli`, `npm` installs the matching optional package (`@flow-mcp/darwin-arm64`, `@flow-mcp/darwin-x64`, `@flow-mcp/linux-arm64`, `@flow-mcp/linux-x64`, `@flow-mcp/win32-arm64`, or `@flow-mcp/win32-x64`). Linux packages use `glibc`. On `musl` systems (for example Alpine Linux), build from source.

> [!IMPORTANT]
> Do not pass `--omit=optional` or `--no-optional`. Those flags skip the native binary package. You also need Google Chrome or Chromium on the host computer at runtime.

You can also download standalone binaries from [GitHub Releases](https://github.com/ByteLandTechnology/flow-mcp/releases):

| Platform | x86_64 | ARM64 |
| :--- | :--- | :--- |
| macOS | `flow-mcp-macos-x86_64` | `flow-mcp-macos-arm64` |
| Linux | `flow-mcp-linux-x86_64` | `flow-mcp-linux-arm64` |
| Windows | `flow-mcp-windows-x86_64.exe` | `flow-mcp-windows-arm64.exe` |

To build from source, install Rust `1.88` (or newer) and Node.js. `esbuild` bundles `ts/index.ts` at compile time, so the compiled binary does not need Node.js at runtime:

```sh
git clone https://github.com/ByteLandTechnology/flow-mcp.git
cd flow-mcp
npm ci
cargo build --release
```

Add `@flow-mcp/cli` to your MCP stdio client configuration (`mcpServers`):

```json
{
  "mcpServers": {
    "flow-mcp": {
      "command": "npx",
      "args": ["-y", "@flow-mcp/cli", "--home", "/path/to/.flow-mcp"],
      "env": {
        "FLOW_MCP_PAUSE_MIN_S": "25",
        "FLOW_MCP_PAUSE_MAX_S": "70"
      }
    }
  }
}
```

## Documentation map

Read the guide sections for each task:

| Guide | Focus | Key topics |
| :--- | :--- | :--- |
| [Quickstart](docs/en/quickstart.md) | Tutorial | Install `flow-mcp`, configure a client, sign in, and generate a video |
| [Architecture](docs/en/architecture.md) | Explanation | Dual-mode `ChromeEngine`, DBSC handoff, `JobQueue`, 45s wait limit, and `<home>` security |
| [Workflows](docs/en/workflows.md) | Procedures | Video and image jobs, characters, edits, scenes, `read_chunk`, and cookie sync |
| [Tools Reference](docs/en/tools-reference.md) | Reference | CLI options, environment variables, MCP resources, and MCP tools |

## Tool overview and media workflows

![End-to-end media workflows](docs/assets/en/media-workflows.svg)

| Domain | Tools | Purpose |
| :--- | :--- | :--- |
| Session & Projects | `flow_status`, `flow_login`, `flow_new_project`, `flow_projects` | Check session state, sign in with Chrome, and manage projects |
| Characters & Voices | `flow_voices`, `flow_character`, `flow_character_edit`, `flow_characters` | List Flow voices, create or update characters, and store SQLite profiles |
| Generation & Batch | `flow_generate`, `flow_agent_images`, `flow_edit` | Queue Veo video or Imagen image jobs, run Agent batches, or edit assets |
| Video & Scenes | `flow_video`, `flow_scenes` | Trim videos without source changes, extend clips, and manage scene timelines |
| Queue Control | `flow_wait`, `flow_cancel`, `flow_retry` | Wait for jobs (`PATIENCE_MS = 45s`), stop jobs, or run failed jobs again |
| Library & Media | `flow_assets`, `flow_rename`, `flow_collections`, `flow_download`, `flow_downloads`, `flow_trash` | Filter tiles, rename items, group collections, download files, read chunks, or trash items |

Read [Tools Reference](docs/en/tools-reference.md) for every parameter and response field.
