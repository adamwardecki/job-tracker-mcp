# Job Hunt Plugin: Implementation Spec

Status: implemented (v0.1) · Date: 2026-09-30
Source: distilled from about five weeks of running this workflow by hand in Claude Cowork.

> This is the original design document, kept for the reasoning behind the rules. The
> [README](../README.md) describes how the plugin behaves today. Values in §6 are examples.

---

## 1. Goal

A Claude plugin that runs a disciplined job search for one person:

1. Finds new roles that fit the user's hard filters, every weekday, unattended.
2. Verifies each role against the **employer's own posting** before scoring it.
3. Dedupes against everything the user has ever touched.
4. Prepares tailored applications and submits them only through official apply flows, with the user's approval rules enforced by hooks.
5. Tracks replies, interviews and outcomes, and produces one short daily report.
6. Supports interview prep from the user's own stories.

**Design stance: fewer, better applications.** In the manual run, every interview came from a verified, tailored application. Volume sweeps mostly produced rejections and cleanup. Optimise for precision, not throughput.

## 2. Non-goals

- Auto-applying at volume, or "one-click apply" features on third-party trackers.
- Sending emails or LinkedIn messages. The plugin only creates drafts.
- Creating accounts, entering passwords, solving CAPTCHAs, or answering bot checks.
- Accepting consents or entering personal data (passport, age, marital status, gender, nationality, ID numbers) on the user's behalf.
- Deleting anything outside a scoped, verified selection.

---

## 3. Runtime model (read this first)

Constraints from Anthropic's docs as of 2026-09-30 (verify before building):

- From **6 Oct 2026**, Cowork scheduled tasks on Pro/Max **run in the cloud**. They can use connectors, skills and plugins, but cannot be tied to a local folder.
- **Browser use, local file access and local MCP servers** from a cloud session only work **through the Claude Desktop app, while it is open** on the user's machine. With the laptop closed there is no browser, no local folder and no local MCP.
- Claude Code Desktop **local routines** still exist. They run on the machine with local tools, but only while the app is open and the machine is awake. Missed runs collapse into one catch-up run.

Consequences:

| Concern | Decision |
|---|---|
| Daily run | **Local** scheduled task on the user's machine (Claude Desktop / Claude Code, or a Hermes cron job), weekdays, morning. Runs while the machine is awake and the app is open. |
| Browser | Detected at run start. Needed for logged-in sources, some employer pages and every form. When it is not connected, browser work is queued with `blocked_by: browser`. |
| State (tracker) | **Local** SQLite behind a stdio MCP server in `~/.job-tracker` (owner-only permissions). No remote mode. |
| Applying, logged-in boards, tracker triage | Interactive sessions (`/job-tracker:apply`, `/job-tracker:triage`) when the user is present and the desktop app is open. |
| User files (profile, rules, stories) | Stored in the tracker DB. |

> **Changed 2026-10-17** from the original cloud-first design: the daily run needs the browser, and the
> browser is only reachable from a local session.

**Every run starts with capability detection**: connectors reachable, browser reachable (which one), local folder reachable, tracker reachable. The run plans around what is available and records it. It never fails silently, and never reports "done" for work it could not do.

---

## 4. Architecture

```
job-hunt/
├── .claude-plugin/plugin.json
├── .mcp.json                     # tracker MCP server (local stdio)
├── commands/
│   ├── setup.md                  # /job-tracker:setup
│   ├── sweep.md                  # /job-tracker:sweep  (what the scheduled task runs)
│   ├── apply.md                  # /job-tracker:apply [role-id|url]
│   ├── triage.md                 # /job-tracker:triage <source>
│   ├── prep.md                   # /job-tracker:prep <company>
│   ├── status.md                 # /job-tracker:status
│   ├── board.md                  # /job-tracker:board  (local kanban board)
│   ├── cover-letter.md           # /job-tracker:cover-letter <role-id> [--pdf]
│   └── correct.md                # /job-tracker:correct  (turn a user override into a rule)
├── skills/
│   ├── setup/SKILL.md
│   ├── source-roles/SKILL.md     # per-source adapters
│   ├── verify-employer/SKILL.md
│   ├── score-role/SKILL.md
│   ├── write-note/SKILL.md
│   ├── fill-form/SKILL.md
│   ├── triage-tracker/SKILL.md
│   ├── inbox-and-calendar/SKILL.md
│   └── interview-prep/SKILL.md
├── agents/
│   ├── sourcer.md                # one instance per source, run in parallel
│   ├── scorer.md
│   └── auditor.md                # post-run rule check (see §11)
├── hooks/hooks.json
├── servers/tracker/              # MCP server (local stdio, SQLite)
└── templates/                    # profile.md, rules.md, stories.md, settings schema
```

