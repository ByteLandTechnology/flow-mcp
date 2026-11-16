# AGENTS.md: rules for this repository

These rules apply to all persons and agents that change this repository.
The command `cargo xtask ci` checks most of these rules.

## Writing

- Use ASD-STE100 Simplified Technical English for all English text.
- This rule applies to this file, `README.md`, code comments, documentation comments, and commit messages.
- Use active voice, present tense, and precise terms.
- Keep each user-facing instruction in `README.md` only.
- Use the user's language for direct communication with the user.

## Independence and protocol boundaries

- `flow-mcp` serves 22 MCP tools and download resources over standard input and output via `rmcp`.
- `ChromeEngine` launches Chrome or Chromium on demand with a persistent `0700` user-data directory at `<home>/chrome-profile` and connects over local Chrome DevTools Protocol (CDP).
- `ChromeEngine` runs headless CDP Chrome (`--headless=new`) during background operations and opens standard visible Chrome without CDP flags during interactive Google Sign-In in `flow_login`.
- Pin Google Flow and `ChromeEngine` sessions to the English interface (`hl=en` and `en-US`).
- Run generation, edit, video extend, and character jobs one at a time through `JobQueue`.
- Write `cookies.json` and `flow-mcp.db` with `0600` permissions, and create `<home>/chrome-profile` with `0700` permissions on Unix.
- Store the SQLite index, all downloads, cookies, and the persistent Chrome profile under `<home>`.
- Preserve natural download file names from `Content-Disposition`, the URL path, or `<asset_id>.<ext>`.
- Keep build outputs, `node_modules`, SQLite databases, downloaded media, local browser profiles, and credentials outside Git.

## Layout

- The workspace has two members: `flow-mcp` (`src/`) and `xtask` (`xtask/`).
- `.cargo/config.toml` defines the `xtask` Cargo alias.
- Keep all Rust modules flat in `src/` and `xtask/src/` with no subdirectories.
- Keep all browser TypeScript modules flat in `ts/` with no subdirectories.
- Bundle `ts/index.ts` with `esbuild` in `build.rs` to `$OUT_DIR/flow_runtime.js`, and embed that bundle once in `src/engine.rs` with `include_str!`.
- Use `src/main.rs` as the single binary entry point. Do not add `src/lib.rs`.

## Disk use and cleanup

- Check free disk space and the sizes of build, cache, and temporary directories before a full build or CI run. Keep at least 20 GiB free for these operations.
- Reuse build directories for compatible targets and profiles. Keep copied source trees separate from `target/`.
- Remove task-owned temporary files and obsolete build output as soon as no active check needs them. Preserve diagnostic logs and files that the user owns.

## Modules and files

- Divide `src/` into flat modules by domain.
- Use private or `pub(crate)` visibility by default. The `unreachable_pub` lint is on.
- Before you write a helper, look in existing modules. Do not copy a helper into a second module.
- Each `.rs` and `.ts` source file must have no more than 800 lines of code. Comments and blank lines are not counted. There are no exceptions.
- Use LF line endings in all `.rs`, `.ts`, `.json`, `.toml`, and `.md` files.

## Code rules

- Declare each third-party dependency and its version in the `Cargo.toml` file of its package. Do not use `[workspace.dependencies]`.
- Keep `[dependencies]` empty in `xtask/Cargo.toml`.
- Use only one version of each dependency in the workspace. `cargo deny` enforces this rule. If a transitive dependency makes this impossible, add it to `skip` in `deny.toml` and write the reason.
- Forbid `unsafe` code.
- Do not use `unwrap()` or `expect()`. Handle each error explicitly.
- Do not use `#[allow(...)]` or `#[expect(...)]`. Change the code to remove the lint warning.
- Do not use the `async-trait` crate. Use concrete backend types or native `async fn`.
- If a function needs many arguments, use a parameter struct.
- Write complete documentation comments on every crate, module, struct, enum, variant, field, constant, type alias, and function, including private items.
- Do not write Rust code examples in documentation comments, because rustdoc runs them as tests. This rule also applies to a Markdown file that a crate includes as its documentation.

## Tests

- Put all tests, test data, and test tools outside this repository. Use the compiled `flow-mcp` binary over standard input and output for external tests.
- Do not add tests, `test/`, `tests/`, `benches/`, or `__tests__/` directories, test targets, `[dev-dependencies]`, or npm test scripts and packages to this repository.
- Do not add production code that exists only for tests. Examples are mock traits, fakes, recording doubles, and test-only wrapper functions.

## License header

Start each `.rs` and `.ts` source file with these two lines:

```text
// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT
```

## Commit messages

- Obey Conventional Commits.
- Use no more than 72 characters on each line, including spaces and list markers.
- Use lowercase letters for the type and the scope.
- Use these scopes:
  - `flow`: `src/` and `ts/`
  - `xtask`: repository checks in `xtask/`
  - `docs`: documents
  - `build`: build, manifest, and ignore files
  - If a commit changes more than one scope, do not write a scope.
- Start the summary with an imperative verb in lowercase letters.
- Do not put a period at the end of the summary.
- If you write a body, obey these rules:
  - Put one blank line between the header and the body.
  - Write the body as a list with `- ` before each item.
  - Start each item with a capital letter.
  - Put each item on one line. Do not put blank lines in the body.
  - Do not use nested lists.
- Do not add attribution lines such as `Co-Authored-By` to commit messages or pull request text.
- Preserve repository-local Git identity and signing settings.
- Each commit must compile and pass checks.

## Branches

- Commit directly to `main`.
- This project has no released version scheme outside `Cargo.toml`.

## Before you commit

Run `cargo xtask ci`. It runs these checks in order:

- `cargo fmt --all -- --check`
- `cargo xtask check`: license headers, line endings, code line limit, forbidden code checks, and TypeScript type checks
- `cargo clippy --locked --workspace --all-targets -- -D warnings`
- `cargo doc --locked --workspace --no-deps --document-private-items`
- `cargo build --locked --workspace`
- `cargo deny --locked --workspace check`
