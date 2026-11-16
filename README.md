# flow-mcp

`flow-mcp` is a Rust stdio Model Context Protocol (MCP) server for Google Flow (Veo and Imagen).
It serves 22 tools and download resources through `rmcp` over standard input and output.
`ChromeEngine` launches Chrome or Chromium on demand with a persistent `0700` user-data directory under `<home>/chrome-profile` and connects over local Chrome DevTools Protocol (CDP).
`ChromeEngine` runs headless CDP Chrome (`--headless=new`) during background operations and opens a standard visible Chrome window without CDP flags during interactive Google Sign-In in `flow_login`.
A single-worker `JobQueue` runs generation, edit, video extend, and character jobs one at a time with randomized pauses between jobs. Downloads stay in `<home>/downloads`, keep natural file names, and update a local SQLite index.

## Build

Install a Rust 2024 toolchain (`1.88` or newer), Node.js with `npm` for build-time TypeScript bundling, and Google Chrome or Chromium for runtime automation (`--chrome` or `FLOW_MCP_CHROME` overrides OS binary discovery). The compiled `flow-mcp` binary embeds the browser runtime bundle and does not require Node.js at runtime.

```sh
git clone <repo-url>
cd flow-mcp
npm ci
cargo build --release
```

Cargo writes the release binary to `./target/release/flow-mcp`.

## Command-line options

```text
flow-mcp [OPTIONS]
```

| Option | Effect | Precedence and default |
| :--- | :--- | :--- |
| `--home <PATH>` | Set the data root directory | Overrides `FLOW_MCP_HOME`. Defaults to `~/.flow-mcp`. |
| `--chrome <PATH>` | Set the Chrome or Chromium binary path | Overrides `FLOW_MCP_CHROME` and OS binary discovery. |
| `-h`, `--help` | Print command-line help and exit | — |
| `-V`, `--version` | Print `flow-mcp 0.2.0` and exit | — |

Run the server directly over stdio:

```sh
./target/release/flow-mcp
```

## MCP client configuration

Add `flow-mcp` to an MCP stdio client (`mcpServers`):

```json
{
  "mcpServers": {
    "flow-mcp": {
      "command": "/path/to/flow-mcp/target/release/flow-mcp",
      "args": [
        "--home", "/path/to/.flow-mcp"
      ],
      "env": {
        "FLOW_MCP_PAUSE_MIN_S": "25",
        "FLOW_MCP_PAUSE_MAX_S": "70"
      }
    }
  }
}
```

## Environment variables

| Variable | Effect | Default |
| :--- | :--- | :--- |
| `FLOW_MCP_HOME` | Set the data root for `flow-mcp.db`, `downloads/`, and `cookies.json` | `~/.flow-mcp` |
| `FLOW_MCP_CHROME` | Set the Chrome or Chromium executable path | Auto-detected from OS paths and Playwright cache |
| `FLOW_MCP_CHROME_CDP_PORT` | Pin the local Chrome DevTools Protocol TCP port | Ephemeral port (`0`) |
| `FLOW_MCP_PAUSE_MIN_S` | Set the minimum pause in seconds between queued jobs | `25` |
| `FLOW_MCP_PAUSE_MAX_S` | Set the maximum pause in seconds between queued jobs (at least min) | `70` |

## Data directory and SQLite storage

By default, `flow-mcp` keeps runtime data under `<home>` (`~/.flow-mcp`):

- `<home>/flow-mcp.db`: SQLite database (`WAL` mode, `0600` file permissions on Unix) with three tables:
  - `downloads`: Index of every downloaded file (`asset_id`, `project_id`, `project_title`, `name`, `kind`, `prompt`, `source_url`, `file_path`, `file_name`, `mime_type`, `size_bytes`, `asset_created_at`, `downloaded_at`).
  - `character_looks`: Role-to-look descriptions used by `flow_generate`.
  - `characters`: Stored character metadata (`id`, `project_id`, `name`, `bio`, `voice`, `ref_asset_ids`, `updated_at`).
- `<home>/downloads`: Fixed destination directory for all downloaded images and videos. External overrides outside `<home>` are not supported.
- `<home>/cookies.json`: Saved Google Flow cookies (`0600` file permissions on Unix).
- `<home>/chrome-profile`: Persistent Chrome user-data directory (`0700` file mode on Unix) that keeps Google session cookies and Device Bound Session Credentials (DBSC) across restarts.

## Sign-in and session storage

`flow-mcp` runs headless CDP Chrome by default and opens a standard visible Chrome window without CDP debugging flags during interactive `flow_login` when a signed-in session is not available.

