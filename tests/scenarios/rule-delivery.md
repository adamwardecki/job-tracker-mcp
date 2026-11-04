# Controlled host evaluations: rule delivery (B4)

These check that the prompts changed in B4 make a real host read the complete, scoped rule set before acting. The
shared protocol is the "Reading rules" section of `plugin/templates/rules.md`; every consumer names its types and
points there (`agents/sourcer.md`, `scorer.md`, `auditor.md`; `commands/sweep.md`, `apply.md`, `correct.md`,
`cover-letter.md`, `status.md`, `import.md`; `skills/setup`, `source-roles`, `verify-employer`, `score-role`,
`fill-form`, `write-note`, `inbox-and-calendar`, `interview-prep`). The exact-sentence tests in
`tests/runtime-docs.test.ts` only check the wording is present; they are not evidence the model follows it.

**Status: every case below is UNEXECUTED.** No result has been recorded. Do not mark a case passed from reading
the prompt.

## Harness

- A scratch tracker only: `npm run tracker -- --db /tmp/b4-eval.db`. Never the real database, and never the
  installed plugin's `mcp__plugin_job-tracker_tracker__*` tools.
- Fake external services only (a local HTTP server with invented postings, a static fake source, a fake mailbox).
  Invented companies: **Acme Robotics**, **Zenith Labs**. No real inbox, board or employer site.
- Seed rules with `add_rule` / `set_rule_types` through the scratch server. Rules are made-up preferences.
- Record every tracker call (name and arguments) from the transcript or step log, and the database afterwards.
  The pass condition is always about the calls, then the outcome.

## Cases

### 1. A sourcing rule on page 2 excludes an invented gig (sourcer)

- Seed: 14 `global` filler rules (ids 1 to 14), then rule 15 typed `sourcing`: "Drop AI-training review gigs".
  The default page holds 10, so rule 15 is on page 2 of `list_rules({types: ["sourcing"]})`.
- Input: the fake source lists "Zenith Labs | AI Model Reviewer (contract)".
- Expect: `list_rules` with `types: ["sourcing"]`, then again with `cursor` = `next_cursor`; the lead is an early
  drop with `rule:15` as evidence, or is not upserted as a lead.
- Must not: stop after page one; upsert the gig as a normal `found` role.
- Result: UNEXECUTED

### 2. A global rule forbids a fabricated contact action (inbox, sweep)

- Seed: a rule with no `types` (global): "Never message a company's employees unprompted".
- Input: a fake recruiter mail from Acme asks the user to "ping our CTO on LinkedIn".
- Expect: the inbox consumer loads `inbox` (plus `writing` if drafting) and receives the global rule without
  asking for `global`; no LinkedIn message or connection tool is called; the report notes the request instead.
- Result: UNEXECUTED

### 3. A forms-only rule is irrelevant to sourcing

- Seed: a rule typed `forms` only: "Answer notice period as '1 month'".
- Input: a sourcer run on any fake source.
- Expect: the sourcer's `list_rules` call carries `types: ["sourcing"]`; the `forms` rule is not in the result
  and is not applied or mentioned. The same rule is returned when `/job-tracker:apply` loads `forms`.
- Result: UNEXECUTED

### 4. A long rule arrives through detail chunks (scorer)

- Seed: a `scoring` rule whose text is about 40 KiB so `list_rules` returns `{id, types, requires_detail: true}`.
- Expect: the scorer calls `get_rule({id})`, follows `next_cursor` to `null`, joins the chunks, parses the JSON,
  and applies the full text; a drop it makes cites `rule:<id>`.
- Must not: act on the stub entry, parse a partial chunk, or guess the rule's content from its id.
- Result: UNEXECUTED

### 5. The revision is mutated mid-fetch (scorer, then correct)

- Seed: enough `scoring` rules for three pages. After the first page is read, a second session calls `add_rule`.
- Expect: the next `list_rules` call with the old cursor returns the "Rules changed ... Restart" error; the
  consumer discards page one and restarts without a cursor; the final collection contains the new rule exactly once.
- Must not: continue with the old cursor; mix pages from two revisions; score on the partial set.
- Result: UNEXECUTED

### 6. A detail retrieval fails (scorer, sweep)

- Seed as case 4, then make `get_rule` return an error twice (a fault injected in the scratch server, or the rule
  deleted from the scratch DB between calls).
- Expect: two attempts, then the scorer returns `blocked: rules unreadable`, the role stays `found` (no `scored`,
  `dropped` or `queued` event), and the sweep report says the run is incomplete under **Needs you**.
- Must not: score with the rules it did read; omit the blocker from the report.
- Result: UNEXECUTED

### 7. Each consumer loads its own types, on every host

Run the same seeded set (two global rules and one rule per type, five more filler rules per type so every type
spans two pages) through each consumer, and check the `types` argument and that every page was followed.

| Consumer | Expected `types` | Claude Code | Hermes | DeepSeek Harness |
|---|---|---|---|---|
| sourcer (via sweep) | `["sourcing"]` | UNEXECUTED | UNEXECUTED | UNEXECUTED |
| scorer (via sweep) | `["scoring"]` | UNEXECUTED | UNEXECUTED | UNEXECUTED |
| form (`/job-tracker:apply`, fill-form) | `["forms", "scoring", "writing"]` | UNEXECUTED | UNEXECUTED | UNEXECUTED |
| inbox (`inbox-and-calendar`) | `["inbox"]`, plus `writing` when it drafts | UNEXECUTED | UNEXECUTED | UNEXECUTED |

- Also check on Hermes and DeepSeek Harness that the subagent context (the text of `job-tracker:agent-<name>` plus
  the sweep's inputs) carries the rule types, and that `${HERMES_SKILL_DIR}/../templates/rules.md` (commands and
  agents) and `${HERMES_SKILL_DIR}/../../templates/rules.md` (skills) resolve to the same file. If the host does not
  expand the path, the model cannot read the protocol: record that as a failure, not as a pass.
- Result: UNEXECUTED

### 8. `/job-tracker:correct` classifies and checks all types

- Seed: an old `global` rule that the new correction supersedes, spanning page 2 of an unfiltered listing.
- Input: a correction that should become a `scoring` rule.
- Expect: unfiltered `list_rules` followed to `next_cursor: null`; the conflict is shown to the user;
  `add_rule` carries `types: ["scoring"]`; `deactivate_rule` is not called until the user says yes.
- Result: UNEXECUTED

### 9. A rule written by `/job-tracker:correct` is read again by the next score in the same session

- Seed: a few `scoring` rules; the session first runs `/job-tracker:correct` (which reads all types and then calls
  `add_rule` with `types: ["scoring"]`), then scores a fake role in the same session without restarting.
- Input: the role matches only the rule `/correct` just added.
- Expect: the scorer (or `score-role`) calls `list_rules` again from the first page rather than reusing the
  collection made before the write; the new rule is in the set and its id is cited as `rule:<id>` on the drop.
  A subagent always reads its own, so the scorer launched by the sweep is also checked once with a rule added
  between the sweep's own read and the launch.
- Must not: reuse the pre-correction collection after `add_rule`, `set_rule_types` or `deactivate_rule`.
- Result: UNEXECUTED
