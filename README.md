# Job Tracker

A Claude Code (and Hermes Agent) plugin that runs a disciplined, low-volume job search for one person.
Every weekday it finds roles that fit your hard filters, verifies each one on the employer's own posting,
dedupes against everything you have touched, and prepares tailored applications. It submits only through
the employer's official apply flow, and only after you approve. It tracks replies and interviews and
writes one short daily report.

The design follows one principle: **fewer, better applications.**

Website: [jobtrackermcp.com](https://jobtrackermcp.com/)

> **Status: early (v0.1).** It grew out of one person's real job search and is used daily by that one
> person. Expect rough edges, and expect the source adapters to break when job sites change. Issues and
> pull requests are welcome.

## What it will never do

- Send email or LinkedIn messages. It writes drafts only, and a hook blocks every send tool.
- Submit an application without your `/job-tracker:approve <role_id>` in the same session.
- Create accounts, enter passwords, solve visible CAPTCHAs, tick consent boxes, or fill personal-data
  fields (passport, nationality, age, gender, marital status, ID numbers).
- Auto-apply at volume.

## Requirements

- **Claude Code 2.1.295 or newer** (the Desktop app or the CLI), or **Hermes Agent**.
- **Node.js 22.18 or newer.** If it is missing, `/job-tracker:setup` offers to install it on macOS and
  Windows. On macOS it downloads the official installer from nodejs.org and checks its checksum and
  signature; on Windows it installs the Node.js LTS with winget, the package manager built into Windows.
  The tracker uses the built-in `node:sqlite`, and Node runs the plugin's TypeScript directly. There are
  no runtime npm dependencies.
- **Recommended connectors:** Gmail and Google Calendar, for recruiter replies, interview invites and
  reply drafts.
- **Recommended browser:** Claude in Chrome or the host's built-in browser. You need one for logged-in
  job boards, some employer pages and every application form. Without a browser the daily run still
  works and queues browser work for later.
- **Optional:** a LinkedIn MCP server (read-only use: job search and inbox).

**Usage.** A sweep runs several subagents (one per source, one per role it scores), so a daily run uses
a noticeable share of your Claude plan or API budget. Start with `/job-tracker:sweep --limit 5` to see what
a run costs you.

## Install

Claude Code:

```
/plugin marketplace add adamwardecki/job-tracker-mcp
/plugin install job-tracker@job-tracker-mcp
/job-tracker:setup
```

Added the marketplace back when it was called `job-hunt-mcp`? Run `/plugin marketplace remove job-hunt-mcp`,
then the first two commands above, so updates keep coming. Your tracker data in `~/.job-tracker` stays.

Setup walks through CV import, hard filters, preferences, writing rules, accounts (including which
calendar your invites actually land on), connectors, browser check, sources, autonomy and the daily
schedule, then runs a 5-result calibration sweep. Every "no, because..." becomes a rule. You can stop at
any point and run `/job-tracker:setup` again to resume.

Already tracking applications in a markdown table? `/job-tracker:import <folder>` brings in an
`applied-log.md` (`| date | company | role | source | action | status |`), a preferences file, queue
notes and your profile and stories. See [`commands/import.md`](plugin/commands/import.md) for the expected files.

### Hermes Agent

The same checkout is also a native Hermes plugin (in `plugin/`):

```bash
git clone https://github.com/adamwardecki/job-tracker-mcp.git
cd job-tracker-mcp
plugin/scripts/hermes-install.sh
```

Restart Hermes and type `/job-tracker:setup`. Details and the differences from Claude Code are in
[`docs/hermes.md`](docs/hermes.md).

### DeepSeek Harness (experimental)

From the same checkout:

```bash
node --no-warnings plugin/scripts/dsh-install.ts
```

Restart dsh and type `/job-tracker-setup` (dsh skill names use a hyphen, not a colon). Details and the
differences from Claude Code are in [`docs/dsh.md`](docs/dsh.md).

### Just the tracker MCP server

The tracker is also listed in the [MCP Registry](https://registry.modelcontextprotocol.io/) as
`io.github.adamwardecki/job-tracker`, packaged as an MCPB bundle attached to each
[GitHub release](https://github.com/adamwardecki/job-tracker-mcp/releases). That gives any MCP client the
database and its tools ([`docs/tracker-api.md`](docs/tracker-api.md)) without the skills or the safety
hooks, so use the plugin when you want the daily sweep. It needs Node 22.18 or newer on your PATH.

## What a day looks like

The scheduled sweep ends with a report like this one (the format is real, rendered by the tracker's
`render_report`; the companies are made up):

```markdown
# Daily report · 2026-10-18

**46 roles checked. 2 worth a look.**

## Needs you

1. **Halyard**, Senior Platform Engineer (role 1): Cover note saved. Apply with /job-tracker:apply?
2. **Pinecrest Health**, Staff Engineer (role 2): The posting asks for 2 days a month in Berlin. OK?

## Interviews

- 2026-10-20 14:00 (Europe/Berlin): **Juniper**, technical screen with Head of Engineering

## Applied

- **Ostra**, Backend Engineer, Payments. Confirmation: "Thanks for applying to Ostra! We will be in touch within two weeks."

## Dropped

- location: Northwind (ATS says hybrid in Austin)
- pay: Ledgerly (Band €55–72k is below the floor)
- industry: Blockwise (Crypto exchange)

## Sources

- wellfound: now degraded (Login expired)
```

You answer the "Needs you" items, run `/job-tracker:apply` for the roles you want, and approve each submit.

## Commands

| Command | What it does |
|---|---|
| `/job-tracker:setup` | Guided setup; resumable. |
| `/job-tracker:sweep [--limit N]` | The daily run (what the scheduled task runs). Inbox, sourcing, verify, score, prepare, report, audit. Never submits. |
| `/job-tracker:apply [role-id\|company\|url]` | Interactive apply: verify, write, fill, read back, then wait for your approval. |
| `/job-tracker:approve <role-id>` | **You** type this on the filled form to allow one submit attempt for that role and page (up to 2 hours). |
| `/job-tracker:allow-consent <role-id>` | **You** type this on the form to allow ticking consent boxes for that role and page. |
| `/job-tracker:triage <source>` | Reconcile and clean a tracker board (JobCopilot-style) with the delete guard. |
| `/job-tracker:prep <company>` | Interview prep from your stories. |
| `/job-tracker:status` | Pipeline summary and open items. |
| `/job-tracker:board` | Kanban board in your browser. Drag a card to any lane to move a role, back or forward; your word is the evidence. |
| `/job-tracker:cover-letter <role-id> [--pdf]` | Cover letter, optionally as a one-page PDF. |
| `/job-tracker:correct` | Turn your override into a rule with a reason and example. |
| `/job-tracker:import [path]` | One-off import of an existing markdown log. |

## How it fits together

```
commands, scheduled task
  └─ skills (setup, source-roles, verify-employer, score-role, write-note, fill-form,
     triage-tracker, inbox-and-calendar, interview-prep) and agents (sourcer, scorer, auditor)
       └─ hooks: hard gates on every MCP call, user prompt and stop
            └─ MCP: tracker (this repo), Gmail, Calendar, LinkedIn, browser
                 └─ storage: tracker DB in ~/.job-tracker (never inside the plugin directory)
```

- **Tracker** (`plugin/servers/tracker/`): the only writer to the database. Narrow tools, no raw SQL. An
  append-only event log with a state machine (`found → verified → scored → queued → applied →
  interviewing → offer`, plus `dropped` and `closed`). Drops need an employer quote, `verified` needs
  the ATS URL and location line, `applied` needs the confirmation text (unless you mark it yourself on the board, where drops need no quote either). Tool reference:
  [`docs/tracker-api.md`](docs/tracker-api.md).
- **Hooks** (`plugin/hooks/`): see below.
- **Skills, commands, agents, templates**: the operating rules, including the incidents that shaped them.
  The original design document, with the reasoning behind each rule, is [`docs/SPEC.md`](docs/SPEC.md).

## Your data

The tracker runs locally, always. `.mcp.json` starts a stdio server on `~/.job-tracker/tracker.db`. There is
no network listener and no token. The board (`/job-tracker:board`) is the one exception,
and only when you start it: it listens on `127.0.0.1` only, with a new token in each link, and stops
after 30 idle minutes. The directory is created owner-only (`0700`) and the database and
session files are `0600`, because they hold your CV summary, pay floor and application history.
Tightening is best effort: on a filesystem that cannot chmod, the tracker logs a warning and still starts.

Local storage does not mean nothing leaves your machine. Like any Claude Code or Hermes session, what
the model reads (your profile, postings, emails it classifies) goes to your model provider, and each
connector you add has its own data policy.

### What leaves your machine

The plugin declares one connector, the local tracker. Its skills also use the connectors, browser and web
tools you give the host, and send data to:

| Where | What is sent | When |
|---|---|---|
| Employer application platforms (Ashby, Greenhouse, Lever, Workable, Typeform, LinkedIn Easy Apply, careers-page forms) | Your name, contact details, CV, cover note and form answers | Only on submit, after you type `/job-tracker:approve` |
| Gmail | Reply drafts in your mailbox (never sent); recruiter mail is read | Inbox step of a sweep, or when you ask |
| Google Calendar | Nothing written in unattended runs; interview events are read | Inbox step of a sweep |
| LinkedIn MCP (optional) | Job-search keywords; your inbox is read. Sending is blocked | Sourcing and inbox steps |
| Job boards and trackers you are logged into (Wellfound, YC Work at a Startup, Welcome to the Jungle, Jack & Jill, JobCopilot, Glassdoor, Indeed, ZipRecruiter, Dice, Built In, USAJOBS) | Search queries, and saves, deletes or profile edits on your account that you asked for | Sourcing, `/job-tracker:triage` |
| Public job APIs and feeds (Ashby, Greenhouse and Lever posting APIs, Hacker News via Algolia, We Work Remotely RSS) | A company board name or search term | Sourcing |
| Employer careers pages | A request for the posting URL | Verifying a role |
| Web search and the sites it finds | Company and interviewer names | `/job-tracker:prep` |
| An exchange-rate source (e.g. the ECB reference rate) | A currency pair | Scoring a role paid in another currency |
| nodejs.org | A download request, no personal data | Setup, only if Node.js is missing and you agree |

Nothing is sent to the plugin's author: there is no telemetry, analytics or crash reporting.

[Privacy policy](https://jobtrackermcp.com/privacy.html) ([source](PRIVACY.md)): what is stored, what
leaves your machine and how to delete it.

The daily sweep is a **local** scheduled task (Claude Desktop or Claude Code on your machine, or a
Hermes cron job). It needs the browser for logged-in boards, employer pages and forms, and the browser is
only reachable from a local session, so cloud scheduled tasks are not supported. The task runs only while
the machine is awake and the app is open.

## Hooks (hard gates)

| Gate | Rule |
|---|---|
| Send | Any Gmail/email send, reply or forward, and any LinkedIn message or connection request, is denied in every session. Browser clicks on "Send" are denied in job-hunt sessions. |
| Drafts | Gmail `create_draft`/`update_draft` bodies are linted; em/en dashes, "not X but Y", fake-candid openers and volunteered gaps are denied. |
| Submit | A click on a submit/apply element (resolved from the page's accessibility tree) or a scripted submit needs your `/job-tracker:approve` on that role's current form and a passing `gate_check` (verified, not `no_cold_apply`, no live application at the company). Approval is consumed by one submit attempt. No identifiable page or reachable tracker means no submit. |
| Board delete | Needs a fresh `JOBHUNT_TRIAGE_GUARD` with `ok: true` and nothing but the delete control and its confirm button clicked since. |
| Your board | Browser tools may not open the `/job-tracker:board` page or click, type, drag or run scripts on it, in any session. Moves there are recorded as yours. Reading the page is allowed. |
| Personal data and consent | `form_input` into passport, nationality, age, DOB, gender, marital, ID and similar fields is denied; consent boxes stay unticked unless you allow them. |
| Read-back | `verify_artifact` is denied unless a real `get_draft`/`list_drafts` result in the session contains the draft id. |
| Stop | A `/job-tracker:sweep` session cannot end until every role it touched has an event and the report was rendered. |

Browser gates apply only in sessions that used a job-hunt command or the tracker; send blocking and the
board gate apply everywhere.

**Known limits.** Gates see tool calls, not the screen. A click by raw coordinates has no element label,
so the submit gate cannot classify it; the skills require ref-based clicks for submits and the auditor
checks every applied role for captured confirmation text. Pressing Enter in a field is not gated. The board gate knows the board by its link and port, so desktop
computer use, which sees only the screen, is not stopped from clicking on it.
Hooks require a host that runs plugin hooks (Claude Code, Claude Desktop, Hermes, DeepSeek Harness); if approval notes
never appear, the `approve` command tells the model not to submit.
If Node.js is missing, or the gate cannot start or times out, mail, LinkedIn and browser tools are blocked
(`onFailure: "block"`); other MCP tools still run, and the prompt hook stays fail open so you can still ask
for help.

## Use it responsibly

- **You are the applicant.** Everything submitted goes out in your name. Read what it prepared before
  you type `/job-tracker:approve`.
- **Site terms.** Some job boards (LinkedIn in particular) restrict automated access in their terms of
  service. The plugin keeps LinkedIn read-only and low-volume, but whether to connect a source is your
  call and your account.
- **Employer AI policies.** If a form says not to use AI, the writing skill leaves those fields for you.
- **Models make mistakes.** Verification quotes the employer's own page so you can check every drop and
  every match, and `/job-tracker:correct` turns each mistake into a rule.

## Development

```
npm run setup   # dev only: TypeScript, the Node types and Biome, installed into dev/
npm test        # tsc, then the Node and Python tests
```

The code is TypeScript that Node runs directly (type stripping), so there is no build step and nothing to
install at runtime. `npm run typecheck` runs `tsc` on its own; `npm run test:node` skips it.

Node tests cover tracker logic, migrations and locking, the MCP protocol, every hook gate, the triage
guard run against a synthetic board in headless Chrome (skipped when Chrome is not installed), the hook
config and matcher partition, the Node.js installer scripts, the runtime instructions in setup and the
commands, the Hermes and DeepSeek Harness host adapters and installer, the `tools/list` schemas, and the shared helpers. Python tests cover
the native Hermes plugin wiring, including fail-closed rules and the Windows Node path.

<details>
<summary>Spec acceptance criteria and the tests that cover them</summary>

| Acceptance criterion ([spec §14](docs/SPEC.md#14-acceptance-criteria)) | Covered by |
|---|---|
| 1. Setup completes with connectors only | `setup_status` test: no browser is amber with a recordable decision |
| 2. Report names missing capabilities and what was queued | report test |
| 3. Alias dedupe ("Flex Living" vs "The Flex") | alias, fuzzy and ATS-slug tests |
| 4. "Remote" tag vs ATS "Hybrid (8 days/month)" dropped with the quote | state-machine test |
| 5. €42–78K dropped, €79–97K kept and flagged | `check_pay` test |
| 6. Send tools blocked | hook test |
| 7. Submit on an unverified role blocked | hook test |
| 8. Triage never changes Applied; identical markup across columns | guard tests (Chrome) and delete-gate tests |
| 9. Drafts reported only after read-back | tracker and hook tests |
| 10. Em dash or gap sentence fails the auditor | lint and audit tests |
| 11. Legacy import reproduces the pipeline summary | fixture test |

</details>

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

## Design choices

1. **Local only.** The tracker is SQLite behind a stdio server in `~/.job-tracker`. A remote mode was built
   and removed: the daily run needs a local browser anyway.
2. **The daily run is a local scheduled task.** Every run still detects capabilities and queues browser
   work with `blocked_by: browser` when no browser is connected.
3. **LinkedIn is read-only and optional.** Send and connect tools are blocked by a hook.
4. **Voice.** `write-note` uses an installed humanizer or writing-style skill when present, else its own
   rules.
5. **Templates ship neutral.** Your own values go in through setup.

## License

[MIT](LICENSE)
