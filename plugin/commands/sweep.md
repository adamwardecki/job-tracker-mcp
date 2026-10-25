---
description: The daily job-hunt run (what the scheduled task runs). Inbox, sourcing, verify, score, prepare, report, audit. Never submits.
argument-hint: "[--limit N] [--calibration]"
---

Run today's job-hunt sweep. Arguments: `$ARGUMENTS`

**If the tracker tools are missing** (search for them first if tools are deferred), or a hook error says `node` could not start: Node.js, which the plugin runs on, is missing or too old. Record nothing. End the run with one sentence saying so and that `/job-tracker:setup` installs it.

This is the command the weekday scheduled task runs. It runs as a local scheduled task, and the browser may not be connected, so it must complete with **connectors and the tracker only**. A browser or a local folder is a bonus, never a requirement.

## Hard rules

- **Never submit an application, never send anything.** Drafts only. Applying happens later in `/job-tracker:apply` with the user present. Why: the unattended run has no approval from the user, and submissions are irreversible.
- Never report work you could not do. If a capability is missing, say so in the report and queue the work.
- Every role you touch gets a tracker event (`upsert_role`, `transition` or `record`) with a reason; pass the `run_id` on events. A stop hook refuses to end this session until that is true and `render_report` was called (Claude Code and DeepSeek Harness: `Stop`; Hermes: a post-turn check that sends you back with a `[job-hunt]` note).
- Hooks block send tools, unlinted drafts, submit clicks and similar. If a hook denies an action, report the denial in the run summary. Do not retry it another way.
- Keep the final output short: the report, then nothing else.
- **Commands the user types carry the real role id.** Write them filled in, next to the company and title, e.g. "Acme, Senior Engineer: `/job-tracker:apply 42`". Never show `<id>` or `<role_id>` placeholders: the user does not know the ids.

## Arguments

- `--limit N`: stop sourcing once N new roles have been assessed (calibration uses 5). Default: no limit, but prepare at most 8.
- `--calibration`: use `kind: "calibration"` in `start_run`. Set by the setup skill.

## Procedure

**Agents.** "Launch a `sourcer`/`scorer`/`auditor` agent" means: on Claude Code, the plugin subagent of that name; on Hermes, `delegate_task` with the goal as stated and `context` set to the full text of skill `job-tracker:agent-<name>` (load it with `skill_view`) plus the inputs listed here; on DeepSeek Harness, the `subagent` tool with the goal as stated, the full text of skill `job-tracker:agent-<name>` (load it with the `skill` tool) and the inputs listed here.

1. **Status and capabilities.**
   - Call `setup_status`. If the tracker itself is unreachable, stop and say so: there is nowhere to record work.
   - Detect capabilities: which connectors respond (Gmail, Google Calendar, LinkedIn, Drive), which browser is reachable (Claude in Chrome, the host's built-in browser such as Hermes `browser_*` tools, or none), and whether a local folder is readable. Detect by checking the tool list (use tool search if tools are deferred) and making one cheap read call per connector. A tool that exists but errors counts as unavailable.
   - Call `start_run` with `kind` (`sweep`, or `calibration` if `--calibration`) and the capabilities object. Keep the returned `run_id`.
   - Call `get_profile` and `list_rules`. Apply every active rule for the rest of the run.
   - Call `open_items` and `source_health`. Another session may have touched roles today; build on its events, do not duplicate them.

2. **Inbox and calendar.** If Gmail or Calendar is connected, follow the `inbox-and-calendar` skill. If not, note it for the report and continue.

3. **Source.** Follow the `source-roles` skill to choose today's sources from config and capabilities. Launch one `sourcer` agent per available source, in parallel. Browser sources are skipped when no browser is reachable; list each skip in the report (do not mark the source failed for it). Collect each sourcer's lead list.

4. **Dedupe.** The sourcers already call `find_company` before `upsert_role`. For any lead they marked `seen` or `skip`, do not verify again. A company with `no_cold_apply` or a live application is never prepared.

5. **Verify and score.** For each `found` role from this run, launch a `scorer` agent (one role per agent, several in parallel). Each scorer follows `verify-employer` then `score-role` and writes `transition` events with evidence. Respect `--limit`.

6. **Prepare.** Take the top scored roles (default 3, at most 8, in score order) that cleared every hard filter. For each:
   - Follow the `write-note` skill to write the cover note. `lint_prose` must pass.
   - Save it with `add_artifact` (`kind: "cover_note"`).
   - `transition` the role to `queued` with a reason naming the note, the `run_id`, and `blocked_by: "browser"` if no browser was available this run, else `blocked_by: "user"`.
   - Roles with a single blocking question (scorers already queued them with `question` and `blocked_by: "user"`) get their note too, so the user can decide and apply in one go.
   - Do not open apply forms in this run, even if a browser is available. Submitting needs the user.

**Asking the user** anywhere in this plugin means: `transition` (or `record`, if already queued) to `queued` with `question` = the single blocking question and the quotes in `evidence`. `render_report` lists these under **Needs you**.

7. **Report.** Call `render_report` with today's date (YYYY-MM-DD), the `run_id`, and a `headline` (one or two sentences: the outcome, e.g. "3 roles queued, 1 interview to book, 2 rejections"). Check that it states which capabilities were missing and what was queued or skipped because of it. If it does not, add one line under Needs you. End the report with the line `Board: run /job-tracker:board`. Why: a scheduled run can't open the board, and its link changes each time the board starts.

8. **Audit.** Launch the `auditor` agent with: today's date, the `run_id`, the rendered report, the list of artifact ids and Gmail draft ids created in this run, and the list of tool names you called (including any a hook denied). Put every FAIL line it returns at the top of the report's **Needs you** section.

9. **Deliver** per `schedule.report_delivery`:
   - `artifact` (default): the report is your last message.
   - `file`: write it to `daily-report-<date>.md` in the local folder if one is reachable; otherwise fall back to `artifact` and say so.
   - `email_draft`: if Gmail is connected, create a draft to the user's own address (never send), read it back with `get_draft`, then `add_artifact` (`kind: "gmail_draft"`) and `verify_artifact`. Also output the report as your last message.

10. **Finish.** Call `finish_run` with the `run_id` and a one-line summary (counts: assessed, dropped, queued, drafts verified, audit pass/fail).

## When sources are caught up

If every lead today is a company already in the tracker, say "sources are caught up" in the report and stop. Do not widen the filters to manufacture a shortlist.
