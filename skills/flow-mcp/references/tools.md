# Tool quick reference

All parameters are in `docs/en/tools-reference.md` of the repository. This page lists the parameters that agents use most.

## Session

- `flow_status`: `{}` reads the state. `flow.frontend` is present only on a Flow page. `{"probe": true}` checks the active page without navigation.
- `flow_login`: `{"action": "login", "wait": true, "timeout_secs": 180}`. Other actions: `status`, `logout`, `sync_cookies`, `save_cookies`. Use `"force": true` to start from a clean profile.
- `flow_projects`: `{"action": "list"}`.
- `flow_new_project`: `{"title": "My project"}`.

## Generation

`flow_generate` takes `prompt` (required) and these options:

| Option | Meaning |
| :--- | :--- |
| `mode` | `"video"` (default) or `"image"` |
| `count` | 1 to 4, default 2 |
| `aspect` | `"16:9"` (default), `"9:16"`, `"1:1"` |
| `model` | Default `veo-3.1-fast` for video, `nano-banana-2` for image |
| `duration`, `resolution` | Video only, for example `"8s"` and `"1080p"` |
| `characters` | Character IDs or names to attach |
| `asset_ids`, `frames` | Reference assets or local image paths |
| `download` | `true` by default |

Example image job:

```json
{"prompt": "a red paper lantern on a wooden table", "mode": "image", "count": 1, "aspect": "1:1"}
```

`flow_edit` takes `match` (asset ID, name, or prompt text) and `prompt`. An edit changes the same asset.

## Characters and voices

- `flow_voices` lists the 30 Flow voices.
- `flow_character` takes `name` (required), and optional `prompt`, `bio`, `voice`, `refs`, `asset_ids`.
- `flow_voice_preview` takes `character` (required) and optional `voice` to audition a base voice without saving it. Add `voice_sample` (120 characters at most) for custom text. Custom text takes 20 to 60 seconds.

## Jobs

- `flow_wait`: `{"id": "<job id>"}` or `{"ids": [...]}`. Each call waits about 45 seconds.
- `flow_cancel` and `flow_retry`: `{"id": "<job id>"}`.

## Flow Agent

`flow_agent` always needs `project_id`. Actions: `get_settings`, `update_settings`, `list_sessions`, `create_session` (needs `message`), `send_message`, `list_messages`, `get_turn`, `respond`, `stop`, `resume`, `rename_session`, `delete_session`.

- A turn with status `action_required` waits for you. Call `respond` with the `action_id` from `pending_actions`.
- `confirm_before_generating: "never"` lets the Agent use credits without approval. Do not set it unless the user asks.
