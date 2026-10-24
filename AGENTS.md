# AGENTS.md

Instructions for coding agents working on this repo. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md) and
[README.md](README.md).

This repo is a Claude Code (and Hermes Agent) plugin for a low-volume job search: a hand-rolled MCP server
over stdio backed by `node:sqlite` (`plugin/servers/tracker/`), safety hooks (`plugin/hooks/`), and markdown
skills, commands and subagents. Node runs the TypeScript directly. There is no build step and no runtime npm
dependency. Everything the plugin ships lives in `plugin/` (the marketplace's `source`); tests, docs and dev
tooling stay outside it so they are not part of what users install or what the directory review scans. The plugin's name, and the prefix of its commands, is `job-tracker` (`/job-tracker:sweep`).

## Commands

```bash
npm run setup          # install dev tools (typescript, @types/node, biome) into dev/
npm test               # tsc typecheck + all Node tests + Python Hermes tests; run before every commit
npm run test:node      # Node tests only (faster loop)
node --no-warnings --test tests/tracker/tracker.test.ts   # one file
npm run lint           # biome check (lint + import order); CI runs `biome ci`
npm run lint:fix       # apply safe fixes
npm run tracker -- --db /tmp/t.db   # run the MCP server on stdio against a scratch DB
npm run build:mcpb     # build the MCPB bundle into dist/ and record its hash in server.json
npm run dev            # Claude Code with this worktree's plugin/ on a fresh copy of the real DB (~/.job-tracker-dev)
npm run prod           # back up the real DB, update the released plugin, start Claude Code on it
```

Set up with `npm run setup`, never `npm install` or `npm ci` in the repo root. The root `package.json`
has no dependencies; the dev tools and their lockfile live in `dev/`. `npm install` in the root would
write a `package-lock.json` there. The same goes for `plugin/`: Claude Code installs whatever a lockfile in
the plugin root lists for every user, on every install and update (a test fails if one appears in either).

Needs Node 22.18+ and Python 3. Chrome-based guard tests skip themselves when Chrome is missing; CI runs
them on Ubuntu and macOS with Node 22.18 and 24.

## Layout

| Path | What |
|---|---|
| `plugin/` | the plugin root (`${CLAUDE_PLUGIN_ROOT}`); only shipped files go here. Paths below are inside it |
| `servers/tracker/src/index.ts` | stdio entry: reads JSON-RPC lines, writes replies to stdout |
| `servers/tracker/src/mcp.ts` | `initialize`, `ping`, `tools/list`, `tools/call` |
| `servers/tracker/src/tools.ts` | every tool's input schema (`SCHEMAS`) and handler |
| `servers/tracker/src/tracker.ts` | domain logic; status machine (`STATUSES`, `transition`) |
| `servers/tracker/src/db.ts` | SQLite schema and append-only `MIGRATIONS` (`PRAGMA user_version`) |
| `hooks/` | `PreToolUse` / `UserPromptSubmit` / `Stop` gates (`hooks.json`, `gates.ts`); `hermes.ts` for Hermes; `dsh.ts` + `dsh-hooks.json` for DeepSeek Harness |
| `skills/`, `commands/`, `agents/` | the prompts the plugin ships |
| `plugin.yaml`, `__init__.py` | the Hermes plugin manifest and wiring |
| | **Repo root (not shipped):** |
| `.claude-plugin/marketplace.json` | the marketplace; its plugin `source` is `./plugin` |
| `server.json`, `registry/` | the MCP Registry entry, and the MCPB bundle manifest and packer (`npm run build:mcpb`, which compiles the tracker to JS for the bundle only); `release.yml` publishes both when the version changes on `main` |
| `tests/` | repo-level tests (hooks, Hermes, installers, docs); `tests/tracker/` for the server |
| `docs/tracker-api.md` | public reference for the tracker tools |
| `site/` | static landing page, deployed by `pages.yml`; not linted |
| `dev/` | dev tools only (`package.json`, lockfile, `node_modules`, and `session.ts` behind `npm run dev` / `npm run prod`); never shipped as runtime dependencies |

## TypeScript rules (Node type stripping, no build)

`tsconfig.json` sets `erasableSyntaxOnly`, `verbatimModuleSyntax`, `strict` and `noUncheckedIndexedAccess`.
In practice:

- Import local files with the `.ts` extension, and use `import type` for type-only imports.
- No `enum`, `namespace`, parameter properties or decorators (Node cannot strip them). Use `as const`
  arrays plus a union type, like `STATUSES` in `tracker.ts`.
- Do not add runtime dependencies. Use `node:` built-ins. A dev dependency needs a clear reason and goes in
  `dev/package.json` (`npm install --prefix dev <pkg>`), never the root `package.json`.
- `!` is allowed after an index access that cannot miss; say why in a short comment, as `gates.ts` does.
- Throw `Error`s with a message the model can act on. Narrow `unknown` with `isRecord` / `oneOf` from
  `servers/tracker/src/util.ts` rather than casting.

## MCP server rules

- **stdout is the protocol.** In `servers/` and `hooks/`, never `console.log` or write anything except
  protocol or hook JSON to stdout. Log to stderr (the `log` helper in `index.ts`, or `process.stderr`).
- **Tool errors the model can fix** throw `ToolError` (`errors.ts`). They come back as `isError: true`
  tool results. Anything else is logged as a crash, so do not use `ToolError` for bugs.
- **Arguments are validated by `checkArgs`** against the tool's schema before the handler runs. Add new
  fields to `SCHEMAS` and do not read arguments the schema does not declare.
- **`tools/list` is a contract.** Clients cache it. If you change a tool's name, description or schema,
  update `tests/tracker/fixtures/tools-list.json` and `docs/tracker-api.md` in the same commit.
  Prefer adding optional fields to changing or removing existing ones.
- **Tool descriptions are prompts.** Keep them short and specific about when to call the tool and what
  the arguments mean. The model reads them on every run.
- **Statuses move only through `transition`.** Every event needs a reason; drops need verbatim evidence or
  `rule:<id>`. Do not add a shortcut that writes status directly.
- **Schema changes:** append a function to `MIGRATIONS` in `db.ts`. Never edit a shipped migration. Add a
  test in `db.test.ts` that migrates an older database.
- The DB holds personal data. Keep file modes owner-only (`fsperm.ts`) and never log row contents.

## Hooks and safety gates

The hooks enforce the promises in [README: What it will never do](README.md#what-it-will-never-do).

- Never weaken a gate (sending, submitting without approval, consent boxes, personal-data fields, guarded
  deletes, draft read-back). If a change needs one relaxed, stop and ask.
- Browser and send tools fail closed: a crash or timeout in `pre-tool` must block them (`hooks/main.ts`).
- Keep Claude Code and Hermes working together. Changes to hooks or skill wiring need the matching change
  in `hooks/hermes.ts` / `__init__.py` and a test on both sides. See [docs/hermes.md](docs/hermes.md).

## Skills, commands and agents (markdown)

- Each rule carries its reason ("Why: ..."). Keep the reason when you edit; it stops later edits from
  undoing the lesson.
- Paths use `${CLAUDE_PLUGIN_ROOT}/...` with the Hermes form next to it
  (`${HERMES_SKILL_DIR}/../../...`).
- Several tests assert exact sentences in these files (`tests/runtime-docs.test.ts`). Run the tests after
  editing wording.

## Code style

- Biome lints and orders imports (`biome.json`). Its formatter is off; match the surrounding code:
  2-space indent, single quotes, semicolons, trailing commas, and long single-line statements are fine.
- Comments explain why, not what. Match the file's existing comment density.

## Tests

- `node:test` with `node:assert/strict`. Each test makes its own temp dir or in-memory DB.
- Fix bugs test-first: write the failing test, then the fix.
- Fixtures use made-up companies and people. Never commit real CVs, application logs, recruiter mail or
  tracker databases.

## Git and commits

- **Commit identity:** the author email must be a GitHub noreply address
  (`<id>+<username>@users.noreply.github.com`). Before your first commit, run `git config user.email`. If
  it is not a noreply address, stop and ask. Do not pass `--author`, `-c user.email` or `GIT_AUTHOR_EMAIL`
  to change it. For the maintainer the address is `1017097+adamwardecki@users.noreply.github.com`.
- `npm test` and `npm run lint` pass before every commit.
- Bumping the version: `package.json`, `plugin/package.json`, `plugin/plugin.yaml` and
  `plugin/.claude-plugin/plugin.json` change together (a test checks), and `SERVER_INFO.version` in `mcp.ts`
  and `plugin/servers/tracker/package.json` follow, as do `server.json` and `registry/manifest.json` (a test
  checks those too).

## Boundaries

- **Always:** run `npm test` and `npm run lint`; update the tools-list fixture and `docs/tracker-api.md`
  with any tool schema change; keep Hermes parity.
- **Ask first:** adding any dependency; changing a tool's name or removing a field; changing a hook
  matcher in `hooks/hooks.json`; renaming CI jobs or changing the test matrix (the job names are required
  checks on `main`); anything touching send, submit, consent or delete gates.
- **Never:** write to stdout from the server or hooks outside the protocol; edit a shipped migration;
  commit personal data, `.db` files or secrets; commit with a non-noreply email; run `npm install` or
  `npm ci` in the root or `plugin/`, or commit a lockfile there; put tests or dev files in `plugin/`.
