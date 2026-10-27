# Hermes Agent integration

## Install

```bash
plugin/scripts/hermes-install.sh
```

Restart Hermes, then run `/job-tracker:setup`.

**Installed before the plugin moved into `plugin/`?** After `git pull`, run `plugin/scripts/hermes-install.sh`
again. It repoints the Hermes plugin link and the tracker MCP server at `plugin/`.

The installer answers `Y` when `hermes mcp add` asks to enable the tracker tools, then checks that Hermes saved
the `job_hunt_tracker` server. If it did not, the installer exits with an error and prints the command to run
by hand.

**Uninstall:** `hermes plugins disable job-tracker && hermes mcp remove job_hunt_tracker && rm ~/.hermes/plugins/job-tracker`

## How it maps

| Claude Code | Hermes |
|---|---|
| `PreToolUse` `mcp__.*` | `pre_tool_call`, filtered in Python to names starting `mcp__`, `connectors__` or `browser_` |
| (transcript file) | `post_tool_call` appends to `~/.job-tracker/sessions/<sid>.steps.jsonl` |
| `UserPromptSubmit` | `pre_llm_call`, which unwraps the slash-skill message first and skips subagents (`parent_session_id`) |
| `Stop` (blocks finishing) | `post_llm_call` stores a `pending_nudge`. Hermes tries `inject_message`, and the next `pre_llm_call` injects the nudge as context. Best effort: see Risks. |
| `deny` output | `{"action":"block","message"}` |
| `additionalContext` | `{"context"}` |
| `${CLAUDE_PLUGIN_ROOT}` in markdown | Add the equivalent `${HERMES_SKILL_DIR}` path next to it |
| `$ARGUMENTS` | `pre_llm_call` injects a note: `$ARGUMENTS = "<args>"` |
| subagents `agents/*.md` | skills `job-tracker:agent-<name>`, launched with `delegate_task` |
| `.mcp.json` tracker | `hermes mcp add job_hunt_tracker ...` (server name `job_hunt_tracker` → tools `mcp__job_hunt_tracker__*`) |
| name clash: command `setup` and skill `setup` | command → `job-tracker:setup`, skill → `job-tracker:setup-guide` |

## Known differences

1. **The stop gate is weaker on Hermes.** `post_llm_call` cannot hold the agent. The plugin tries
   `inject_message`, which is reliable in the classic CLI but needs a `session_key` or opt-in in
   Desktop/TUI, and otherwise delivers the note on the user's next turn. In **unattended Hermes cron
   sweeps** there is no next turn, so an incomplete sweep can end without a report.
2. **Approval parsing depends on Hermes' slash-skill message format** (`[IMPORTANT: The user has
   invoked the "..."`). Hermes could change that string. The markers are copied verbatim.
3. **Browser bypass routes Hermes adds:** `browser_cdp` and `browser_press` (Enter in a field) are not checked by the submit rules. The Claude version has the same gap with key presses.
4. **One skill namespace on Hermes:** the `setup` skill is named `job-tracker:setup-guide` on Hermes.
5. **No per-agent model on Hermes:** `model: sonnet` in `agents/*.md` is ignored.
