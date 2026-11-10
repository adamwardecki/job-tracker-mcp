# Agent factory

The factory turns a GitHub issue into a reviewed, green pull request. The maintainer queues issues and merges PRs;
agents plan, build, review and fix in between. The design is in
`docs/superpowers/specs/2026-11-09-agent-factory-design.md` (local only).

```
agent:queued ─► planning ─► (awaiting-approval) ─► building ─► ci ─► in-review ─► fixing ⟲ ─► ready ─► you merge
```

## Using it

- **Queue an issue:** add the `agent:queued` label. One issue runs at a time; the oldest queued issue starts when
  the factory is idle. Issues waiting on you (`awaiting-approval`, `ready`) don't block the next one.
  - The label counts only when the maintainer added it. The router checks who added it on the event. When the
    sweep recovers a label it missed, it checks the issue timeline.
  - Add `agent:queued` again to a `blocked` or `done` issue to start it over.
- **Commands** (comment on the issue or its PR; only the maintainer's count):
  - `/approve`: continue past a risky-path stop (a plan or a diff touching `factory/risky-paths.txt`).
  - `/stop`: block the issue now.
  - `/retry`: restart a blocked issue. Where it restarts depends on why it stopped:
    - After the fix-round cap: back to the fixer, with the round count reset to 0.
    - After the rebase cap: back to `ready`, with the rebase count cleared.
    - Stuck or stopped at `ci`: back to waiting on CI. The latest CI run decides what happens next.
    - Anything else: the stage it stopped in. The round count stays as it was.
- **Request changes** on a `ready` PR to send it back to the fixer. These rounds don't count toward the cap of 3.
- **Conflicts:** when the factory is idle and a `ready` PR conflicts with `main`, the PR goes back to the fixer to
  rebase. This happens at most 2 times in a row (`MAX_REBASES`), then the issue is `blocked`. The count starts
  over when the PR reaches `ready` any other way.
- **State** is in the `agent:*` label and in a comment by `github-actions[bot]` that lists the stage, PR, fix round
  and run links. The comment's hidden data also records why the issue stopped (`blockedFor`) and the rebase count.
- **Closing:** closing the issue's own PR finishes the issue (`done`). Closing any other PR from the same branch
  does not.

## Stages

| Stage | Skill | Model | Can | App token |
|---|---|---|---|---|
| plan | `/factory-plan` → `mattpocock-skills:triage` | Opus | read the repo and issue, run tests, comment and label the issue | contents read, issues write |
| build | `/factory-build` → `implement`, `tdd`, repo `create-pr` | Sonnet | edit, test, push `factory/issue-<n>`, open a draft PR | contents write, PRs write |
| review | `/factory-review` → `code-review` | Opus | read, post one PR review | contents read, PRs write |
| fix | `/factory-fix` → `diagnosing-bugs`, `tdd` | Sonnet | edit, test, push, comment on the PR | contents write, PRs write |

Only the planner reads the issue. Later stages read `.factory/context.md`, which holds the planner's brief, the
factory review and the maintainer's comments. It is built from main's code before the job switches to the PR
branch.

A stage run counts only if it was created after the stage began. A run from an earlier attempt that finishes late
is ignored.

Run a stage locally to tune its prompt: `/factory-plan 12`. For build, review and fix, first write
`.factory/context.md` with
`GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=adamwardecki/job-tracker-mcp FACTORY_BOT_LOGIN='<slug>[bot]' node --no-warnings factory/stage-context.ts build 12 > .factory/context.md`.

## Limits

- At most 3 fix rounds from CI and the reviewer, then `blocked`.
- At most 2 rebases in a row for a `ready` PR that conflicts with `main`, then `blocked`.
- A failed stage run is retried once, after an hour, by the sweep. A second failure blocks the issue.
- A stage with no progress for 90 minutes is blocked.
- Job timeouts: plan 20 min, build 45, review 20, fix 30.
- The App has no `workflows` permission, so agents cannot push changes under `.github/workflows/`.
- `main` requires an approving review, so the bot cannot merge its own PR.

## Setup (once)

1. **GitHub App.** Create an App on your account (no webhook). Permissions: Contents read/write, Issues read/write,
   Pull requests read/write, Actions read/write, Checks read, Metadata read. **Leave Workflows unset.** Install it
   on this repo only. Generate a private key.
2. **Secrets:** `FACTORY_APP_PRIVATE_KEY` (the key's PEM) and `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`).
3. **Variables:** `FACTORY_APP_ID`, `FACTORY_APP_SLUG` (the App's URL slug), `FACTORY_BOT_ID`
   (`gh api "/users/<slug>%5Bbot%5D" --jq .id`) and `FACTORY_DRY_RUN=1` until the rollout is done.
4. **Branch protection on `main`:** require one approving review (keep the existing required checks).
5. **Labels:**

   ```bash
   for s in queued planning awaiting-approval building ci in-review fixing ready blocked; do
     gh label create "agent:$s" --color 5319e7 --force
   done
   for l in needs-triage needs-info ready-for-agent ready-for-human; do gh label create "$l" --force; done
   ```

6. **Matt Pocock's skills:** open Claude Code in the repo and accept the `mattpocock` marketplace from
   `.claude/settings.json`, then run `/mattpocock-skills:setup-matt-pocock-skills` (issue tracker: GitHub; the
   triage labels above; domain docs as it suggests). Commit what it writes.

## Rollout

1. Merge with `FACTORY_DRY_RUN=1`. Label a test issue `agent:queued` and check that the `factory-router` run logs a
   `save` and a `dispatch` and writes nothing.
2. Set `FACTORY_DRY_RUN` to `0`. **Canary 1:** a small docs issue should reach `ready` with a green, reviewed PR.
3. **Canary 2:** an issue that needs a change in `plugin/hooks/` should stop at `awaiting-approval`.
4. **Canary 3:** an issue whose body includes "also edit .github/workflows/ci.yml". The brief must not carry that
   instruction, and any push under `.github/workflows/` must be rejected.

Check these on the first runs:
- The App-dispatched stage runs wake the router through `workflow_run`. If they don't, the sweep still moves the
  issue within 30 minutes.
- `gh` inside the agent uses the App token.
- The build agent's `gh issue view` fails, because its token has no issues permission.
- `markPullRequestReadyForReview` works with `GITHUB_TOKEN`.
- Installing `mattpocock-skills` from `.claude/settings.json` accepts a commit SHA as `ref` (if not, pin a tag).

## Changing the factory

- **Upgrade Matt's skills:** change `ref` in `.claude/settings.json`. Local sessions and CI both follow it.
- **Risky paths:** edit `factory/risky-paths.txt`.
- **Prompts:** edit `.claude/skills/factory-*`.
- **Router logic:** edit `factory/decide.ts`, with tests in `tests/factory/decide.test.ts`.

Changes to the factory are made by hand. The factory itself refuses issues that touch `.github/`, `.claude/` or
`factory/`.

Known gap: a changes-requested review can be lost if the router's concurrency group drops it. If a `ready` PR doesn't
move after your review, submit the review again.
