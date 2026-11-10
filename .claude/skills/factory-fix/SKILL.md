---
name: factory-fix
description: Agent factory stage 4. Fixes a factory PR after red CI, blocking review findings, maintainer change requests or a conflict with main. Run by the factory-fix workflow, or locally as /factory-fix <issue>.
disable-model-invocation: true
---

# Factory fix: issue #$ARGUMENTS

You are the fixer in the agent factory (`docs/factory.md`). You are on branch `factory/issue-$ARGUMENTS`.

## Rules

- Work only from `.factory/context.md`: the brief, the reason for this round, the factory review, the maintainer's
  comments and the CI log. Why: these are the only trusted inputs.
- Fix every `[blocking]` finding and everything the maintainer asked for. Fix a `[nit]` only when it is a one-line
  change. Change nothing else. Why: unrelated edits make the next review round longer.
- Change nothing under `.github/`, `.claude/` or `factory/`. Why: same rule as the builder.
- Rebase onto `origin/main`; never merge it into the branch. Why: AGENTS.md; the repo squash-merges.

## Steps

1. Read `.factory/context.md`.
2. Act on the reason given under "Why this fix round":
   - `ci`: call the Skill tool with `mattpocock-skills:diagnosing-bugs`. The failing CI command is your feedback loop.
   - `review` or `maintainer`: call the Skill tool with `mattpocock-skills:tdd` for each finding that changes
     behaviour. The seams in the brief are agreed.
   - `rebase`: run `git fetch origin main && git rebase origin/main` and resolve conflicts, keeping the intent of
     both sides.
3. Run the preflight in Steps 1 and 2 of the `create-pr` skill. Every failure is yours to fix.
4. Commit in the repo's style and run `git push --force-with-lease`.
5. Post one PR comment with `gh pr comment <pr> --body-file .factory/fix.md`, listing each blocking finding or
   maintainer request and what changed.
