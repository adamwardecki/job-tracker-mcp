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
**Window and coverage** (the one place these mechanics live; sweep, auditor and the board readers point here). For each source account you scan (the recruiter mailbox, LinkedIn, each calendar, each enabled board):
- Search from that account's `checked_through` in `source_health.checkpoints` minus 48 hours, to now. Why: a mail that landed during the last scan, or a late booking, is picked up on the next one. No checkpoint: the last 30 days. A historical backfill needs an explicit date range from the user; never say you searched everything.
- Follow every connector page (`next_page_token` or equivalent) to the end before calling the scan complete. Page two failing means the scan is `partial`.
- Afterwards call `set_source_status` with `name` (`gmail`, `linkedin`, `calendar`, or the board's ID), `source_account`, `coverage` and, for `complete`, `status: "ok"` and `checked_through` = the actual end of the window you searched. A failed or partial scan is `partial` (some pages read) or `unavailable` (nothing read) with `status: "failed"` and the verbatim `error`: never `complete`, no `checked_through`. A connected source you did not check this run is reported `unavailable`, not omitted. Why: only complete coverage may move the checkpoint, so a gap is searched again instead of being skipped for good.

- Gmail `search_threads` over that window, in the recruiter inbox. Useful terms: ATS sender domains (ashbyhq.com, greenhouse.io, lever.co, workable, teamtailor, personio), "application", "interview", "unfortunately", "next steps", "schedule", plus the domains of companies with live processes.
- Third-party tools: auto-apply recap emails, broker intro emails. Take board URLs from these emails rather than guessing.
- LinkedIn connector (if present): read the inbox list, then open each job-related conversation in full (`get_conversation`). A jobs-search failure is not a logout if the inbox works.

### 3. Match and classify
**Identity keys.** Every `record` and `add_interview` from outside carries `source`, `source_account`, `source_id` and `occurred_at` together, with `occurred_at` the real time of the message, application or event (ISO with offset), not now. Gmail: `source: "gmail"`, `source_account` = the mailbox, `source_id` = the immutable message ID of the message that says it (not the thread ID). Board application: the board's application ID plus the original application date. Calendar event: account + calendar + event ID, with the occurrence for a recurring event. If the identity or the date is unknown, `record` a note with the evidence instead and say what is uncertain; never invent metadata.

For each thread: `get_thread` (full messages), then match it to a company with `find_company` (sender domain and name, plus the posting `url` when the mail links one: `exact_role_ids` then names the role). Several roles at the company and no URL: pick the one the mail names by title and req, and `get_role` to confirm before recording on it. No role in the tracker but clearly about one: `upsert_role` with `source: "inbound"` and the posting `url` when the mail has one; if it returns `possible_role_ids`, check them as in Identity in `source-roles` and record the outcome on the role that is this posting. Match at role level even when another role at the company is live, and a `find_company` verdict of `skip` for a tracked posting does not stop you recording external evidence on that existing role. Why: a URL-less upsert always creates a new role, so an outcome recorded on it would miss the role that holds the application.

Classify into one of:

| Class | Tells | Action |
|---|---|---|
| **Rejection** | "unfortunately", "not moving forward", "position filled" | `record` with `status: "closed"`, `outcome: "rejected"` (or `role_closed` if filled/cancelled), `actor: "employer"`, `evidence` = feedback verbatim, or the key sentence if no feedback |
| **Booking link** | `you.ashbyhq.com/meeting/...`, Calendly, SavvyCal, Google appointment pages, "book a time", "select a time through the link", "direct booking link" | **No draft.** `add_interview` with `stage`, `people`, `link`, the message's key and `occurred_at`, and **no** `starts_at` (that marks it "to book"; the role moves to interviewing only when the status machine allows it). Before reporting it as to book, check the full threads and calendars for a confirmed time. List free windows for the report. |
| **Invite** | Calendar invite or a confirmed time | `add_interview` with `starts_at`, `tz`, `stage`, `people`, `link`, `booked_by`, the key and `occurred_at`. It updates the pending row for that round: never add a second row for it, and pass `interview_id` when you know the booking. Check it appears on the invite calendar. |
| **Cancellation** | "cancelled", "need to rebook", a deleted invite | `add_interview` with `state: "cancelled"`, the booking's `interview_id` or key, and `occurred_at`. It leaves the to-book list; a new time later is a new update, not a new round. |
| **Reply needing an answer** | A question in prose, request for CV, availability asked in prose with no link, terms | Reply draft (step 4) |
| **Acknowledgement** | "we received your application" | If the tracker does not show the role as applied (the user applied themselves, or a tool did), `record` `status: "applied"`, `actor: "user"`, evidence = the acknowledgement text, `occurred_at` = when it arrived. Otherwise `record` a note, `actor: "employer"`. This records the external application as it happened, never a new submission. |
| **Holding note** | "still reviewing", "we'll be in touch" | `record` note, `actor: "employer"` |
| **Intro or direct conversation** | Broker intro in progress, a founder or hiring manager writing directly | Mark the company no-cold-apply (step 5) and `record` a note |
| **Not job-related** | Other projects, newsletters, social digests | Ignore |

**Results of `record` and `add_interview`.** `duplicate: true` (or all of `created`, `updated`, `stale` false) is a replay: a no-op, say nothing new. `stale: true` means a newer update is already stored: leave it. `status_applied: false` with a `conflict` (for example an acknowledgement for a role still in found, verified or scored, or equal-time statuses): do not retry or force a status; list it under Needs you with the role and the conflict text. `status_applied: false` with no `conflict` is older evidence, kept. A ToolError that lists several candidate interviews: ask the user which round, listing the IDs. If the role is still `queued` or `found` when an invite arrives, the application happened outside the tracker: `record` the application evidence (sourced) first, then `add_interview`; do not skip the evidence. Why: the booking is then attached to a role whose history shows how it got there.

### 4. Reply drafts
1. Write the reply with `write-note` rules: short, answers the question asked, no gaps volunteered, signature name only, no bare URLs.
2. `lint_prose`; fix until `ok`.
3. `create_draft` in the recruiter inbox, threaded as a reply where the connector supports it.
4. **Read back**: `get_draft` with the returned draft id. If not found, check `list_drafts`. If it is in neither, the draft does not exist: try once more, and if it still fails, report "draft could not be saved" and put the text in a `record` note. Never report a draft you have not read back.
5. `add_artifact` with `kind: "gmail_draft"`, `ref` = draft id, `content` = body. Then `verify_artifact` with `artifact_id` and `readback` = the text returned by `get_draft`.

### 5. No-cold-apply
A company with an open broker intro, a recruiter-run process, or a direct conversation with a founder or hiring manager must never get a cold application. Call `set_no_cold_apply` with the `company_id` (from `find_company`; `upsert_role` the company's role first if it is new), `on: true` and a `reason` naming the channel (e.g. "broker intro open", "recruiter process", "direct thread with the CTO"). `find_company` then returns `skip` and `gate_check` blocks a submit. When the intro or process closes, call it again with `on: false` and `record` a note.

### 6. Calendar
- `list_events` on the connected calendar for the window of step 2 and the next 14 days, following every page. Match interviews from `open_items`; a match updates that interview (`interview_id`), and an invite with no matching row is added with its calendar key.
- Compare the connected account with `accounts.invite_calendar`. Different: say so once in the report, and list interviews as "not visible on the connected calendar".
- For booking links, list free windows during working hours over the next few working days.
- Do not create or accept events in an unattended run. If the user asks for a hold in a session and `create_event` is refused (connector read-only), report the slot and ask them to add it.

## Output

For the report: which sources and calendars were checked, and any `partial` or `unavailable`; interviews (time in the user's timezone, stage, people, link), links still to book with free windows, outcomes with feedback quotes, and verified drafts only. Unverified drafts appear under Needs you as "could not confirm draft".
