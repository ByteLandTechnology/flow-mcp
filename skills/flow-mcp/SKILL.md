---
name: flow-mcp
description: Use when the task is to make images or videos with Google Flow (Veo, Imagen, Nano Banana), or to manage Flow projects, characters, voices, edits, scenes, downloads, or Flow Agent chat. Covers the check before work, the one-time Google sign-in, job waiting, and credit safety for the flow-mcp tools.
---

# Google Flow with flow-mcp

Use the `flow_*` tools of the `flow-mcp` MCP server. The server drives Chrome and the Google Flow web app. After one Google sign-in, you can work without a person.

## 1. Check before work

1. Call `flow_status` with `{}`.
2. If the tool does not exist, the MCP server is not active. Tell the user to register it, then stop. Claude Code: `claude mcp add flow-mcp -- npx -y @flow-mcp/cli@latest serve`. Codex: `codex mcp add flow-mcp -- npx -y @flow-mcp/cli@latest serve`. Antigravity: `agy mcp add flow-mcp -- npx -y @flow-mcp/cli@latest serve`.
3. If `flow.signed_in` is `false`, go to section 2.
4. If `flow.signed_in` is `true`, go to section 3. Do not ask the user for anything.

The field `flow.frontend` is only present when Chrome shows a Google Flow page. Check it in section 3.

## 2. Sign in (once)

Google Sign-In needs a person in a visible Chrome window. You cannot do this step.

1. Tell the user: "A Chrome window opens. Sign in to Google there. You do this one time only."
2. Call `flow_login` with `{"action": "login", "wait": true, "timeout_secs": 180}`.
3. Call `flow_status` again. If `signed_in` is still `false`, call `flow_login` with `"force": true` one time. If it fails again, stop and report the error.

The profile is saved in `<home>/chrome-profile`. Later sessions do not need a sign-in.

## 3. Pick the project

- Call `flow_projects` with `{"action": "list"}` to find a project. Call `flow_new_project` with a `title` for new work.
- Then call `flow_status` again. If `flow.frontend.ok` is `false`, stop. Report `flow.frontend.build` and the failed checks. Do not try to work around a front-end that is not verified.
- Tools that work in a project need the project to be open. Do not change the project while a job runs.

## 4. Do the work

| Task | Tools |
| :--- | :--- |
| Image or video | `flow_generate` (`mode` is `video` by default, set `"mode": "image"` for images) |
| Edit an asset | `flow_edit` |
| Extend or trim a video, scenes | `flow_video`, `flow_scenes` |
| Characters and voices | `flow_voices`, `flow_character`, `flow_character_edit`, `flow_characters`, `flow_voice_preview` |
| Flow Agent chat | `flow_agent` (each call needs `project_id`) |
| Files | `flow_assets`, `flow_download`, `flow_downloads`, `flow_collections`, `flow_rename`, `flow_trash` |

Read `references/tools.md` for parameters and examples.

## 5. Wait for jobs

`flow_generate`, `flow_edit`, `flow_video`, and `flow_character` return a job ID at once. The work runs later, one job at a time.

1. Call `flow_wait` with `{"id": "<job id>"}`. One call waits about 45 seconds.
2. If the result has `"pending": true` or the job `status` is `queued` or `running`, call `flow_wait` again.
3. Stop when `status` is `done`, `failed`, or `cancelled`. Use `files` and `resources` in the job for the output.

Do not submit many jobs at the same time. Submit the next job after the first job ends, unless the user asks for a batch.

## 6. Credit safety

- Generation, edit, extend, and character jobs use credits. Before a batch of more than 4 outputs, tell the user the count.
- If a job fails with "unusual activity", Flow blocked the request and did not charge credits. Do not retry more than one time. Report it to the user.
- Do not use `--headless`. Flow can reject generations from headless Chrome.
- Only one `flow-mcp` process can use a Chrome profile. If you see a lock error, ask the user to close the other process.

## 7. When something fails

Read `references/errors.md`. It maps each error to the next action. If an error has `outcome_unknown` in it, read the state again before you repeat the change.
