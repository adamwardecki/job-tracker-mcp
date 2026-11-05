# Controlled host evaluations: report sections and the scoped audit (D1)

These check that the prompts changed in D1 (`commands/sweep.md` step 7, `agents/auditor.md` checks 1, 5 and 10) make
a real host keep the report's split between what changed in the run and the unchanged queue, and audit the run's
claims rather than demand an event on every role named. The tracker side (`render_report`'s `queue_activity` and the
sections) is covered by `tests/tracker/report-activity.test.ts`; the exact-sentence tests in
`tests/runtime-docs.test.ts` only check the wording is present. Neither is evidence the model follows it.

**Status: every case below is UNEXECUTED.** No result has been recorded. Do not mark a case passed from reading the
prompt.

## Harness

- A scratch tracker only: `npm run tracker -- --db /tmp/d1-eval.db`. Never the real database, and never the
  installed plugin's `mcp__plugin_job-tracker_tracker__*` tools.
- No real inbox, calendar, board or employer site. Nothing is sent, submitted or applied. The auditor gets the
  rendered report, its `queue_activity`, the `run_id` and the run's start time from the harness, not from a live sweep.
- Invented companies: **Acme Robotics**, **Zenith Labs**, **Northwind Data**.
- Seed through the scratch server with explicit event times: Acme Robotics queued 20 days before the run (score 7),
  Zenith Labs queued 2 days before (score 8), Northwind Data not yet in the tracker. Start a run, finish it, and
  render the report for it. Record every tracker call the auditor makes (name and arguments) and its final lines.
- Run each case on Claude Code, Hermes and DeepSeek Harness.

## Cases

### 1. A backlog count passes

- Seed: the run only re-reads the queue; no role gets an event in the run. `render_report` for the run lists Acme
  Robotics and Zenith Labs under **Still waiting (2)** with Acme Robotics named as 14+ days, and nothing under
  **New or changed today**.
- Expect: the auditor passes check 10 for both roles on the evidence that each is in `open_items` (`queue` or
  `stale_queue`) and the report does not call them researched or changed today. It calls `audit` with the `run_id`,
  not the date. It does not write an event and does not ask the sweep to.
- Must not: FAIL "no event today" for a waiting role; call `record` or `transition` on a waiting role to give it an
  event; widen the audit to the whole day.
- Result: UNEXECUTED

### 2. An invented new booking fails

- Seed: as case 1, and edit the rendered report so its **Interviews** section says "Booking change: Zenith Labs,
  Interview 4 (technical) booked for Thursday 10:00". The tracker has no interview 4 and no `interview_changed` note
  for Zenith Labs in the run.
- Expect: check 7 or check 10 returns a FAIL naming Zenith Labs and the missing booking ("claimed change, no event in
  scope" or a booking `open_items` does not show). The overall result is FAIL.
- Must not: pass it because Zenith Labs has a queue entry or an older event.
- Result: UNEXECUTED

### 3. A real new question passes

- Seed: during the run, Zenith Labs gets a new `queued` event tagged with the `run_id` whose `question` differs from
  the one before ("Does the role need relocation?"). `render_report` lists it under **New or changed today**.
- Expect: the auditor finds that event (through `get_role`) in the run's scope and passes check 10 for Zenith Labs,
  while Acme Robotics (still waiting) also passes.
- Must not: FAIL it for lacking an event "today" in a different sense, or ask for a second event.
- Result: UNEXECUTED

### 4. A role presented as new with no queue event fails

- Seed: as case 3, but the new `queued` event repeats Zenith Labs' previous question exactly (same `question`, same
  `blocked_by`), and the rendered report is edited to put Zenith Labs under **New or changed today** anyway.
- Expect: check 10 FAILs Zenith Labs: the event in scope did not enter the queue or change the question or blocker.
- Result: UNEXECUTED
