---
name: inbox-and-calendar
description: Reads recruiter mail, LinkedIn messages and the calendar through connectors, classifies each message (reply, rejection, invite, booking link, acknowledgement, holding note), records outcomes in the tracker, and creates reply drafts that are read back before being reported. Use in step 2 of every sweep, when the user asks what came in, or when checking whether an interview is booked.
---

# Inbox and calendar

Turn incoming mail into tracker events and, where a written answer is needed, a verified Gmail draft.

## Hard rules

- **Drafts only. Never send, reply-send, forward, or message.** A hook blocks every send tool. If the user in the session explicitly asks to send, explain that the hook blocks it and that they can send the draft from Gmail themselves.
- **Booking link present → no draft.** Surface the link, the stage and the people in the report. Why: a draft proposing times is work the user has to read and discard when one click on the link does the job.
- **A draft is not real until it is read back.** After `create_draft`, call `get_draft` with the returned id (or find it in `list_drafts`), then `add_artifact` (`kind: "gmail_draft"`) and `verify_artifact` with the read-back text. Why: `create_draft` once returned ids for three drafts that did not exist. A hook denies `verify_artifact` unless a `get_draft`/`list_drafts` result in this session contains that draft id.
- **Draft bodies are linted by a hook** and denied on em/en dashes or volunteered gaps. Run `lint_prose` yourself first.
- **Rejection feedback is stored verbatim** in `evidence`. Do not paraphrase it.
- **Check the calendar the invites actually land on** (`accounts.invite_calendar`). If the connected calendar is a different account, say "not visible on the connected calendar, check your <account> calendar". Never call an invite missing or unaccepted on that basis. Absence from a calendar is never proof of no booking (it may sit on another account or calendar): name the calendars you checked.
- **Read full threads, not previews, and reconcile bookings before reporting any user action.** A "book a slot" preview is not "waiting on you" until the full thread and the calendars show no confirmed time. Why: the sweep read only the LinkedIn inbox preview and showed two booked interviews as "waiting on you".
- **Reconciliation is read-only.** No send, delete, submit or apply tool is used; boards are never written to.
- **LinkedIn is read-only.** Read the inbox for intelligence and dedupe; never reply, connect or follow.
- **Not every message is about the job hunt.** The user may use the same accounts for other work. Classify before reporting anything as a recruiter reply.

## Procedure

### 1. Context
`get_profile` (accounts, writing), `open_items`, `pipeline_summary`. Rules: load `inbox`, plus `writing` when you will draft a reply (Reading rules: `${CLAUDE_PLUGIN_ROOT}/templates/rules.md`; Hermes: `${HERMES_SKILL_DIR}/../../templates/rules.md`). Call `source_health` and keep `checkpoints` for step 2.

### 2. Gather mail
- Gmail `search_threads` over the window below, in the recruiter inbox. Useful terms: ATS sender domains (ashbyhq.com, greenhouse.io, lever.co, workable, teamtailor, personio), "application", "interview", "unfortunately", "next steps", "schedule", plus the domains of companies with live processes.
- Third-party tools: auto-apply recap emails, broker intro emails. Take board URLs from these emails rather than guessing.
- LinkedIn connector (if present): read the inbox list, then open each job-related conversation in full (`get_conversation`). A jobs-search failure is not a logout if the inbox works.

