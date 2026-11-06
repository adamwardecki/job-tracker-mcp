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
- Expect: the full thread and LinkedIn conversation are read; the booking-link mail creates the pending row with
  no key; the confirmation calls `add_interview` with that row's `interview_id`, `starts_at` and the calendar
  event's key (or, with no visible event, `source: "gmail"`, `source_id: "m-201"`) and `occurred_at` = the message
  time; one interview row, now `scheduled`; the report lists the interview, not "waiting on you", and the "to book"
  claim waited until the calendars were read in step 6.
- Must not: report the booking as waiting on the user; add a second interview row; key the pending row to the
  booking-link message (a later confirmation could not update it).
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
  role. In the `found` variant with no substantive local decisions, the sourced acknowledgement establishes
  `applied` even when its occurrence predates discovery; the discovery timestamp stays unchanged. A variant with
  a substantive local decision returns `status_applied: false` with a `conflict` under Needs you.
- Must not: retry the record or force a status; click anything on the board.
- Result: UNEXECUTED

### 4. Replaying the same scan

- Seed: the state after case 3.
- Input: run the scan again over the same window.
- Expect: already-recorded messages are skipped after checking their keys in `get_role.events`, or replayed
  with the immutable stored payload. Every replayed `record` and `add_interview` returns `duplicate: true` (or no
  create/update/stale); the report adds nothing new; the checkpoint moves forward only.
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
- Expect: LinkedIn is reported `unavailable` with `status: "degraded"` (a skip by design is not a failure, so
  `consecutive_failures` does not move) and listed in the report; the auditor's source-coverage check FAILs if it
  is omitted. A variant where the LinkedIn call errors records `status: "failed"` and the verbatim error instead.
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
- Expect: `add_interview` with `state: "cancelled"` and the row's `interview_id` (no key if the row is already
  keyed to the calendar event); the interview leaves both `upcoming_interviews` and `interviews_to_book`; the role
  status is unchanged; replaying the older confirmation does not rebook it (a refusal naming `state: "scheduled"`
  goes under Needs you).
- Result: UNEXECUTED

### 10. Claude Code and Hermes / DeepSeek Harness parity

- Input: cases 1, 4 and 6 on each host, with the skill loaded through the host's own mechanism.
- Expect: the same calls on all three hosts; the rules file is read through the host path form
  (`${HERMES_SKILL_DIR}/../../templates/rules.md` on Hermes); the auditor subagent (Hermes `delegate_task`, DSH
  `subagent`) receives the run id and report and returns its coverage and booking checks.
- Result: UNEXECUTED

### 11. Stable acknowledgement across three scans

- Run both variants on each host: an Acme role initially `queued`, and a missing role discovered by the scan
  as `found`. Use an isolated scratch database for each variant.
- Input: Gmail `source: "gmail"`, `source_account: "jobs@example.test"`, immutable `source_id: "ack-601"`,
  `occurred_at: "2026-10-01T09:00:00Z"`, evidence exactly "Your application for Acme Engineer was received."
- Scan 1: expect the model to check `get_role.events`, then `record` the new receipt with `actor: "user"`,
  `status: "applied"`, `role_id`, `reason`, the exact evidence and all four identity fields. The missing variant
  must preserve its real discovery timestamp. Capture the actual arguments and returned `event_id`.
- Scan 2: present the identical receipt after the card becomes `applied`. Expect a key check in `get_role.events`,
  then either skip the recorded message or replay the identical immutable payload. A replay must return the first
  `event_id`, `duplicate: true`, `status_applied: false`; event count stays unchanged.
- Before scan 3, record a sourced rejection at `2026-10-20T09:00:00Z` with a distinct message ID. Present the
  original receipt again. Expect the same key check and skip or identical replay; the rejection stays current,
  event count stays unchanged, and any replay returns the first receipt's event id with `duplicate: true`.
- Must not: change actor/status according to the current card, rewrite evidence, invent an id/time, reopen the
  rejection, or count a plugin submission. Ordering preserves the rejection without reclassifying the receipt.
- Capture per host and variant: actual `get_role`/`record` calls, receipt and rejection event ids, duplicate flags,
  event counts before/after each retry, final role status, and the report. Unit MCP tests verify API behavior;
  only an actual host run establishes that the model chose the stable payload.
- Results: Claude Code UNEXECUTED; Hermes UNEXECUTED; DeepSeek Harness UNEXECUTED.

### 12. Legacy keyed employer note

- Seed through the scratch MCP server: the acknowledgement from case 11 already recorded as `actor: "employer"`
  with no status/outcome, the same evidence, source fields and occurrence time. Save its `event_id`.
- Input: the same receipt is seen again, including after a subsequent rejection.
- Expect: inspect `get_role.events` and identify the matching source/account/message key; skip it or replay its
  stored employer-note payload, omitting null status/outcome. An identical replay returns the original `event_id`
  and `duplicate: true`, with no event or card change. Capture the actual arguments and returned ids.
- API negative control on the scratch server: converting that key to `actor: "user"`, `status: "applied"` must
  return an immutable-payload error and leave history unchanged. The model must choose the stable note/skip path;
  surface a genuine mismatch under Needs you, without inventing another id or time.
- Capture per host: stored event, actual `get_role`/`record` calls or skip decision, event ids and counts, final
  status and report. Keep the API negative-control outcome separate from the model's behavior.
- Results: Claude Code UNEXECUTED; Hermes UNEXECUTED; DeepSeek Harness UNEXECUTED.