Layers, top to bottom: commands and scheduled runs → agents and skills → **hooks gate** → MCP servers (tracker, Gmail, Calendar, LinkedIn, browser) → storage (tracker DB, user files, rendered output).

Only the tracker MCP writes to the tracker DB. Everything else reads through its tools.

---

## 5. Tracker MCP

### 5.1 Why a dedicated server

The manual log (`applied-log.md`) grew past 200 KB and a `grep` over it timed out. Dedupe was a text search, and status was prose. The tracker replaces this with structured, append-only state behind **narrow tools**. The model cannot write malformed rows or skip a reason, and hooks can query it.

### 5.2 Storage

- SQLite, WAL mode. Each session's server process writes under `BEGIN IMMEDIATE` and waits up to 5 s for another's lock; hooks open it read-only.
- Runtime: Python stdlib `sqlite3` or Node built-in `node:sqlite` (22.5+). **No native modules** (e.g. `better-sqlite3`).
- DB file lives outside the plugin directory, so plugin updates never touch user data.
- Deployment: local only. `.mcp.json` starts the server over stdio.
- Access: the MCP server has no network listener and no token. The optional board (`open_board`, `servers/tracker/src/board.ts`) listens on 127.0.0.1 with a per-start token and stops after 30 idle minutes. The DB holds personal data, so it is created owner-only (0700 directory, 0600 files) and setup says where it lives.

### 5.3 Schema

```sql
companies (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, aliases TEXT,        -- JSON array, e.g. ["Flex Living","The Flex","Base360"]
  domain TEXT, notes TEXT, no_cold_apply INTEGER DEFAULT 0,        -- set when an intro/recruiter process exists
  no_cold_apply_reason TEXT
);
roles (
  id INTEGER PRIMARY KEY, company_id INTEGER REFERENCES companies,
  title TEXT, url TEXT, ats TEXT,                                  -- ashby|greenhouse|lever|workable|teamtailor|personio|join|workday|other
  location_line TEXT,                                              -- verbatim from employer ATS
  location_type TEXT,                                              -- remote|hybrid|onsite|unknown
  comp_min INTEGER, comp_max INTEGER, comp_currency TEXT, comp_period TEXT, equity TEXT,
  stack TEXT, source TEXT, first_seen TEXT, posted_at TEXT,
  verified_at TEXT,                                                -- set only by verify-employer
  score REAL, score_notes TEXT
);
events (                                                           -- append-only; current status = latest row
  id INTEGER PRIMARY KEY, role_id INTEGER REFERENCES roles, ts TEXT,
  status TEXT,                                                     -- see 5.4
  actor TEXT,                                                      -- pipeline|user|employer
  reason TEXT NOT NULL, evidence TEXT                              -- verbatim quote or URL
);
artifacts (id, role_id, kind, path_or_ref, created_at)             -- cover notes, PDFs, Gmail draft ids
sources (name PRIMARY KEY, last_run, status, found, applied, last_error)
rules (id, text, reason, example, added_by, added_on, active)      -- user preferences and corrections
profile (key PRIMARY KEY, value)                                   -- JSON blobs: filters, prefs, writing, capabilities
interviews (id, role_id, starts_at, tz, stage, people, link, booked_by, notes)
```

### 5.4 Status machine

```
found → verified → scored → queued → applied → interviewing → offer
                   ↘ dropped        ↘ closed (rejected | withdrawn | role_closed)
```

`transition` rejects illegal moves. Every event requires a `reason`. Drops require `evidence` (a quote from the employer page, or the rule id).

### 5.5 Tools

