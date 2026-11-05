# Tracker MCP: tool reference

The tracker is the only writer to the job-hunt database. Skills, commands and agents read and write
state through these tools only. There is no raw SQL tool.

Server name in `.mcp.json`: `tracker`. The tools appear as `mcp__plugin_job-tracker_tracker__<tool>` in
Claude Code and as `mcp__job_hunt_tracker__<tool>` in Hermes. Skills refer to them by the short tool name.

Runtime: Node 22.18+ (`node:sqlite`, TypeScript run directly), zero runtime npm dependencies. Local only:
`.mcp.json` starts `node servers/tracker/src/index.ts` over stdio. There is no network listener and no
token; the optional board (see [Board](#board)) listens on `127.0.0.1` with a per-start token and
stops after 30 idle minutes. Access is the OS user's permissions on `$JOB_TRACKER_HOME` (default `~/.job-tracker/`, created `0700`;
the database and session files are `0600`). Tightening is best effort: on a filesystem that cannot
chmod, a warning is logged and the tracker still starts. Data never lives in the plugin directory.

The schema is versioned with `PRAGMA user_version` and migrated on open, under the write lock. A database
written by a newer plugin is refused rather than downgraded, including on read-only opens. Writers wait
up to 5 s for another session's lock, and write transactions take the lock up front (`BEGIN IMMEDIATE`),
so concurrent first opens and migrations are safe.

**Days and runs.** Timestamps are stored in UTC. A `date` argument (`YYYY-MM-DD`) means that local day in
`filters.timezone` (UTC if unset). `render_report`, `audit` and `list_artifacts` also take `run_id`. It
wins over `date`, and the result covers the run's own events and artifacts plus untagged ones written
while it ran. Interview `starts_at` is stored in UTC. A time without an offset is read in `tz` (or
`filters.timezone`), and the report shows interview times in local time.

## Status machine

```
found → verified → scored → queued → applied → interviewing → offer
  ↘        ↘         ↘        ↘
   dropped (from found | verified | scored | queued)
closed (from queued | applied | interviewing | offer), with outcome: rejected | withdrawn | role_closed
```

- Every event needs a `reason`.
- `dropped` needs `evidence`: a verbatim employer quote, a URL plus quote, or `rule:<id>`. The one
  exception is a move the user makes on the board (below).
- `verified` needs `evidence` (the employer ATS URL and the verbatim location line) and
  `location_line` + `location_type`. It is the only way `roles.verified_at` gets set.
- `applied` needs `evidence` containing the captured confirmation text. The one exception is a move the
  user makes on the board (below): it is their own report, recorded without it. `transition` and `record`
  can never skip it, whatever `actor` says.
- `closed` needs `outcome`.

## Tools

| Tool | Args | Returns |
|---|---|---|
| `setup_status` | — | Checklist: each item `{key, state: green|amber|red, detail, decision?}`, plus `all_green` and `db_path`. Call at the start of every run. |
| `record_setup_decision` | `key`, `decision` | Records the user's decision on an amber item (e.g. "no browser, accepted"); setup can then complete. |
| `start_run` | `kind` (`sweep`\|`apply`\|`triage`\|`setup`\|`calibration`), `capabilities` `{connectors:{gmail,calendar,linkedin,drive,...}, browser: "claude-in-chrome"\|"built-in"\|null, local_folder: bool}` | `{run_id}`. Also stores capabilities in profile. |
| `finish_run` | `run_id`, `summary` | ok |
| `get_profile` | — | All config sections (filters, prefs, writing, accounts, autonomy, schedule, capabilities) |
| `save_config` | `section`, `data` | Validated against the schema; errors list bad fields |
| `get_document` / `save_document` | `name` (`profile`\|`stories`\|`reusable-answers`\|`voice`), `content` | User-owned markdown documents |
| `find_company` | `name?`, `domain?`, `url?` | Exact URL or ATS posting first, across all companies and recorded aliases, then fuzzy match on name, aliases, domain and ATS slug. `{matches:[{company, score, certain, roles:[{id,title,status,url}]}], live_application, no_cold_apply, verdict: "new"\|"seen"\|"skip", why, exact_role_ids}`. Several `exact_role_ids` mean a conflict to resolve. A URL that `upsert_role` would refuse is still looked up, as written. `roles` lists one card per linked group, and only cards count as a live application. `seen` is a known company with nothing blocking: a different requisition there is a new lead, even after a rejection there. `skip` for a tracked posting is for discovery; applying to a known, never-applied queued role goes by its role id through `gate_check`. **This is the dedupe check.** |
| `set_no_cold_apply` | `company_id`, `on?`, `reason` | Mark (or clear) a company with an open intro or recruiter process. |
| `add_alias` | `company_id`, `alias` | Add a brand, former name or parent so dedupe catches it. |
| `upsert_role` | `{id?, company, company_aliases?, company_domain?, title, url, url_aliases?, identity_evidence?, ats?, location_line?, location_type?, comp_min?, comp_max?, comp_currency?, comp_period?, equity?, stack?, industry?, source, posted_at?}` | `{role, company, created, dedupe, possible_role_ids}`. `dedupe` is the `find_company` result, on creates and updates alike, and is omitted when `id` is given. New roles get a `found` event. `id` updates that role. Otherwise an exact URL or ATS posting, under any company, updates the role holding it and leaves its company alone; `company` is then optional. A title never matches: a new role lists same-title roles at the company in `possible_role_ids`, to rule out before scoring. `url` and `url_aliases` must be http(s) without credentials. `url_aliases` need `identity_evidence` saying how the listings were confirmed as one posting; it is stored on the alias rows, and on a `url` that joins an existing role, but not on a new role's own `url`. A URL held by another role, or matching several roles, is a tool error naming them, and nothing is written. A role holds one posting per employer board: a second posting ID from the same ATS and employer is a different requisition and an error, and a posting on another ATS or board (an employer that moved ATS) needs `identity_evidence`. Every URL stays a lookup after it changes; an ATS link wins the role's main `url` over a listing that only points at the job, in either order, including an ATS link given in `url_aliases`, which also gives a role without a URL its main one. |
| `transition` | `role_id`, `to`, `reason`, `evidence?`, `outcome?`, `category?` (drops), `question?` + `blocked_by?` (queued), `location_line?`, `location_type?`, `score?`, `score_notes?`, `run_id?` | Enforces the machine above. |
| `get_role` | `role_id` | Role, company, full event history, artifacts, interviews, `urls:[{url, normalized_url, evidence}]`, `postings:[{provider, employer_key, posting_id}]`, `requested_role_id`, `linked_role_ids`, `links:[{duplicate_role_id, title, url, status, reason, evidence, created_at}]`. A linked duplicate's id returns its canonical role. Events, artifacts and interviews then cover the whole group, each with its own `role_id`; `urls` and `postings` are the group's, each listed once; `links` keeps each duplicate's own row and why it was linked. See [Duplicate roles](#duplicate-roles). |
| `link_duplicate_role` | `canonical_role_id`, `duplicate_role_id`, `reason`, `evidence` | `{canonical_role_id, linked_role_ids}`. Links a historical duplicate row to the role kept as its card. See [Duplicate roles](#duplicate-roles). |
| `record` | `role_id`, `status?`, `reason`, `evidence?`, `outcome?`, `category?`, `question?`, `blocked_by?`, `actor` (`user`\|`employer`\|`pipeline`), `run_id?`, `source?`, `source_account?`, `source_id?`, `occurred_at?` | Appends a validated event without the machine check. For outcomes that arrive from outside (rejection, invite, user decision) and for notes (`status` omitted = note). A `question` on the latest event shows under Needs you. Returns `{role, event_id, duplicate, status_applied, conflict?}`. `source`, `source_account`, `source_id` and `occurred_at` come together or not at all, and make the event an external one (see below). |
| `check_pay` | `comp_min?`, `comp_max`, `currency`, `period` (`year`\|`month`\|`day`\|`hour`), `fx_rate?` (units of floor currency per 1 unit of `currency`), `equity?` | `{verdict: "keep"\|"straddles"\|"drop"\|"unknown", reason}`. Drop only if the band max is below the floor. |
| `gate_check` | `role_id` | `{ok, role_id, company, title, url, verified, dedupe_clean, no_cold_apply, live_elsewhere, previous_application, matched_role_id?, problems[]}`. Fails when the role is not verified, the company is `no_cold_apply`, another card at the company is applied, interviewing or offer, the role itself is live, dropped or closed, or the posting was applied to before. A posting is applied to once: an `applied`, `interviewing`, `offer`, or `closed` (`rejected` or `withdrawn`) event on any row of its group, or on an unlinked row holding one of its URLs or ATS postings, sets `previous_application` and blocks it even after a board move back to the queue; `matched_role_id` is the row holding the latest such event. An unlinked row holding the same posting also blocks on its own until the rows are linked or corrected. A rejection blocks only that posting: other requisitions at the company stay open. `dedupe_clean` is false on a live application elsewhere, a previous application or an unlinked row for the posting. Hooks call this before a submit click, on a read-only connection that never migrates (an older database blocks, asking for the tracker to be started once), and bind approval to `url`. |
| `add_artifact` | `role_id`, `kind` (`cover_note`\|`cover_letter_pdf`\|`gmail_draft`\|`form_answers`\|`confirmation`\|`note`), `ref`, `content?` | `{artifact_id}`. Prose kinds are linted; issues are returned. `gmail_draft` starts unverified. |
| `list_artifacts` | `run_id?`, `date?`, `role_id?`, `kind?` | Artifacts with lint results and read-back state (the auditor uses this). |
| `verify_artifact` | `artifact_id`, `readback` (the text returned by `get_draft`/`list_drafts`) | Marks verified. The tracker checks the draft id is in the read-back; a hook checks a real `get_draft`/`list_drafts` result in the session contains it. |
| `lint_prose` | `text`, `max_words?` | `{ok, issues:[{kind, match, hint}]}`: em/en dashes, "not X but Y", fake-candid openers, volunteered gaps, word count. |
| `open_items` | `stale_after_days?` (14) | Fresh queue, stale queue, questions on non-queued roles, unverified drafts, interviews to book, upcoming interviews |
| `add_rule` / `list_rules` / `deactivate_rule` | `text`, `reason`, `example?`, `types?` / `types?`, `limit?`, `cursor?`, `include_inactive?` / `id` | Rules with provenance. `add_rule` returns `{rule_id}`; `types` is one or more of the rule types below, and omitted or `null` means `global`. **`list_rules` is paginated: a call with no arguments returns at most 10 rules plus a `next_cursor`, and callers must follow it until it is `null` (see [Listing rules](#listing-rules)).** It returns `{rules, next_cursor, total, rules_revision}`; each rule has its stored fields plus `types`; a rule too large to list is a short `{id, types, requires_detail: true}` entry (see [Oversized rules](#oversized-rules)). Rules from before types existed are `global`. `deactivate_rule` returns `{deactivated: id}`. Repeating it on an already inactive rule is a no-op and leaves `rules_revision` alone. |
| `get_rule` | `id`, `cursor?`, `limit?` (1 to 4000, default 4000) | `{id, chunk, next_cursor, rules_revision}`. One piece of the JSON text of the whole rule; only for a `requires_detail` entry (see [Oversized rules](#oversized-rules)). Works on inactive rules. |
| `set_rule_types` | `id`, `types` (non-empty) | `{rule_id, types, rules_revision}`. Replaces the rule's classification and nothing else: text, reason, example, author and date stay. Duplicates collapse; an empty list, a non-string or an unknown type is an error and writes nothing. |
| `source_health` / `set_source_status` | — / `name`, `status` (`ok`\|`degraded`\|`failed`\|`disabled`), `found?`, `applied?`, `error?`, `source_account?`, `checked_through?`, `coverage?` (`complete`\|`partial`\|`unavailable`) | Per-source health; N consecutive failures flips to `degraded`. `source_health` returns `{sources, checkpoints}`; each checkpoint is `{source, source_account, checked_through, last_coverage, last_attempt_at}` for one source account (the source name is trimmed and lowercased, so `Gmail` and `gmail` are one). `coverage` needs `source_account`; `complete` also needs `status` `ok` and `checked_through` (ISO 8601 with an explicit offset, stored as UTC, not more than a day ahead). Only `complete` moves `checked_through`, and only forward; `partial` and `unavailable` record `last_coverage` and `last_attempt_at` and keep the last successful cutoff, which is `null` until the account's first complete scan. `checked_through` is the actual endpoint of what was read: the 48-hour overlap belongs to the caller's next search window. `sources.last_run` still moves on every report, failures included. With `coverage` the result adds `checkpoint`; calls without these fields behave as before. |
| `add_interview` | `role_id`, `stage`, `starts_at?` (ISO with offset, or a wall time read in `tz`), `tz?` (IANA), `people?`, `link?`, `booked_by?`, `notes?`, `interview_id?`, `state?` (`pending`\|`scheduled`\|`cancelled`), `source?`, `source_account?`, `source_id?`, `occurred_at?`, `run_id?` | Records an interview or updates one. Returns `{interview_id, created, updated, stale, state}`; an identical retry sets all three booleans false and an ignored older update sets only `stale`. See [Interviews](#interviews). |
| `render_report` | `date` (YYYY-MM-DD, local day), `run_id?` (preferred: that run only), `headline?` | Markdown daily report (spec §9). Only verified drafts and confirmed submissions are claimed. Missing capabilities and what was queued because of them are listed. Interview times are shown in local time. |
| `audit` | `run_id?` or `date?` (one is required) | Post-run rule check: excluded industries touched, drops without evidence, applied without confirmation, prose lint failures in artifacts, unverified drafts. `{ok, failures[]}` |
| `pipeline_summary` | `stale_after_days?` (14) | Counts by status, live processes (interviewing, offer), awaiting reply, rejections, fresh and stale queue |
| `open_board` | `open?` (bool, default false: also open the default browser) | `{reused, opened, url?}`. With `open: true` and the browser opened, no `url`: the token stays out of the model's context. Otherwise `url`, and the text result is `Board: <url>`. Starts the local board for this database, or reuses the running one. See [Board](#board). |
| `import_legacy` | `applied_log?` (markdown), `preferences?` (markdown), `queue?` (`[{filename, content}]`), `documents?` (`{profile, stories, reusable-answers}`), `path?` (local only: a `pipeline/` folder) | Import counts and unparsed rows. If a queue note's URL matches two roles that are not linked, the import stops with an error naming them and writes nothing. Check them with `get_role`, link them with `link_duplicate_role` if they are one posting, then import again. |

## Rule types

A rule has one or more types saying which consumers read it: `global`, `sourcing`, `scoring`, `forms`, `writing`, `inbox`, `reporting`. A rule can apply to several consumers. Rules added without `types`, and every rule that existed before types, are `global`. `rules_revision` counts rule changes: it goes up when a rule is added, when its types really change, and when an active rule is deactivated. Reads and no-op changes leave it alone.

### Listing rules

`list_rules({types?, limit?, cursor?, include_inactive?})` returns `{rules, next_cursor, total, rules_revision}`.

- **It no longer returns every rule.** The default call returns at most 10 rules, in ascending id order, plus `next_cursor`. Pass `next_cursor` back as `cursor` until it is `null`; a caller that stops after the first page has only part of the rules. `limit` is a whole number from 1 to 50 (default 10) and may change between pages. `total` counts the whole filtered result, not the page. `next_cursor` is `null` on the last page, including a page that is exactly full. No match is `{rules: [], next_cursor: null, total: 0}`.
- **Filter by consumer.** `types` is one or more rule types and matches a rule that has any of them or `global`: global rules always come with a filtered request, and a rule that applies to several requested types appears once. Omitted `types` means every rule. Repeated or reordered types are the same filter. `include_inactive` adds deactivated rules.
- **A cursor binds the filters and `rules_revision`.** Send only `cursor` (and optionally `limit`) to continue; the cursor's `types` and `include_inactive` are inherited. Giving a different `types` or `include_inactive` with a cursor is an error. The cursor is opaque: a malformed, edited or wrong-version cursor is an error, not a guess.
- **A rule change ends the listing.** Adding a rule, changing its types or deactivating it moves `rules_revision`. A cursor issued before the change is refused with an error that says to restart `list_rules` without a cursor. Discard the pages already read and collect the set again; never mix pages from two revisions.
- Each page is read at one revision inside one transaction, so repeated reads at the same revision return the same pages.
- **A page can be shorter than `limit`.** The pretty-printed result JSON (`JSON.stringify(result, null, 2)`, with `next_cursor`, `total` and `rules_revision`) is kept to 24 KiB (24 * 1024 bytes of UTF-8). Whole rules are added while both the count limit and the byte budget hold; the page then ends and `next_cursor` points after the last rule it holds. A page is never empty while matching rules remain. The budget applies before the protocol wraps the result: `tools/call` carries the same data as the text content (pretty-printed, so the figure above) and as `structuredContent` (the same object, so no larger). Only `next_cursor` says whether more remain, never the page length.

### Oversized rules

A rule that cannot fit a page even alone is listed as `{id, types, requires_detail: true}` with no text; the server never shortens a rule. It counts as a page entry, so the listing continues past it. Read it with `get_rule({id})`:

- `chunk` is a piece of the JSON serialization of the complete rule, the object a normal list entry would be (`id`, `text`, `reason`, `example`, `added_by`, `added_on`, `active`, `types`), not just its text. Call again with `cursor: next_cursor` until it is `null`, join the chunks in order, then `JSON.parse` the result. Never parse or act on a partial chunk.
- A chunk holds at most `limit` Unicode code points (1 to 4000, default 4000) and never splits a surrogate pair. Even 4000 code points of 4-byte characters, escaped, stay far under the 24 KiB budget. The last chunk is never empty.
- The cursor binds the rule id, the offset into the serialization (in code points) and `rules_revision`. A cursor for another rule, a malformed or out-of-range one, or one issued before a rule change is an error that says to restart `get_rule` without a cursor. Discard the chunks already read when it says so.
- An unknown id is an error. Inactive rules can be read, with `active: 0` in the rule.
- This is the exception: ordinary rules arrive complete in `list_rules` and need no extra call.

## Events from outside

`record` can take an event from a mailbox or board without replaying it or reordering history. Pass `source`
(`gmail`, `board`, ...), `source_account` (the mailbox or account, which scopes the id), `source_id` (the source's
own id for one immutable occurrence: a message id, or a board application id with its original date; not a thread or
a mutable card) and `occurred_at` (ISO 8601 with an explicit offset). All four or none: a partial group, an empty
key, a time with no offset, that is not a real date, or that is more than 24 hours ahead of now is refused, and
nothing is written. `source` is trimmed and lowercased (`Gmail` and `gmail` are one source); `source_account` and
`source_id` are trimmed and otherwise kept exactly as given.

- **Time.** `occurred_at` is stored as UTC and becomes the event's `ts`; the time the tracker heard of it is kept in
  `received_at`. Receipt time and the role's `updated_at` never decide order. Every existing event has
  `received_at = ts`.
- **Idempotent.** `(source, source_account, source_id)` is unique. Repeating a call returns the original `event_id`
  with `duplicate: true`, `status_applied: false`, and writes nothing, also through a linked duplicate's id. The run,
  the reason and the receipt time may differ. A different role, actor, status, outcome, category, question,
  `blocked_by`, evidence or `occurred_at` under the same key is an error, so a changed payload is never discarded.
  The same `source_id` in another account is another event.
- **Chronology.** The event is always appended. `roles.status` moves (`status_applied: true`) only when the event
  happened after every status event of the role's whole group and the status machine allows the move from the
  current status. An older event (a late acknowledgement of an application that was already rejected) is recorded
  with `status_applied: false` and no conflict. An event at exactly the time of a different status, or a newer
  one the machine forbids (for example `interviewing` after a rejection, or `applied` on a role still in
  `found`), is recorded as evidence with `status_applied: false` and a `conflict` that says why. Nothing is forced,
  and nothing reopens a closed role. Settle those with `transition` or the user.
- **Not a submission.** An imported `applied` event keeps its `source`, so reports do not count it as an application
  the plugin submitted. It still counts for `gate_check`: a posting applied to before stays `previous_application`.
- Calls without the four fields are unchanged: `event_id` and `status_applied` (whether a status was written) are
  the only additions to the result, and the status is written through whatever the caller asked for, as before.

## Interviews

`add_interview` updates the interview a call is about instead of adding a row each time, so a confirmed booking
replaces the earlier "to book" row. An interview has a `state`: `pending` (a booking still to make, no time),
`scheduled` (has a time) or `cancelled`. `open_items` lists `pending` ones under `interviews_to_book` and
`scheduled` ones in the future under `upcoming_interviews`; a cancelled one is in neither, and neither are the
interviews of a closed or dropped role. Rows from before states existed became `scheduled` with a time and `pending`
without.

- **Which interview.** In this order: `interview_id` (it must belong to the role's group, else an error and no
  write); the external key (`source`, `source_account`, `source_id`, `occurred_at`, all four or none, as for
  [events from outside](#events-from-outside); `source_id` is the calendar event or message id, and for a recurring
  event includes the occurrence); otherwise a call with a `link` updates the one pending interview of the role
  (a linked duplicate's group counts) with exactly that stage and link, and several candidates are an error naming
  their ids, with nothing written. A call with none of these adds a new interview: a stage alone never identifies a
  round, so rounds never merge. An `interview_id` together with an external key ties that interview to the key,
  once. The same key under another role is an error; the same `source_id` in another source or account is another
  interview.
- **Fields.** An update keeps the stored value of any field it omits (`link` may change once the interview is
  found). `state` defaults to `scheduled` with `starts_at` and otherwise stays. `scheduled` needs a time (`starts_at`
  is read in `tz`, else the stored zone, else `filters.timezone`, and stored as UTC); `pending` has none; giving a
  time to a `cancelled` interview needs an explicit `state`. An invalid zone, date or state is an error and writes
  nothing.
- **Order.** `occurred_at` is when the event happened, not when it was read. For an interview with a key, an
  update older than the newest applied one returns `stale: true` and changes nothing, so a late "booking link" cannot
  undo a scheduling and a late scheduling cannot undo a cancellation. An update at the same time is a no-op if
  identical and an error if it differs. A newer one applies in every direction, including rebooking a cancelled
  interview. Calls without a key apply in the order they arrive and never move that order, so an event that
  happened before a local edit but is read after it still applies, and wins for the fields it carries; the edit stays
  in `interview_changes`.
- **History.** Each change that is applied (including the first) adds a row to `interview_changes` with the
  occurrence time, the receipt time, the `run_id`, and the interview's fields before (null for a new one) and after.
  It also appends a note event to the role with `category: 'interview_changed'`, the same `run_id`, and the
  occurrence time as its `ts`; the reason says what changed. Identical retries write neither.
- **Status.** A pending or scheduled interview moves the role to `interviewing` only when the status machine allows
  it from the role's status and no later status event exists (so an `applied` role moves; a `queued` one, a closed
  or a dropped one does not, and an older invite cannot reopen a rejection). Cancelling never changes the status.

## Duplicate roles

Rows that an older release created twice for one posting stay in the database with their events, artifacts and
interviews. `link_duplicate_role` makes one of them the canonical role and records the other in `role_links` with
the reason and evidence. Nothing is deleted and no event is rewritten.

- **Checks.** Both roles exist, differ, and belong to the same company; `reason` and `evidence` are non-empty. The
  two groups may not hold two posting IDs from the same ATS and employer (different requisitions). Histories must
  agree: a duplicate with only preparatory states (found, verified, scored, queued, or dropped before any
  application) links under a canonical role that has an applied, interviewing, offer or closed event. When the
  duplicate has such an event, the canonical role needs one too, both latest statuses (and outcomes) must match,
  and the canonical's must be no older than the duplicate's. Here "latest" means the latest status event of any
  kind, so a later move to queued or dropped counts and is refused unless it matches. Two preparatory rows link only
  when the canonical one moved last; otherwise swap the ids. Linking never changes a status: correct the canonical
  role with `transition` or `record` first.
- **Groups stay flat.** Every link points at a root. A `canonical_role_id` that is itself a duplicate stands for
  its root. A `duplicate_role_id` already linked to another root is refused with the root to link instead, and a
  root cannot become a duplicate of its own member. Linking a root that has duplicates moves them to the new root
  in the same transaction. Linking the same pair again returns the current group.
- **Old ids.** Every tool that takes a `role_id` (`get_role`, `transition`, `record`, `gate_check`,
  `add_artifact`, `add_interview`, `list_artifacts`, `upsert_role` with `id`, and the board) acts on the canonical
  role. New events, artifacts and interviews are written there, so a duplicate's status never changes after the
  link. `find_company`'s `exact_role_ids` and `upsert_role`'s matching count a group once; rows of independent
  groups are still a conflict.
- **Views.** The board, `open_items`, `pipeline_summary` and `find_company`'s `roles` show one card per group,
  judged by the canonical role's status, with the group's latest events and questions. `gate_check` likewise
  ignores a duplicate's stale status when it looks for a live application elsewhere, and reads the whole group's
  history for a previous application. Reports and audits attribute a duplicate's events
  and artifacts to the canonical card (audit `role_id`); the events keep their own ids and `role_id`.

## Board

`open_board` starts `node servers/tracker/src/board.ts --db <same database>` as a detached process. It
reuses the board named in `board.json` next to the database while that process is alive and answers
`GET /api/health` with the board's token. It refuses an in-memory tracker. The board:

- listens on `127.0.0.1` only, on a port the OS picks, with a new 256-bit token per start. The token is
  in the link's fragment (`#t=`), so it is never sent in a request line, and every API call sends it as
  `Authorization: Bearer <token>`.
- rejects any `Host` other than `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), sends no CORS
  headers, and accepts only `application/json` posts up to 64 KB.
- stops after 30 minutes without an authenticated API call and removes `board.json`.
- moves roles with `transition`, recorded with `actor: user`. Between its lanes (`scored` to `closed`)
  the user moves freely, backwards and out of `dropped` or `closed` too; the model's `transition` stays
  forward-only. Roles still `found` or `verified` can't be moved, nothing can be moved to them, and only a
  role that was verified and scored can be moved to `scored` or `queued`.
- accepts changes (`POST`) only from its own page: the browser's `Origin` must be the board's and
  `Sec-Fetch-Site`, when sent, `same-origin`. A script holding the token gets 403. With `open: true`,
  `open_board` gives the link to the browser and not to the model, and the `PreToolUse` hook stops
  browser tools from opening the board or acting on its page in any session.
- records `applied` without confirmation text and `dropped` without evidence: the user is the authority
  on their own search. `render_report` lists these as "Marked applied by you on the board" and "Dropped:
  by you on the board" so one the user didn't make stands out, and `audit` does not count them as
  `applied_without_confirmation` or `drop_without_evidence`.
- shows the columns from `scored` on, with `dropped` and `closed` folded; `found` and `verified` roles
  are counted in the header. A drop moves at once and the card opens with an optional reason, saved
  as a note; `closed` asks for its outcome first. Cards show the pay band when the posting had one.

| Endpoint | Body | Returns |
|---|---|---|
| `GET /api/health` | none | `{ok: true}` |
| `GET /api/board` | none | `{statuses, roles, rules}`: roles with company, score, location type, URL, pay band, last event time, blocking question and `moves` (the lanes the role may be dragged to); active rules |
| `POST /api/move` | `{role_id, to, reason?, evidence?, outcome?}` | `{role, from, to}`, or 400 with the status machine's message. Without a reason the event says "Moved on the board" |
| `POST /api/note` | `{role_id, reason}` | `{role}`: the user's own reason for a move, recorded as a note (no status change) |

## Session approvals (hooks, not tools)

Approvals come only from a standalone command in the user's own prompt, never from a command mention
or tool call. The `UserPromptSubmit` hook recognises `/job-tracker:approve <role_id>` (or `/approve
<role_id>`) and stores a one-use approval for that role, browser page and tab in the session state at
`$JOB_TRACKER_HOME/sessions/<session_id>.json`. The submit-click hook requires an exact target match and
consumes the approval before allowing the attempt. Similarly `/job-tracker:allow-consent <role_id>` lets
consent boxes be ticked only on that role's current page and tab.

## Triage guard (hooks)

Before any delete on a tracker board, run `skills/triage-tracker/guard.js` with `javascript_tool`
(replace the INPUT placeholder on its last line). It prints `JOBHUNT_TRIAGE_GUARD {json} JOBHUNT_END`.
The delete hook requires the latest guard output to show `ok: true` (selection exactly equals the
intended list, every protected column has 0 checked, counts match `expectedCounts`), no more than
about 40 tool calls old, with only the delete control and its confirm button clicked since.
