# Controlled host evaluations: posting identity and repeat applications (A4)

These check that the prompts changed in A4 (`commands/apply.md`, `commands/sweep.md`, `agents/sourcer.md`,
`agents/scorer.md`, `skills/source-roles`, `skills/verify-employer`, `skills/inbox-and-calendar`,
`skills/triage-tracker`) make a real host call the tracker the way the code expects. The exact-sentence tests in
`tests/runtime-docs.test.ts` are not evidence of this; only an actual run with the calls inspected is.

**Status: every case below is UNEXECUTED.** No result has been recorded. Do not mark a case passed from reading
the prompt.

## Harness

- A scratch tracker only: `npm run tracker -- --db /tmp/a4-eval.db` (or `JOB_TRACKER_HOME` pointed at a temp
  directory). Never the real database, and never the installed plugin's `mcp__plugin_job-tracker_tracker__*` tools.
- Fake external services: a local HTTP server serving the invented postings below, and a fake source (a static HN
  thread or ATS board JSON) and fake mailbox. No real inbox, board, LinkedIn or employer site.
- Run each case on Claude Code, Hermes and DeepSeek Harness. Record the tracker calls (name and arguments) from the
  transcript or step log, and the database state afterwards.
- Seed with the invented company **Acme Robotics** (`jobs.ashbyhq.com/acme`) and **Zenith Labs**
  (`jobs.lever.co/zenith`). People, if any, are invented too.

## Cases

### 1. URL-less re-run of a known lead does not create a second role (sourcer)

- Seed: role "Senior Engineer" at Acme, `url` = `https://jobs.ashbyhq.com/acme/se-1`, status `found`.
- Input: the fake HN source lists "Acme Robotics | Senior Engineer | Remote", no link.
- Expect: `find_company` with the name; `get_role` on the same-title role; no new row when the HN comment names the
  same req (or a new row whose `possible_role_ids` is then checked with `get_role`, and linked only if confirmed).
- Must not: `link_duplicate_role` on the title alone.
- Result: UNEXECUTED

### 2. A different requisition at a company that rejected the user is a lead (sourcer and sweep)

- Seed: Acme role `acme/se-1` applied, then `closed` with `outcome: rejected`.
- Input: the fake ATS board lists `https://jobs.ashbyhq.com/acme/staff-2` "Staff Engineer".
- Expect: `find_company` with that `url` returns `seen`; the sourcer calls `upsert_role` with the `url`; the sweep
  launches a scorer for the new `found` role (step 4 does not skip it).
- Must not: skip the lead because the company is `seen`; report "sources are caught up".
- Result: UNEXECUTED

### 3. A cross-site listing of a tracked ATS posting joins that role (sourcer)

- Seed: Acme role `acme/se-1`.
- Input: a fake LinkedIn card `https://www.linkedin.com/jobs/view/900` whose page links to `acme/se-1`.
- Expect: `upsert_role` with `url` = the Ashby link and `url_aliases: [LinkedIn link]` plus `identity_evidence`, or
  `id` of the known role; `find_company` returns `skip` for the LinkedIn URL afterwards.
- Result: UNEXECUTED

### 4. The scorer settles a possible duplicate before scoring

- Seed: two rows for Acme "Senior Engineer": one `queued` with `acme/se-1`, one `found` with no URL, passed to the
  scorer as `possible duplicate of <id>`. The fake employer page for the found row is `acme/se-1`.
- Expect: `get_role` on both; `upsert_role` with `id` and the employer URL is refused because the URL belongs to the
  other role; `link_duplicate_role` with evidence naming the shared URL; return `duplicate of <id>`; no `check_pay`
  or `scored` transition.
- Result: UNEXECUTED

### 5. Same title, different req: no link (scorer)

- Seed: Acme "Senior Engineer" `acme/se-1` and a `found` "Senior Engineer" whose employer page is `acme/se-3`.
- Expect: verified and scored as its own role.
- Must not: `link_duplicate_role`.
- Result: UNEXECUTED

### 6. Apply by URL to a known, never-applied queued role

- Seed: Acme `acme/se-1` verified, scored, queued, no application history.
- Input: `/job-tracker:apply https://jobs.ashbyhq.com/acme/se-1?utm_source=mail`
- Expect: `find_company` with the `url` gives one `exact_role_ids` entry; `gate_check` on that id before the form is
  opened; the flow continues to the form (the `skip` verdict does not stop it).
- Must not: `upsert_role` creating a second role.
- Result: UNEXECUTED

### 7. Apply to a reopened rejected role stops before preparation

- Seed: Acme `acme/se-1` applied, rejected, then moved back to `queued` on the board.
- Input: `/job-tracker:apply <that id>`, and separately the URL form.
- Expect: `gate_check` returns `previous_application: true`; the flow stops and explains it, before reading the form
  or writing a note. If forced on to the submit click, the hook denies it with the same problem.
- Result: UNEXECUTED

### 8. Apply through a linked duplicate's old id

- Seed: case 7's role, plus an old row for `acme/se-1` linked under it.
- Input: `/job-tracker:apply <old id>`.
- Expect: `gate_check` resolves to the canonical role and returns `previous_application: true`; the flow stops.
- Result: UNEXECUTED

### 9. A URL-less rejection mail lands on the role that holds the application (inbox)

- Seed: Acme "Senior Engineer" `acme/se-1` applied.
- Input: a fake mail from `acme.example` "Unfortunately, we will not move forward with your application for Senior
  Engineer", no link.
- Expect: `find_company`; `get_role` on the applied role; `record` `closed`/`rejected` on it.
- Must not: `upsert_role` creating a new URL-less role and recording the rejection there.
- Result: UNEXECUTED

### 10. Triage reconciles an Applied card for a tracked posting without a new row

- Seed: Acme `acme/se-1` queued.
- Input: a fake JobCopilot Applied card for Acme "Senior Engineer" linking to `acme/se-1`.
- Expect: `find_company` with the card's link gives the role in `exact_role_ids`; `record` `applied` on it.
- Must not: a second role; any delete without the guard (the delete guard sections are unchanged).
- Result: UNEXECUTED

### 11. The sweep does not prepare a role the gate would block

- Seed: a scored role at Zenith whose company is `no_cold_apply`, and a scored role that was rejected before and
  re-scored after a board move.
- Expect: `gate_check` on each in step 6; no cover note for either; both listed in the report with the problems.
- Result: UNEXECUTED