| Tool | Purpose |
|---|---|
| `find_company(name)` | Fuzzy match on name, aliases and domain. Returns the company, its roles, current statuses and `no_cold_apply`. This is the dedupe check. |
| `upsert_role(fields)` | Create or update a role; creates the company if needed. |
| `record(role_id, status, reason, evidence, actor)` | Append an event (validated). |
| `transition(role_id, to, reason, evidence)` | Same as `record`, but enforces 5.4. |
| `open_items()` | Queue, pending drafts, interviews to book, items waiting on the user. |
| `get_profile()` / `save_config(section, data)` | Read and write validated config (see §6). |
| `add_rule(text, reason, example)` / `list_rules()` | Rules with provenance. |
| `source_health()` / `set_source_status(...)` | Per-source health and yield. |
| `setup_status()` | Checklist of what is configured, missing or degraded. Called at the start of every run. |
| `render_report(date)` | Returns the markdown daily report (see §9). |
| `import_legacy(markdown)` | One-off migration from `applied-log.md` (see §13). |

No raw SQL tool.

---

## 6. Configuration

Stored via `save_config`, with a JSON schema. Required sections:

```yaml
filters:                       # hard: a miss drops the role
  work_mode: [remote]          # remote | hybrid | onsite (multi)
  hybrid: {max_days_per_week: null, cities: []}
  residence_country: DE
  timezone: Europe/Berlin
  overlap_window: "UTC-3..UTC+3"        # or explicit hours
  work_authorisation: [EU]              # where no sponsorship is needed
  pay_floor: {amount: 80000, currency: EUR, period: year, basis: gross}
  pay_rule_with_equity: "floor unchanged; equity may justify 'negotiable' answer inside band"
  band_rule: "drop only if the band MAXIMUM is below floor; straddling bands are kept"
  excluded_industries: [crypto, web3, gambling, fossil_fuels, defense]
  excluded_role_shapes: [backend_only, forward_deployed, people_manager]
  culture_red_lines: [stated_overtime_expectation, overtime_screening_question]
prefs:                         # soft: affects score only
  titles: [product engineer, full stack engineer]
  seniority: [senior, staff, lead, founding]
  stage: [seed, series_a, series_b]
  stack_want: [TypeScript, React, PostgreSQL]
  stack_avoid: [Java, C#]
  domains_like: [devtools, B2B SaaS]
  contract_ok: true
  availability: "from January"
writing:
  voice_profile: null          # optional, learned from samples
  humanizer: true
  max_words_cover_note: 200
  never_volunteer_gaps: true
  signature_style: name_only   # no bare URLs in email signatures
accounts:
  job_inbox_email: personal    # the user's own inbox that recruiters write to
  invite_calendar: personal    # which calendar invites land on (!)
  chrome_autofill_risk: "work email autofills; always read back"
autonomy:
  unattended: [search, verify, score, draft_note, draft_email, record]
  needs_user: [submit, send, delete, consent, personal_data, account_login]
schedule:
  daily: {days: weekdays, time: "07:00", tz: Europe/Berlin}
  desktop_usually_on: null     # e.g. "09:00-17:00"; the daily task is scheduled inside this window
capabilities:                  # written by detection, not by the user
  connectors: {}, browser: null, local_folder: null
```

User-owned documents (also stored via the tracker or project knowledge): `profile.md` (CV distilled, **per-role stack lines**), `stories.md` (STAR stories), `reusable-answers.md`.

---

## 7. Setup flow (`/job-tracker:setup`)

A **skill** drives the conversation. MCP tools persist and validate. Use multiple-choice questions wherever possible. Every step is resumable, and `setup_status()` shows progress.

1. **CV import.** The user uploads a CV. Draft `profile.md` including **each role's stack line**, then ask the user to confirm anything inferred. (Lesson: a summary line was once read as exhaustive, and AWS was wrongly scored as a gap.)
2. **Hard filters.** Work mode; residence country; timezone and acceptable overlap; work authorisation; pay floor (amount, currency, period, contract type) and the equity rule; excluded industries; excluded role shapes. Echo them back as a one-screen summary before saving.
3. **Soft preferences.** Titles, seniority, stage, stack want/avoid, domains, culture red lines, contract openness, availability date.
4. **Writing rules.** Offer to learn the user's voice from samples. Humanizer on, word limit, no volunteered gaps. List the personal fields the plugin will never fill.
5. **Accounts.** Ask which inbox recruiters use and **which calendar invites land on**. Warn if the connected calendar is a different account.
6. **Connectors.** Search the registry and suggest Gmail, Google Calendar and LinkedIn (read-only use). Explain where personal data will live (the local tracker file, plus each connector).
7. **Browser check.** Detect Claude in Chrome and the built-in browser. If neither is found, show install steps. If found, open a test page and check which job sites are logged in (Wellfound, LinkedIn, YC Work at a Startup, trackers). Record this as a capability; it does not block setup.
8. **Sources.** Pick from a catalogue (§8.1) and record which need login.
9. **Autonomy.** Confirm the defaults in `autonomy` (conservative).
10. **Schedule.** Create the local daily task (`/job-tracker:sweep`) with the host's local scheduling (a Claude Desktop / Claude Code local scheduled task, or a Hermes cron job). Ask when the machine is usually on with Claude open and schedule inside that window. State plainly that it only runs while the machine is awake and the app is open.
11. **Calibration run.** Run `/job-tracker:sweep` limited to 5 results and show them. Each "no, because…" becomes a rule via `add_rule` with the reason and example.

