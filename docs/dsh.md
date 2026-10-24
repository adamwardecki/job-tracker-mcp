# DeepSeek Harness integration

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) runs the plugin from a git
checkout: the tracker as a local MCP server, the gates through dsh's Claude Code hook bridge
(`@deepseek-ai/dsh-hooks-claude-code`), and the commands, skills and agent prompts as dsh skills. dsh is in
preview and warns of breaking changes, so treat this host as experimental.

## Install

```bash
git clone https://github.com/adamwardecki/job-tracker-mcp.git
cd job-tracker-mcp
node --no-warnings plugin/scripts/dsh-install.ts
```

Restart dsh and type `/job-tracker-setup`. The installer:

1. Writes each command, skill and agent prompt to `$DSH_HOME/skills/job-tracker-<name>/` (`~/.dsh` by
   default), with plugin paths filled in.
2. Runs `dsh plugin --profile <name> add @deepseek-ai/dsh-hooks-claude-code` for the `web` and `headless`
   profiles. Pass `--profile <name>` (repeatable) to pick others.
3. Adds a block to each profile's `cordis.patch.yml` that mounts the tracker (`serverName: job_tracker`) and
   `plugin/hooks/dsh-hooks.json`. Your own entries stay. If the file is not a plain patch list, it prints the
   block for you to add.

Check the result with `dsh --profile web --dump-config`.

**After editing the markdown or pulling a new version**, run the installer again: the skills are copies.

**Run it from a checkout, not from `node_modules`.** Node does not strip TypeScript types under
`node_modules`, so `dsh plugin add` of this repo cannot work.

**Uninstall:** `node --no-warnings plugin/scripts/dsh-install.ts --uninstall` (same `--profile` flags), then
`dsh plugin --profile <name> remove @deepseek-ai/dsh-hooks-claude-code` if nothing else uses it.

## How it maps

| Claude Code | DeepSeek Harness |
|---|---|
| `hooks/hooks.json` | `hooks/dsh-hooks.json`, run by the hook bridge with the same matchers, through `hooks/dsh.ts` |
| (transcript file) | `PostToolUse` appends each MCP call to `~/.job-tracker/sessions/<sid>.steps.jsonl`; the bridge's `transcript_path` is always empty |
| `stop_hook_active` | always `false` from the bridge; `dsh.ts` counts the blocks in the session file, so a sweep is held three times, then let go |
| `onFailure: "block"` | not supported; the browser and mail group's command turns any failure into exit 2, which blocks, and `dsh.ts` gives up after 10 s, before the bridge's 30 s timeout |
| `/job-tracker:approve 12` | `/job-tracker-approve 12` (dsh skill names cannot contain a colon); `dsh.ts` maps it back for the prompt gate |
| `$ARGUMENTS` | the prompt hook adds a note: `$ARGUMENTS = "<args>"` |
| `${CLAUDE_PLUGIN_ROOT}` in markdown | replaced with the checkout path when the skills are written |
| subagents `agents/*.md` | skills `job-tracker-agent-<name>`, launched with the `subagent` tool |
| `.mcp.json` tracker | `@deepseek-ai/dsh-mcp-client`, stdio (tools `mcp__job_tracker__*`) |
| name clash: command `setup` and skill `setup` | command → `job-tracker-setup`, skill → `job-tracker-setup-guide` |
| `approve`, `allow-consent` | `disable-model-invocation: true`: only a typed `/name` loads them |

## Known differences

1. **A gate that cannot start can still let a call through.** The bridge treats a hook that fails to start, is
   killed by a signal or times out as passing. The browser and mail matcher group turns every failure of
   `node` into a block, and `dsh.ts` stops itself before the timeout. A shell that cannot start at all, or a
   hook the bridge kills at its 30 s timeout, still passes. Other MCP tools fail open, as on Claude Code.
2. **The prompt hook sees every message of a step, not one typed message.** The bridge joins the text of all
   messages claimed for the step. An approval counts only when that text is exactly `/job-tracker-approve <id>`.
   A subagent's task goes through the same hook, in the child's own session; with no browser page in that
   session's step log the approval is not recorded, and messages between agents carry a prefix
   (`Agent <id> sent a message:`) that never matches.
3. **Tool errors are detected by their text.** The bridge passes the tool result as text without `isError`.
   The step log marks a result as an error when it is JSON with an `error` field, which is what the tracker
   returns. Other servers' errors can count as results.
4. **Only MCP tools are gated.** dsh's own tools (shell, file edits, web fetch) are not matched, as on Claude
   Code. Use a browser through MCP (Claude in Chrome, Playwright) so the submit and consent gates see it.
5. **`node` must be on the PATH of dsh's shell.** The hooks run `node` from dsh's shell. The tracker uses the
   absolute path the installer found.
6. **No per-agent model.** `model: sonnet` in `agents/*.md` is ignored.
7. **No built-in scheduler.** Schedule the sweep with launchd or cron: `dsh headless "/job-tracker-sweep"`.