**Window and coverage.** This is the one place these mechanics live; the sweep, the auditor, the calendar step and the board readers point here. Apply it to every source account you scan (the recruiter mailbox, LinkedIn, each calendar, each enabled board).
- **Window.** From that account's `checked_through` in `source_health.checkpoints` minus 48 hours, to now. No checkpoint: the last 30 days. A historical backfill needs an explicit date range from the user; never say you searched everything. Why: a mail that landed during the last scan, or a late booking, is picked up on the next one.
- **Pages.** Follow every connector page (`next_page_token` or equivalent) to the end before calling the scan complete. Page two failing makes the scan `partial`.
- **Report each scan** with `set_source_status`: `name` (`gmail`, `linkedin`, `calendar`, or the board's ID), `source_account`, `coverage`, and for `complete` also `status: "ok"` and `checked_through` = the actual end of the window you searched.
- **A real error** (page two failed, a connector call was denied, a board errored): `partial` (some pages read) or `unavailable` (nothing read), with `status: "failed"` and the verbatim `error`. Never `complete`, no `checked_through`.
- **Skipped by design** (no browser reachable, connector not available this run): `unavailable` with `status: "degraded"`, which does not count as a failure (Capability-aware in `source-roles`). Report it; never omit a connected source.
- Why: only complete coverage may move the checkpoint, so a gap is searched again instead of being skipped for good.

### 3. Match and classify
**Identity keys.** Every `record` and `add_interview` from outside carries `source`, `source_account`, `source_id` and `occurred_at` together, or none of them. The one exception is a later sighting of an interview you already have the `interview_id` of: that passes `occurred_at` alone (see Which key an interview gets).
- `occurred_at` is the real time of the message, application or event (ISO with offset), not now.
- Gmail: `source: "gmail"`, `source_account` = the mailbox, `source_id` = the immutable message ID of the message that says it (not the thread ID).
- Board application: the board's application ID plus the original application date.
- Calendar event: account + calendar + event ID, with the occurrence for a recurring event.
- Identity or date unknown: `record` a note with the evidence and say what is uncertain; never invent metadata.

**Which key an interview gets.** The server updates the row it resolves by `interview_id`, then by key, then by a unique pending stage+link match. A row keeps the first key it gets, and a call carrying a different key for it is refused.
- Look the round up first (`open_items` `interviews_to_book` and `upcoming_interviews`, or `get_role`) and pass its `interview_id` on every call about it. Without the id, a replayed booking-link mail adds a second pending row.
- A booking-link mail creates the pending row with no key (omit all four). Why: a keyed pending row cannot be updated by the confirmation, which is a different message.
- The first confirmation ties the key once, with `interview_id`: the calendar event's key when you can see the event (it stays the same across reschedules), otherwise the Gmail message ID of the invite.
- A later sighting of an already keyed row from another message or source: pass `interview_id`, the changed fields and that message's own `occurred_at`, without `source`, `source_account` and `source_id` (the source group is never sent partly). The server compares `occurred_at` with the newest dated update on the row (`last_occurred_at` in `get_role` and `open_items`), so messages may be read in any order. A `stale: true` result means a newer update is already applied: do nothing. If the row already shows that time or state, call nothing. Why: without the time, an older mail re-read in the 48-hour overlap would revert a reschedule or cancel a rebooked interview. A refusal saying the interview "keeps the occurrence it came from" means you passed another source's key: drop it.

**Matching.** For each thread: `get_thread` (full messages), then match it to a company with `find_company` (sender domain and name, plus the posting `url` when the mail links one: `exact_role_ids` then names the role).
- Several roles at the company and no URL: pick the one the mail names by title and req, and `get_role` to confirm before recording on it.
- Match at role level even when another role at the company is live. A `find_company` verdict of `skip` for a tracked posting does not stop you recording external evidence on that existing role.
- No role in the tracker but clearly about one: `upsert_role` with `source: "inbound"` and the posting `url` when the mail has one. If it returns `possible_role_ids`, check them as in Identity in `source-roles` and record the outcome on the role that is this posting. Why: a URL-less upsert always creates a new role, so an outcome recorded on it would miss the role that holds the application.
- A clear sourced receipt can establish a newly discovered `found` role as `applied`, or clear sourced closure evidence can establish `closed` with a valid outcome, without backdating discovery or inventing verification, scoring or queue events. Pass the four identity fields and nonblank verbatim evidence. Only initial discovery markers are ignored; substantive local decisions or newer/equal-time conflicting evidence prevent bootstrap. Why: discovering the role now does not change when the external application happened.
- A replay does not reproject an old already-recorded stranded receipt. If the role still disagrees with its stored receipt, surface it under Needs you for explicit reconciliation; do not alter the key, time or evidence to force it. Why: retries must not silently reinterpret existing history.

Classify into one of:

| Class | Tells | Action |
|---|---|---|
| **Rejection** | "unfortunately", "not moving forward", "position filled" | `record` with `status: "closed"`, `outcome: "rejected"` (or `role_closed` if filled/cancelled), `actor: "employer"`, `evidence` = feedback verbatim, or the key sentence if no feedback |
| **Booking link** | `you.ashbyhq.com/meeting/...`, Calendly, SavvyCal, Google appointment pages, "book a time", "select a time through the link", "direct booking link" | **No draft.** `add_interview` with `stage`, `people`, `link` and **no** `starts_at` and no key (that marks it "to book"; the role moves to interviewing only when the status machine allows it). Hold the "to book" claim until step 6 has checked the calendars and the full threads for a confirmed time. |
| **Invite** | Calendar invite or a confirmed time | `add_interview` with `starts_at`, `tz`, `stage`, `people`, `link`, `booked_by`, `interview_id` when the round has a row, and the key per Which key an interview gets. Never add a second row for a round. Check it appears on the invite calendar. |
| **Cancellation** | "cancelled", "need to rebook", a deleted invite | `add_interview` with `state: "cancelled"` and the round's `interview_id` (key per Which key an interview gets). It leaves the to-book list; a new time later is a new update, not a new round. |
| **Reply needing an answer** | A question in prose, request for CV, availability asked in prose with no link, terms | Reply draft (step 4) |
| **Acknowledgement** | "we received your application" | If the tracker does not show the role as applied (the user applied themselves, or a tool did), `record` `status: "applied"`, `actor: "user"`, evidence = the acknowledgement text, `occurred_at` = when it arrived. Otherwise `record` a note, `actor: "employer"`. This records the external application as it happened, never a new submission. |
| **Holding note** | "still reviewing", "we'll be in touch" | `record` note, `actor: "employer"` |
| **Intro or direct conversation** | Broker intro in progress, a founder or hiring manager writing directly | Mark the company no-cold-apply (step 5) and `record` a note |
| **Not job-related** | Other projects, newsletters, social digests | Ignore |

**Results of `record` and `add_interview`.**
- `duplicate: true`, or `created`, `updated` and `stale` all false: a replay. A no-op; say nothing new.
- `stale: true`: a newer update is already stored. Leave it.
- `status_applied: false` with a `conflict` (for example substantive history blocks bootstrap, an acknowledgement for a verified or scored role, or equal-time statuses): do not retry or force a status. List it under Needs you with the role and the conflict text.
- `status_applied: false` with no `conflict`: older evidence, kept.
- A ToolError listing several candidate interviews: ask the user which round, listing the IDs.
- A ToolError saying a cancelled interview needs `state: "scheduled"` to rebook: do not rebook. List it under Needs you with both sightings.
- Role still `queued` or `found` when an invite arrives: the application happened outside the tracker. `record` the application evidence (sourced) first, then `add_interview`; do not skip the evidence. Why: the booking is then attached to a role whose history shows how it got there.

### 4. Reply drafts
1. Write the reply with `write-note` rules: short, answers the question asked, no gaps volunteered, signature name only, no bare URLs.
2. `lint_prose`; fix until `ok`.
3. `create_draft` in the recruiter inbox, threaded as a reply where the connector supports it.
4. **Read back**: `get_draft` with the returned draft id. If not found, check `list_drafts`. If it is in neither, the draft does not exist: try once more, and if it still fails, report "draft could not be saved" and put the text in a `record` note. Never report a draft you have not read back.
5. `add_artifact` with `kind: "gmail_draft"`, `ref` = draft id, `content` = body. Then `verify_artifact` with `artifact_id` and `readback` = the text returned by `get_draft`.

### 5. No-cold-apply
A company with an open broker intro, a recruiter-run process, or a direct conversation with a founder or hiring manager must never get a cold application. Call `set_no_cold_apply` with the `company_id` (from `find_company`; `upsert_role` the company's role first if it is new), `on: true` and a `reason` naming the channel (e.g. "broker intro open", "recruiter process", "direct thread with the CTO"). `find_company` then returns `skip` and `gate_check` blocks a submit. When the intro or process closes, call it again with `on: false` and `record` a note.

### 6. Calendar
- `list_events` on the connected calendar over the window above and the next 14 days, following every page. Match interviews from `open_items`: a match is passed with its `interview_id`, and an invite with no matching row is added with its calendar key.
- Then `set_source_status` for each calendar read (`name: "calendar"`, `source_account` = account and calendar, per Window and coverage). Its `checked_through` is the end of the search window (now), not the end of the 14-day lookahead. Why: the server refuses a `checked_through` more than a day ahead, and events after now were not read as history.
- Compare the connected account with `accounts.invite_calendar`. Different: say so once in the report, and list interviews as "not visible on the connected calendar".
- Settle the "to book" items from step 3 now: still no confirmed time in the threads or calendars read, then report it as to book, with free windows during working hours over the next few working days.
- Do not create or accept events in an unattended run. If the user asks for a hold in a session and `create_event` is refused (connector read-only), report the slot and ask them to add it.

## Output

For the report: which sources and calendars were checked, and any `partial` or `unavailable`; interviews (time in the user's timezone, stage, people, link), links still to book with free windows, outcomes with feedback quotes, and verified drafts only. Unverified drafts appear under Needs you as "could not confirm draft".