Exit criterion: `setup_status()` all green, or every amber item has a recorded user decision.

---

## 8. Daily run (`/job-tracker:sweep`)

1. `setup_status()` and **capability detection**. Record what is available.
2. **Inbox and calendar** (connectors): classify recruiter mail as reply, rejection, invite, booking link, acknowledgement, or holding note.
   - **Booking link present → no draft.** Surface the link, the stage and the people.
   - Question in prose, no link → create a reply **draft**, then **read it back** with `list_drafts`/`get_draft` before reporting it.
   - Record outcomes as events. Rejections with feedback get the feedback stored verbatim.
3. **Source** in parallel (one sourcer agent per available source). Upsert roles as `found`.
4. **Dedupe** each role with `find_company` (aliases and fuzzy). Skip roles with an existing live application or `no_cold_apply`.
5. **Verify on the employer's own posting** (see §8.2) → `verified` or `dropped` with a quote.
6. **Score** against filters and prefs → `scored` or `dropped`.
7. **Prepare** the top N (default 3–8): write the cover note (§10), save the artifact, and set status `queued`. If the browser is available **and** the autonomy config allows it, the apply step may run in a later interactive session only. The unattended run never submits.
8. `render_report(today)` and deliver it (file, artifact or email draft to self, per config).
9. The auditor agent checks the run against the rules (§11).

### 8.1 Source catalogue (with observed reliability)

| Source | Mode | Notes |
|---|---|---|
| LinkedIn job search (MCP) | connector | Keyword relevance is poor; repeated recruiter-farm spam. Treat tags as leads only. Search sometimes fails; retry at most twice. |
| Employer ATS boards (Ashby/Greenhouse/Lever posting APIs) | fetch | Most reliable source of truth. |
| YC Work at a Startup | browser (logged in) / Algolia index | "US visa not required" filter works. Infinite scroll resists automation; prefer the index. |
| Wellfound | browser (logged in) | Hides roles unavailable to the user's location. One keyword pass is enough. |
| HN "Who is hiring" | fetch (Algolia API) | Monthly; check only new comments since the last run. |
| Welcome to the Jungle | browser (logged in) | Matcher ignores remote preference unless the location is set in the profile. |
| Jack & Jill | browser + email | Intro-brokering. Its salary figures and company attributions need ATS verification. Open intros set `no_cold_apply`. |
| WWR JobCopilot | browser | **Save-only.** Never enable auto-apply. See §12.3 for safe triage. |
| We Work Remotely | fetch (RSS) | Remote-only; per-category feeds. Region tags are unverified. |
| Indeed, Glassdoor, ZipRecruiter, Dice | browser | US boards. Frequent bot checks (stop, never solve); heavy duplication and staffing-agency reposts; pay shown is often the board's own estimate. |
| Built In | fetch / browser | US tech hubs and remote; postings usually link to the employer ATS. |
| USAJOBS | browser | US federal jobs; most need US citizenship. The posting is the agency's own text. |
| justjoin.it, nofluffjobs, RemoteOK, Remotive, Monster, CareerBuilder, SimplyHired | — | Retire or disable by default: low yield, blocked, or duplicate listings. |

Source health is tracked per run. A source that fails N consecutive runs is marked `degraded` and shown in the report once, not every day.

### 8.2 Verify-employer rules