1. Cookie file and persistent profile:
   - `flow-mcp` stores the Chrome user-data directory at `<home>/chrome-profile` (`0700` permissions on Unix) so Google session cookies and DBSC keys persist across server restarts.
   - `flow-mcp` also writes normalized cookies atomically to `<home>/cookies.json` with `0600` file permissions on Unix.
   - Cookie normalization keeps `google.com`, `labs.google`, `googleusercontent.com`, and `gstatic.com` entries. It also keeps `__Host-` and `hostOnly` flags.
   - When `<home>/chrome-profile` already holds Google authentication cookies, `flow-mcp` preserves those native Chrome cookies and does not overwrite them with older `<home>/cookies.json` entries.

2. `flow_login` actions:
   - `login` (default, alias `start`): Reuses the persisted `<home>/chrome-profile` or `cookies.json` session in headless mode when `force=false` (default). Otherwise opens standard visible Chrome without CDP debugging flags on a clean `<home>/chrome-profile` at Google Sign-In (`?hl=en`). When `wait=true` (default, `timeout_secs=180`), it polls profile state until sign-in completes, closes the visible Chrome window to flush `<home>/chrome-profile`, restarts headless CDP Chrome on the same profile, and saves `cookies.json`.
   - `sync_cookies` (alias `import_cookies`): Imports the `cookies` JSON array (or reloads `<home>/cookies.json` when omitted) into Chrome, checks `signedIn`, and saves cookies when authenticated.
   - `save_cookies`: Writes Chrome cookies for Google and Flow domains to `<home>/cookies.json`.
   - `status`: Reports Chrome `pageReady`, `windowVisible`, `cdpEndpoint`, `cookiesSaved`, `profileDir`, active URL, and `signedIn`.
   - `logout` (aliases `reset_session`, `clear_cookies`): Stops Chrome, deletes `<home>/chrome-profile` and `<home>/cookies.json`, and resets the session state.

3. First-time setup:
   1. Call `flow_status` to check session readiness.
   2. Call `flow_login` when `signed_in` is `false` and complete sign-in inside the Chrome window.
   3. Call `flow_new_project` or `flow_assets` to confirm an open project workspace.
   4. Call `flow_generate`, `flow_wait`, `flow_download`, and `flow_downloads`.

## MCP resources

`flow-mcp` enables the MCP `resources` capability so remote and local clients can read downloaded files over MCP:

- `resources/list`: Lists existing files in `<home>/downloads` with cursor pagination (100 items per page), MIME type, byte size, and URI `flow://downloads/<id>`.
- `resources/templates/list`: Exposes `flow://downloads/{id}` and `flow://downloads/asset/{asset_id}`.
- `resources/read`: Returns the file payload as Base64 `blob` with MIME type for files up to 64 MiB. For files larger than 64 MiB, read slices through `flow_downloads` with `action="read_chunk"`.

## MCP tools

