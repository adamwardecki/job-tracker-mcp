# Job Tracker

A Claude Code (and Hermes Agent) plugin that runs a disciplined, low-volume job search for one person.
Every weekday it finds roles that fit your hard filters, verifies each one on the employer's own posting,
dedupes against everything you have touched, and prepares tailored applications. It submits only through
the employer's official apply flow, and only after you approve. It tracks replies and interviews and
writes one short daily report.

The design follows one principle: **fewer, better applications.**

Website: [jobtrackermcp.com](https://jobtrackermcp.com/)

Setup and usage docs: [jobtrackermcp.com/docs.html](https://jobtrackermcp.com/docs.html)

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
  Windows. The tracker uses the built-in `node:sqlite`, and Node runs the plugin's TypeScript directly.
  There are no runtime npm dependencies.
- **Recommended connectors:** Gmail and Google Calendar.
- **Recommended browser:** Claude in Chrome or the host's built-in browser.
- **Optional:** a LinkedIn MCP server (read-only use: job search and inbox).

Full setup and usage instructions: [jobtrackermcp.com/docs.html](https://jobtrackermcp.com/docs.html)

## Install

Claude Code:

```
/plugin marketplace add adamwardecki/job-tracker-mcp
/plugin install job-tracker@job-tracker-mcp
/job-tracker:setup
```

Hermes Agent:

```bash
git clone https://github.com/adamwardecki/job-tracker-mcp.git
cd job-tracker-mcp
plugin/scripts/hermes-install.sh
```

Restart Hermes and type `/job-tracker:setup`. Details:
[docs/hermes.md](docs/hermes.md).

The tracker is also in the [MCP Registry](https://registry.modelcontextprotocol.io/) as
`io.github.adamwardecki/job-tracker`, packaged as an MCPB bundle attached to each
[GitHub release](https://github.com/adamwardecki/job-tracker-mcp/releases).

## Commands

| Command | What it does |
|---|---|
| `/job-tracker:setup` | Guided setup; resumable. |
| `/job-tracker:sweep [--limit N]` | The daily run. Never submits. |
| `/job-tracker:apply [role-id]` | Interactive apply: verify, write, fill, read back, then wait for your approval. |
| `/job-tracker:approve <role-id>` | You type this on the filled form to allow one submit attempt. |
| `/job-tracker:triage <source>` | Reconcile and clean a tracker board with the delete guard. |
| `/job-tracker:prep <company>` | Interview prep from your stories. |
| `/job-tracker:status` | Pipeline summary and open items. |
| `/job-tracker:board` | Kanban board in your browser. |
| `/job-tracker:cover-letter <role-id>` | Cover letter, optionally as a one-page PDF. |
| `/job-tracker:correct` | Turn your override into a rule with a reason and example. |

## Your data

The tracker runs locally. A stdio server on `~/.job-tracker/tracker.db`. No network listener, no token.
The directory is owner-only (`0700`), database is `0600`. Nothing is sent to the plugin's author.

[Privacy policy](https://jobtrackermcp.com/privacy.html) ([source](PRIVACY.md)).

## Hooks (hard gates)

| Gate | Rule |
|---|---|
| Send | Email/LinkedIn sends blocked in every session. |
| Submit | Needs `/job-tracker:approve` and a passing `gate_check`. |
| Board delete | Needs a fresh `JOBHUNT_TRIAGE_GUARD` with `ok: true`. |
| Personal data and consent | Passport, nationality, age, DOB, gender, marital, ID fields denied; consent boxes stay unticked unless you allow them. |
| Stop | A sweep session cannot end until every role has an event and the report was rendered. |

## Development

```
npm run setup   # dev only: TypeScript, the Node types and Biome, installed into dev/
npm test        # tsc, then the Node and Python tests
```

The code is TypeScript that Node runs directly (type stripping), so there is no build step and nothing to
install at runtime.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

## Design choices

1. **Local only.** The tracker is SQLite behind a stdio server in `~/.job-tracker`.
2. **The daily run is a local scheduled task.**
3. **LinkedIn is read-only and optional.** Send and connect tools are blocked by a hook.
4. **Voice.** `write-note` uses an installed humanizer or writing-style skill when present, else its own rules.
5. **Templates ship neutral.** Your own values go in through setup.

## License

[MIT](LICENSE)