- **Aggregator tags are leads, never verdicts.** This covers location, industry, seniority and salary. Before writing any drop reason, load the employer's own page and **quote it**. (Wrong drops happened twice on stale tags; wrong approvals happened four times on "Remote" tags that the ATS contradicted.)
- Read the ATS **location line and location type** during scoring, not at the form.
- An employer whose every opening is gated to countries the user can't work in is a drop, not a question for the user.
- Employer sources that disagree on a hard filter (e.g. "remote" on HN, "Hybrid" on Ashby): flag the role for the user with both quotes. Never apply on the optimistic reading.
- Offshore staffing and EOR tells: country suffix in the title `(PK)`, `(IN)`, `(PHL)`; req codes like `[AS324]`; near-duplicate posts differing only by country; INR/PHP bands.
- Parent vs venture: judge the business line the role sits in, not an unrelated sibling venture.
- Forms are evidence too: screening questions such as "work onsite 3 days a week?" or "right to work in Romania?" override the posting's "Remote".

### 8.3 Scoring rules

- Pay: drop only if the band's **maximum** is below the floor. Convert hourly/monthly using the top of the band. Explicitly-below-floor salary with equity attached is still a drop.
- A required bullet with nothing honest to point at on the CV is a scoring signal (usually a drop). Don't write around it.
- Grind culture: overtime as a screening question, or hustle as the centre of the values page, is a drop. Strong-but-generic ambition copy is surfaced with the quote.
- Product/domain fit matters, not only stack.
- A role category the user has excluded (e.g. forward-deployed) drops, even with a perfect stack. Customer calls as part of a product role are fine.

---

## 9. Daily report

Short. Lead with the outcome, no recap. Sections, omitted when empty:

1. **Needs you** (numbered, one line each, with the single blocking question).
2. Interviews: upcoming, plus links still to book.
3. Applied today.
4. Replies (outcomes, feedback quotes).
5. Dropped: one line per group, with reasons.
6. Source health (only changes).

Every claim of a draft, submission or booking in the report must be backed by a read-back (draft id verified, confirmation text captured).

---

## 10. Writing (`write-note`, `/job-tracker:cover-letter`)

- Motivation first: why *this* company or role, connected to one or two concrete experiences, then location and availability. 150–200 words. Never echo the job description or restate the CV.
- **Never volunteer gaps** in anything sent in the user's name. Direct questions get honest answers. Multi-select skill boxes: tick only what the CV supports. Gaps go in the role's internal notes.
- **Never overstate.** Every claim must trace to `profile.md` or `stories.md`.
- Run the humanizer pass on all outbound prose: no em/en dashes, no "not X but Y", no fake-candid openers, no forced triads, plain verbs.
- Respect employer AI policies. If the form says "do not use AI", leave those fields for the user and put raw material in the notes.
- Check `maxLength` on every free-text field **before drafting**. Long-form goes in the cover-letter field when one exists.
- `/job-tracker:cover-letter --pdf`: one A4 page, standard letter layout (name and contact header, rule, recipient and date, role title line without "Re:", salutation, body, "Kind regards"). Render, then verify visually before handing over.

---

## 11. Hooks (hard gates)

