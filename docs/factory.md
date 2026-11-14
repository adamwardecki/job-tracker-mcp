# Agent factory

The factory turns a GitHub issue labelled `agent:queued` into a reviewed pull request: agents plan, build, review
and fix, and the maintainer approves risky changes and merges. It runs from
[agent-factory](https://github.com/adamwardecki/agent-factory), pinned by commit. This repo holds only:

- `.github/factory.json`: who may queue and approve, the commands the factory runs, and the repo's risky paths.
  Change it by pull request, like any other file.
- `.github/workflows/factory-router.yml` and `factory-stage.yml`: the two callers that `agent-factory`'s CLI
  rendered. Don't edit them by hand; move them to a new release with `upgrade`.

How to use it (queueing, `/approve`, `/stop`, `/retry`, what each stage does) is in agent-factory's
[README](https://github.com/adamwardecki/agent-factory#readme). To check the install, from a clone of
agent-factory:

```bash
node --no-warnings cli/factory.ts doctor --repo adamwardecki/job-tracker-mcp
```

Things that differ here from a plain repo:

- **Required checks:** `main` requires the four `test (…)` jobs. On a factory PR they run only after the maintainer
  approves the workflow runs ("Approve workflows to run" on the PR), because `GITHUB_TOKEN` opened the PR.
- **Risky paths:** `riskyPaths` in `.github/factory.json` adds this repo's safety gates, tool contract and release
  files to the factory's built-in list. A brief or diff that touches one waits for `/approve`.

The in-repo factory this replaced (`factory/`, six workflows, a GitHub App) was removed in November 2026.