| Tool | Purpose | Key parameters | Behavior notes |
| :--- | :--- | :--- | :--- |
| `flow_status` | Read session, active project, queue, SQLite index count, and engine state | `probe?: bool` | When `probe=true`, reads the active Chrome page without navigation. Does not open or create projects automatically. |
| `flow_login` | Sign in through Chrome and manage cookies | `action?`, `wait?`, `timeout_secs?`, `force?`, `cookies?` | Supports `login`, `sync_cookies`, `save_cookies`, `status`, and `logout`. |
| `flow_projects` | Manage Google Flow projects | `action?` (`list`, `create`, `open`, `rename`, `delete`), `id?`, `title?` | Lists projects on the Flow home page, opens projects by ID or title, creates and titles projects, renames active projects, or deletes projects. |
| `flow_new_project` | Open the Flow home page, create a project, and set its title | `title?: string` | Returns `created`, `clicked`, `project_id`, `title`, and `url`. |
| `flow_generate` | Queue a video or image generation job | `prompt` (required), `mode?`, `model?`, `aspect?`, `count?`, `frames?`, `asset_ids?`, `characters?`, `video_type?`, `duration?`, `resolution?`, `name?`, `download?`, `character_role?`, `character_look?` | `mode` defaults to `"video"` with `veo-3.1-fast` (`"image"` defaults to `nano-banana-2`). Supports Settings controls, project ingredients (`asset_ids`), character references (`characters`), and `character_looks`. |
| `flow_agent_images` | Queue a Flow Agent Mode batch image job | `prompt` (required), `model?`, `aspect?`, `count?` | Runs `mode="image"` with a 480-second wait window. Retries once when a non-reCAPTCHA error contains `"agent finished without creating"`. |
| `flow_edit` | Queue an edit job for an existing image or video asset | `match` (required), `prompt` (required) | Matches the source asset by ID, name, or prompt substring, opens the UI edit control or `/edit/<id>` route, and downloads outputs. |
| `flow_video` | Trim or extend a video asset | `action` (required: `trim` or `extend`), `match` (required), `start_seconds?`, `end_seconds?`, `prompt?`, `scene_id?` | `trim` sets non-destructive start and end seconds immediately. `extend` queues a scene extend job and returns a `JobView` for `flow_wait`. |
| `flow_scenes` | Manage Flow scene timelines | `action?` (`list`, `create`, `add_clips`, `rename`, `trash`), `id?`, `name?`, `asset_ids?`, `position?` | Lists scene tiles, creates empty or populated scenes, appends clips, renames scenes, or moves scenes to trash. |
| `flow_voices` | List available character voices in Flow | `character?` | Opens the Flow character voice picker and returns available voice cards. |
| `flow_character` | Queue a character entity creation job | `name` (required), `description?`, `bio?`, `voice?`, `asset_ids?`, `refs?`, `prompt?` | Creates a character entity, sets introduction notes and voice, attaches project or uploaded looks, and saves metadata in SQLite. |
| `flow_character_edit` | Queue a character entity update job | `name` (required), `new_name?`, `bio?`, `voice?`, `asset_ids?`, `refs?`, `prompt?` | Opens `/character/<id>`, updates display name, bio, voice, or looks, and updates SQLite. |
| `flow_characters` | List saved character entities | None | Combines live character tiles with stored SQLite `bio`, `voice`, and `ref_asset_ids` metadata. |
| `flow_wait` | Wait for queued or running jobs to finish | `ids?`, `id?`, `timeout?` (seconds, default `600`) | Waits up to 45 seconds inline. Returns `{"pending": true, "jobs": [...]}` when jobs continue in the background. Completed jobs include `files`, `created`, and `resources`. |
| `flow_cancel` | Cancel a queued or running job | `id` (required) | Removes `queued` jobs from the pending queue, interrupts `running` jobs, and fails on unknown IDs. |
| `flow_retry` | Retry a failed or cancelled job | `id` (required) | Queues a new job with `retried_from` set to `id` and fails on unknown IDs. |
| `flow_assets` | List assets in the active Flow project | `query?`, `kind?`, `collection?`, `limit?` | Filters by substring, `kind` (`"image"`, `"video"`, `"scene"`, `"character"`, or `"all"`), collection ID/name/`"all"`/`"none"`/`"uncollected"`, and `limit >= 1`. |
| `flow_rename` | Batch rename assets, characters, scenes, or collections | `items` (required, non-empty `[{ id, name }]`) | Updates tile display names through the project store and confirms by RPC status or snapshot state. |
| `flow_collections` | Manage project collections | `action` (required: `list`, `create`, `rename`, `add`, `remove`, `delete`), `name?`, `from?`, `to?`, `collection?`, `ids?` | `add` moves exact IDs into the collection and creates it if missing. `remove` uncollects IDs. `delete` moves items out and removes the collection. |
| `flow_download` | Download a project image or video to `<home>/downloads` | `match` (required) | Matches exact ID, exact name, or substring. Waits up to 45 seconds inline (`pending: true` on timeout). Streams over HTTP (`reqwest`), falls back to browser `fetch()`, keeps natural file names, indexes in SQLite, and returns `{ "file": "...", "resource_uri": "...", "record": { ... } }` with a `resource_link`. |
| `flow_downloads` | Manage indexed downloaded files in SQLite and `<home>/downloads` | `action?` (`list`, `get`, `read_chunk`, `delete`, `prune`, `clear`), `id?`, `asset_id?`, `query?`, `kind?`, `project_id?`, `existing_only?`, `limit?`, `offset?`, `length?`, `older_than_days?` | `list` (default) filters `flow-mcp.db` and sums byte counts. `get` returns one record. `read_chunk` reads Base64 byte slices (`offset`, `length` in `1..=4194304`, default 1 MiB) for large files. `delete` removes matched files inside `<home>/downloads` and their SQLite rows. `prune` removes missing-file rows. `clear` removes all or old files (`older_than_days`) and returns `freed_bytes`. |
| `flow_trash` | Move a matching asset or collection to trash | `match` (required) | Matches an asset, character, scene, or collection by exact ID, name, or prompt substring and deletes or trashes it. |
