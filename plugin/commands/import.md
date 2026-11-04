---
description: One-off migration of a legacy markdown job-hunt pipeline (applied log, preferences, queue notes, profile, stories) into the tracker.
argument-hint: "[path to the legacy pipeline/ folder]"
---

Import the user's legacy pipeline into the tracker. Path: `$ARGUMENTS`

**If the tracker tools are missing** (search for them first if tools are deferred), or a hook error says `node` could not start: Node.js, which the plugin runs on, is missing or too old. Tell the user that in one sentence, offer to run `/job-tracker:setup` (it installs Node.js), and stop.

This is a one-off. Run it once, before the first sweep if possible. Tell the user that the imported data is personal and will live in the tracker database.

1. **Find the files.** If no path was given, ask for it. Expected contents of the folder:
   - `applied-log.md`: table rows `| date | company | role | source | action | status |`
   - `outreach-preferences.md`: dated rules and lessons
   - `queue/*.md`: one note per role; filename prefixes `DROPPED-`, `DONE-`, `EXPIRED-` map to statuses, unprefixed files are queued
   - `profile.md`, `reusable-answers.md`, `interview-stories.md` (or `stories.md`)
   Missing files are fine; import what exists.
2. **Call `import_legacy`.**
   - If the tracker is local and can read the folder, pass `path` only.
   - Otherwise read the files and pass their contents: `applied_log`, `preferences`, `queue` as `[{filename, content}]`, and `documents` as `{profile, stories, reusable-answers}`.
3. **Report the result**: counts imported per kind, and every unparsed row verbatim, so the user can decide what to do with each. Do not guess at unparsed rows.
4. **Check the rules.** Read all types as Reading rules says in `${CLAUDE_PLUGIN_ROOT}/templates/rules.md` (Hermes: `${HERMES_SKILL_DIR}/../templates/rules.md`) (no `types`: this is the classification review) and show the imported rules grouped by theme. Imported rules are global until classified: for each theme propose the `types` that fit and, once the user agrees, call `set_rule_types`. Ask the user to deactivate any that are stale or were superseded later in the file (a later entry that says "supersedes" or "revoked" wins). Never `deactivate_rule` without the user's yes.
5. **Check `no_cold_apply`.** Ask the user which companies have open intros, recruiter processes or direct founder conversations, and confirm they came through.
6. **Show `pipeline_summary`** (live processes, rejections, queue, counts) and ask the user to compare it with their last daily report. List any mismatch they point out; fix each with `record` (`actor: "user"`).
