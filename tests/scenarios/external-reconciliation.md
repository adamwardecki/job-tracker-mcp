# Controlled host evaluations: external reconciliation (C4)

These check that the prompts changed in C4 (`skills/inbox-and-calendar`, `skills/triage-tracker` steps 3 and 7,
`skills/source-roles/reference.md` Jack & Jill and JobCopilot, `commands/sweep.md`, `agents/auditor.md`) make a real
host reconcile full external evidence the way the tracker expects. The shared mechanics (window, coverage, identity
keys, result handling) live once in `inbox-and-calendar`. The exact-sentence tests in `tests/runtime-docs.test.ts`
only check the wording is present; they are not evidence the model follows it.

**Status: every case below is UNEXECUTED.** No result has been recorded. Do not mark a case passed from reading
the prompt.

## Harness

- A scratch tracker only: `npm run tracker -- --db /tmp/c4-eval.db`. Never the real database, and never the
  installed plugin's `mcp__plugin_job-tracker_tracker__*` tools.
- Fake connectors only: a fake mailbox (two accounts), a fake LinkedIn inbox, a fake calendar per account, and a
  static fake JobCopilot board. No real inbox, calendar, board or employer site. Nothing is sent, deleted,
  submitted or applied; the board is read only.
- Invented companies and people: **Acme Robotics** (recruiter **Rhea Voss**), **Zenith Labs**.
- Seed roles through the scratch server. Record every tracker call (name and arguments) and the database
  afterwards. The pass condition is about the calls, then the outcome.
- Run each case on Claude Code, Hermes and DeepSeek Harness (case 10).

## Cases

### 1. Preview says "book a slot", the full thread confirms a time

- Seed: Acme role `applied`; a pending interview "Intro call" with a link and no time.
- Input: the LinkedIn inbox preview reads "Please book a slot with Rhea"; the full Gmail thread (message `m-201`)
  confirms Tuesday 14:00 Europe/Berlin; the invite calendar on a second account (`work@example.test`) holds the
  event.
- Expect: the full thread and LinkedIn conversation are read; `add_interview` with `interview_id` (or the key),
  `starts_at`, `source: "gmail"`, `source_account`, `source_id: "m-201"`, `occurred_at` = the message time; one
  interview row, now `scheduled`; the report lists the interview, not "waiting on you".
- Must not: report the booking as waiting on the user; add a second interview row.
- Result: UNEXECUTED

### 2. Calendar on a different account

- Seed: as case 1; the connected calendar is `home@example.test`, `accounts.invite_calendar` is
  `work@example.test`.
- Expect: the report says which calendars were checked and "not visible on the connected calendar, check your
  work@example.test calendar"; it does not call the invite missing, and does not record a cancellation.
- Result: UNEXECUTED

### 3. JobCopilot card already acknowledged by email

- Seed: a Zenith role, run once in `queued` and once in `found` (two variants). The board's Applied column holds the Zenith card
  (application ID `jc-77`, original date 2026-10-20); Gmail holds Zenith's acknowledgement (`m-310`, 2026-10-20).
- Expect: the board is read only. In the `queued` variant, `record` `applied` from the acknowledgement
  (`source: "gmail"`, `source_id: "m-310"`, `occurred_at` 2026-10-20), then the board card is recorded as evidence
  with its own key (`source: "jobcopilot"`, `source_id` = `jc-77` plus the date); no second application, no new
  role. In the `found` variant, `record` returns `status_applied: false` with a `conflict`, and it appears under
  Needs you with the role.
- Must not: retry the record or force a status; click anything on the board.
- Result: UNEXECUTED

### 4. Replaying the same scan

- Seed: the state after case 3.
- Input: run the scan again over the same window.
- Expect: every `record` and `add_interview` returns `duplicate: true` (or no create/update/stale); the report adds
  nothing new; the checkpoint moves forward only.
- Must not: report the replayed events again as new actions.
- Result: UNEXECUTED

### 5. Reversed confirmation and rejection order

- Seed: Acme role `applied`.
- Input: the scan reads a rejection (`m-400`, 2026-10-22) before the earlier acknowledgement (`m-390`,
  2026-10-20), and a booking confirmation (`m-410`, 2026-10-21) after the rejection in read order.
- Expect: the role ends `closed`/rejected; the acknowledgement is kept with `status_applied: false` and no
  conflict; the older invite does not reopen the role; nothing is retried or forced.
- Result: UNEXECUTED

### 6. Failure on the second search page

- Input: Gmail `search_threads` page 1 succeeds, page 2 errors twice.
- Expect: `set_source_status` with `source_account`, `coverage: "partial"`, `status: "failed"`, the verbatim
  `error`, and no `checked_through`; `source_health.checkpoints[].checked_through` is unchanged; the report says
  Gmail was only partly read.
- Must not: report `complete`; advance the checkpoint; claim the inbox was searched.
- Result: UNEXECUTED

### 7. A connected source that was not checked

- Input: Gmail, LinkedIn and Calendar are connected; the run skips LinkedIn (no time).
- Expect: LinkedIn is reported `unavailable` (a `set_source_status` with `coverage: "unavailable"` and the reason),
  and listed in the report; the auditor's source-coverage check FAILs if it is omitted.
- Result: UNEXECUTED

### 8. Two possible roles

- Seed: two Acme roles, "Senior Engineer" and "Staff Engineer", both live; the mail names "Staff Engineer" and
  no posting URL.
- Expect: `find_company` then `get_role` on both; the outcome is recorded on the named role only (even though
  the other is live); if an interview ToolError lists several candidate interviews, the model asks which round,
  listing the IDs, and writes nothing.
- Result: UNEXECUTED

### 9. A later cancellation

- Seed: the scheduled interview from case 1.
- Input: `m-520`, a later message, cancels the call.
- Expect: `add_interview` with `state: "cancelled"`, the `interview_id` or key and `occurred_at` of `m-520`; the
  interview leaves both `upcoming_interviews` and `interviews_to_book`; the role status is unchanged; a replay of
  the older confirmation `m-201` returns `stale`.
- Result: UNEXECUTED

### 10. Claude Code and Hermes / DeepSeek Harness parity

- Input: cases 1, 4 and 6 on each host, with the skill loaded through the host's own mechanism.
- Expect: the same calls on all three hosts; the rules file is read through the host path form
  (`${HERMES_SKILL_DIR}/../../templates/rules.md` on Hermes); the auditor subagent (Hermes `delegate_task`, DSH
  `subagent`) receives the run id and report and returns its coverage and booking checks.
- Result: UNEXECUTED
