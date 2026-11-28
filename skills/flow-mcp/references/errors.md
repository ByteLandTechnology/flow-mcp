# Errors and next actions

| Symptom | Meaning | Next action |
| :--- | :--- | :--- |
| `flow_*` tool does not exist | The MCP server is not active | Ask the user to register the server: `claude mcp add flow-mcp -- npx -y @flow-mcp/cli@latest serve` `codex mcp add flow-mcp -- npx -y @flow-mcp/cli@latest serve`, or `agy mcp add flow-mcp -- npx -y @flow-mcp/cli@latest serve` |
| `flow.frontend.ok` is `false` or `unsupported_front_end` | The live Flow build is not verified | Stop. Report the build label and the failed checks |
| `signed_in` is `false` | No Google session | Follow section 2 of `SKILL.md` |
| Job fails with "unusual activity" | Flow blocked the request. No credits are charged | Retry one time. If it repeats, report it and stop |
| `outcome_unknown` | The change may have happened | Read the state (`flow_assets`, `flow_characters`, `flow_agent get_settings`), then decide |
| `voice_not_found:<name>` | The voice list was not ready or the name is wrong | Check the name with `flow_voices`, then retry one time |
| `voice_audition_audio_not_found` | Custom text audio was not ready in time | Retry one time. Custom text can take 20 to 60 seconds |
| Lock error on start | Another `flow-mcp` process uses the profile | Ask the user to close it |
| Job `pending` for a long time | Jobs run one at a time, with a random pause between jobs | Keep calling `flow_wait`. Use `flow_cancel` only when the user asks |
| `flow_wait` returns before the job ends | One call waits about 45 seconds | Call `flow_wait` again |