| Hook | Rule |
|---|---|
| PreToolUse: any email send / LinkedIn message / connection request | **Block.** Drafts only. |
| PreToolUse: browser click on an element whose text matches submit/apply/send | Require `find_company` clean + `roles.verified_at` set + an approval token for this role in the current session. |
| PreToolUse: tracker/board delete actions | Require the target column resolved by header text and the protected columns' counts captured (see §12.3). |
| PreToolUse: browser tools on the local board (`127.0.0.1`/`localhost` with the board's token or port), any session | Block navigating to it and acting on its page; reading is allowed. Board moves are recorded as the user's. |
| PreToolUse: form_input into fields labelled passport/nationality/age/marital/gender/ID | Block; surface to the user. |
| PreToolUse: consent checkboxes/radios (recording, marketing, talent pool) | Default to the privacy-preserving option; never tick "yes" without the user. |
| Stop | Refuse to finish a `/job-tracker:sweep` without `record` events for every touched role and a rendered report. |

The **auditor agent** runs after each sweep and checks: no excluded industry touched, no send tools called, every drop has evidence, every "applied" has captured confirmation text, and no outbound prose has dashes or gap statements.

---

## 12. Browser automation (`fill-form`, `triage-tracker`)

### 12.1 Form filling

No single recipe works everywhere. The only reliable step is **reading values back out of the DOM and switching method when they're empty**.

- Ashby: text inputs often need real keyboard entry (click, select all, delete, type). `form_input` can set the DOM without React state and fail validation.
- Railway-style plain forms: `form_input` works; keyboard entry sometimes does not.
- Greenhouse: plain inputs accept a native setter plus input/change events. Country and location **comboboxes need keyboard entry and an explicit click on the dropdown option**. Their hidden input may read empty even when set correctly, so confirm visually.
- Hidden `input[type=file]`: expose it (display it, give it an aria-label), re-read the accessibility tree to get a ref, then call `file_upload`. Pass a path the session is allowed to read (a staged copy may be required).
- `find` refs go stale quickly. Re-run `find` immediately before use. Never click stale coordinates after a validation error or re-render.
- Always read back the email field (browser autofill may insert a work address).
- Decline cookie banners before filling.
- Invisible reCAPTCHA/hCaptcha that resolves by itself is fine. Any visible challenge: stop and hand off.
- Capture the confirmation page text as evidence before recording `applied`.

### 12.2 Account-gated flows

join.com, Workday, Dex, and anything behind sign-in: prepare everything, leave the tab open, and queue the item for the user.

### 12.3 Tracker triage (JobCopilot-style boards)

- Resolve the column **by its header text** and operate only on its descendants. Never use an index. (On JobCopilot, `.at-card` is the class of all five column containers, and Saved and Applied cards have identical markup. This caused a real deletion from Applied.)
- Before deleting: diff the selection against the intended list (must be an exact match), and assert the Applied column's checked count is 0.
- Re-measure header controls after any selection. Selecting cards shifts the header layout, and clicks aimed at the checkbox have landed on the trash icon.
- Click buttons via their button element, not the inner svg.
- Confirm dialogs are identical across columns, so they are not a safeguard.
- Verify protected column counts are unchanged after each round.
- Virtualised lists may only advance on real scroll events. Delete in rounds as you go rather than loading everything first.

---

## 13. Migration from the manual pipeline

- `import_legacy`: parse a legacy `pipeline/applied-log.md` table (`| date | company | role | source | action | status |`) into companies, roles and events. Multi-company "dropped" rows split into one event per company where names are bolded. Keep the original row as `evidence`.
- Import `outreach-preferences.md` entries as `rules` with `added_on` and reason.
- Import `profile.md`, `reusable-answers.md` and `interview-stories.md` as user documents.
- Import `queue/*.md` as `queued` roles with the note as an artifact. The `DROPPED-`, `DONE-` and `EXPIRED-` prefixes map to statuses.
- Seed `no_cold_apply` for companies with open intros or recruiter processes.

---

## 14. Acceptance criteria

1. Fresh install → `/job-tracker:setup` completes with only connectors (no browser) and schedules a daily run.
2. A daily run with no browser connected completes, and the report says which capabilities were missing and what was queued because of it.
3. A role already applied to under an alias ("Flex Living" vs "The Flex") is deduped.
4. A role tagged "Remote" on LinkedIn whose ATS says "Hybrid (8 days/month)" is dropped with the ATS quote as evidence.
5. A role with band €42–78K against a €80K floor is dropped; €79–97K is kept and flagged as straddling.
6. An attempt to call any send tool is blocked by a hook.
7. A submit click on an unverified role is blocked.
8. A triage run on a board with Saved and Applied columns never changes the Applied count; the test fixture includes identical card markup across columns.
9. A reply draft is only reported after it has been read back from Gmail.
10. A cover note with an em dash or a gap sentence fails the auditor.
11. Legacy import reproduces the current pipeline summary (live processes, rejections, queue) from `applied-log.md`.

---

## 15. Open questions

1. **Tracker hosting:** resolved 2026-10-17: local only (see the §3 note and the README decisions).
2. Whether **cloud scheduled tasks can reach the browser**: resolved 2026-10-17, moot. The daily run is a local scheduled task.
3. LinkedIn: the only access is via an MCP whose job search is flaky and whose ToS limits automation. Keep it read-only and optional?
4. Voice profile: integrate with an existing writing-style skill if installed, or ship one?
5. Multi-user distribution: resolved. Templates ship neutral; §6 shows example values.
