---
description: User approval to submit the application for one role in this session. Only the user types this.
argument-hint: "<role-id>"
---

The user typed `/job-tracker:approve $ARGUMENTS`.

A prompt hook (Claude Code `UserPromptSubmit`, Hermes `pre_llm_call`) has already processed this message: it checked that the current browser page belongs to role `$ARGUMENTS`, recorded a one-use approval for that role and page (valid for up to 2 hours), and ran `gate_check`. Its result is in your context as a `[job-hunt]` note. You do not record anything yourself and there is no tool that grants approval.

1. Read the `[job-hunt]` note.
   - **gate_check fails** (for example: role not verified, `no_cold_apply`, a live application elsewhere at the company, unknown role id): the submit hook will keep denying the click. Tell the user plainly which check failed and what would fix it, quoting `problems`. Do not submit.
   - **gate_check passed**: say in one line that one submit attempt for role `$ARGUMENTS` on the current form is approved.
   - **No note at all**: hooks may not be running in this host. Say so, and do not submit.
2. If an apply flow for this role is in progress, continue it at the submit step of the `fill-form` skill: re-read the form values once more (a re-render can clear fields), re-run `find` for the submit button, click it once, then capture the confirmation text, `transition` to `applied` with the text as `evidence` (and `asked_salary` if the form had a salary field), and `add_artifact` with `kind: "confirmation"`.
3. If no apply flow is in progress for this role, say so and offer to run `/job-tracker:apply $ARGUMENTS`.

The approval covers one submit attempt for this role on the browser page and tab that were current when the user approved. A failed attempt needs a new approval. It does not cover consent boxes (`/job-tracker:allow-consent`) or personal-data fields.
