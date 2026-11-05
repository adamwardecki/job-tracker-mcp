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
- **Check the calendar the invites actually land on** (`accounts.invite_calendar`). If the connected calendar is a different account, say "not visible on the connected calendar, check your <account> calendar". Never call an invite missing or unaccepted on that basis.
- **LinkedIn is read-only.** Read the inbox for intelligence and dedupe; never reply, connect or follow.
- **Not every message is about the job hunt.** The user may use the same accounts for other work. Classify before reporting anything as a recruiter reply.

## Procedure

### 1. Context
`get_profile` (accounts, writing), `open_items`, `pipeline_summary`. Rules: load `inbox`, plus `writing` when you will draft a reply (Reading rules: `${CLAUDE_PLUGIN_ROOT}/templates/rules.md`; Hermes: `${HERMES_SKILL_DIR}/../../templates/rules.md`). Note the last sweep date from `source_health` or the previous run.

### 2. Gather mail
- Gmail `search_threads` since the last run (one or two days if unknown), in the recruiter inbox. Useful terms: ATS sender domains (ashbyhq.com, greenhouse.io, lever.co, workable, teamtailor, personio), "application", "interview", "unfortunately", "next steps", "schedule", plus the domains of companies with live processes.
- Third-party tools: auto-apply recap emails, broker intro emails. Take board URLs from these emails rather than guessing.
- LinkedIn connector (if present): read the inbox list. A jobs-search failure is not a logout if the inbox works.

### 3. Match and classify
For each thread: `get_thread`, then match it to a company with `find_company` (sender domain and name, plus the posting `url` when the mail links one: `exact_role_ids` then names the role). Several roles at the company and no URL: pick the one the mail names by title and req, and `get_role` to confirm before recording on it. No role in the tracker but clearly about one: `upsert_role` with `source: "inbound"` and the posting `url` when the mail has one; if it returns `possible_role_ids`, check them as in Identity in `source-roles` and record the outcome on the role that is this posting. Why: a URL-less upsert always creates a new role, so an outcome recorded on it would miss the role that holds the application.

Classify into one of:

| Class | Tells | Action |
|---|---|---|
| **Rejection** | "unfortunately", "not moving forward", "position filled" | `record` with `status: "closed"`, `outcome: "rejected"` (or `role_closed` if filled/cancelled), `actor: "employer"`, `evidence` = feedback verbatim, or the key sentence if no feedback |
| **Booking link** | `you.ashbyhq.com/meeting/...`, Calendly, SavvyCal, Google appointment pages, "book a time", "select a time through the link", "direct booking link" | **No draft.** `add_interview` with `stage`, `people`, `link` and **no** `starts_at` (that marks it "to book"; the role moves to interviewing only when the status machine allows it). Read the calendar and list free windows for the report. |
| **Invite** | Calendar invite or a confirmed time | `add_interview` with `starts_at`, `tz`, `stage`, `people`, `link`, `booked_by`. Check it appears on the invite calendar. |
| **Reply needing an answer** | A question in prose, request for CV, availability asked in prose with no link, terms | Reply draft (step 4) |
| **Acknowledgement** | "we received your application" | `record` note, `actor: "employer"`. If the tracker does not show the role as applied (the user applied themselves, or a tool did), `record` `status: "applied"`, `actor: "user"`, evidence = the acknowledgement text |
| **Holding note** | "still reviewing", "we'll be in touch" | `record` note, `actor: "employer"` |
| **Intro or direct conversation** | Broker intro in progress, a founder or hiring manager writing directly | Mark the company no-cold-apply (step 5) and `record` a note |
| **Not job-related** | Other projects, newsletters, social digests | Ignore |

### 4. Reply drafts
1. Write the reply with `write-note` rules: short, answers the question asked, no gaps volunteered, signature name only, no bare URLs.
2. `lint_prose`; fix until `ok`.
3. `create_draft` in the recruiter inbox, threaded as a reply where the connector supports it.
4. **Read back**: `get_draft` with the returned draft id. If not found, check `list_drafts`. If it is in neither, the draft does not exist: try once more, and if it still fails, report "draft could not be saved" and put the text in a `record` note. Never report a draft you have not read back.
5. `add_artifact` with `kind: "gmail_draft"`, `ref` = draft id, `content` = body. Then `verify_artifact` with `artifact_id` and `readback` = the text returned by `get_draft`.

### 5. No-cold-apply
A company with an open broker intro, a recruiter-run process, or a direct conversation with a founder or hiring manager must never get a cold application. Call `set_no_cold_apply` with the `company_id` (from `find_company`; `upsert_role` the company's role first if it is new), `on: true` and a `reason` naming the channel (e.g. "broker intro open", "recruiter process", "direct thread with the CTO"). `find_company` then returns `skip` and `gate_check` blocks a submit. When the intro or process closes, call it again with `on: false` and `record` a note.

### 6. Calendar
- `list_events` on the connected calendar for the next 14 days. Match interviews from `open_items`.
- Compare the connected account with `accounts.invite_calendar`. Different: say so once in the report, and list interviews as "not visible on the connected calendar".
- For booking links, list free windows during working hours over the next few working days.
- Do not create or accept events in an unattended run. If the user asks for a hold in a session and `create_event` is refused (connector read-only), report the slot and ask them to add it.

## Output

For the report: interviews (time in the user's timezone, stage, people, link), links still to book with free windows, outcomes with feedback quotes, and verified drafts only. Unverified drafts appear under Needs you as "could not confirm draft".
