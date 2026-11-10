---
description: Apply flow for one role. Uses the saved auto_apply preference; otherwise waits for the user’s /job-tracker:approve <role-id>.
argument-hint: "[role-id | company | job URL]  (omit to pick from the queue)"
---

Apply to one role using the saved application preference. Argument: `$ARGUMENTS`

**If the tracker tools are missing** (search for them first if tools are deferred), or a hook error says `node` could not start: Node.js, which the plugin runs on, is missing or too old. Tell the user that in one sentence, offer to run `/job-tracker:setup` (it installs Node.js), and stop.

## Hard rules

- **Commands the user types carry the real role id.** Write them filled in, next to the company and title, e.g. "Acme, Senior Engineer: `/job-tracker:apply 42`". Never show `<id>` or `<role_id>` placeholders: the user does not know the ids.

- **Read the saved choice; never infer it.** Call `get_profile` and use `autonomy.auto_apply === true` for automatic submission. Missing or false means review first: before any submit click the user must type `/job-tracker:approve <role_id>` themselves. Never type that command, invent approval, or enable auto-apply to get past a denial. A hook checks the saved preference or the user's approval and runs the eligibility checks. Why: automatic submission is a durable user choice, not an agent decision.
- If a hook denies a click, report the denial and its reason. Do not work around it: no clicking by coordinates, no JavaScript `.click()`, `form.submit()`, `requestSubmit()` or dispatched events, no pressing Enter in a field to submit.
- Never create accounts, enter passwords, solve visible CAPTCHAs, or fill personal-data fields (passport, nationality, age, date of birth, marital status, gender, ID numbers). Hand those to the user.
- Consent boxes (recording, marketing, talent pool, data sharing) stay on the privacy-preserving option unless the user types `/job-tracker:allow-consent <role_id>`.

## Procedure

1. Call `get_profile` to read `autonomy.auto_apply`, then `start_run` with `kind: "apply"` and the detected capabilities. A browser is required for form filling; without one, prepare everything (note, answers) and tell the user which link to open. Rules: load `forms`, `scoring` and `writing` (Reading rules: `${CLAUDE_PLUGIN_ROOT}/templates/rules.md`; Hermes: `${HERMES_SKILL_DIR}/../templates/rules.md`). Do it before any form work.
2. **Resolve the role.**
   - No argument: call `open_items`, list the queued roles (company, title, score, one line), and ask which one with the host's question tool. Show company and title in the options, not ids.
   - A company name: call `open_items` and match it against the queued roles' companies. One match: use it. Several: ask which. None: call `find_company` and say what the tracker has on it.
   - A number: treat it as the role id.
   - A URL: call `find_company` with the `url` and the employer's name. One role in `exact_role_ids`: that is the role; continue with its id. A `skip` verdict there only says the posting is tracked, and step 3 decides whether it can be applied to. Several ids: stop, name them, and say they need checking (`get_role`, then `link_duplicate_role` if they are one posting) first. No exact match: if the verdict is `skip` (live application or `no_cold_apply`), stop and say why; otherwise `upsert_role` with the `url` and `source: "user"`, and if it returns `possible_role_ids`, check them as in Identity in `source-roles` before going on.
3. **Check the gate before any work.** Call `gate_check` with the role id. If it lists any problem other than the role not being verified yet, stop and tell the user its problems in plain words. A `previous_application` means this posting was applied to before, under this or a linked id: it is never applied to again, even after a rejection or a move back to the queue. Why: the submit hook runs the same check and blocks the click, so preparing the form first only wastes the user's time. Hooks still check again at submission.
4. **Make sure it is verified and scored.** If the role is not yet `verified`, follow `verify-employer`, then call `gate_check` again and stop on any problem. If not `scored`, follow `score-role`. A drop ends the flow; tell the user the quote.
5. **Read the form before writing anything.** Open the apply form, decline the cookie banner, and dump every question with its type, required flag and `maxLength` (see `fill-form`). Stop early if a question is a hard-filter gate (onsite days, right to work somewhere the user cannot, overtime) and put the quote to the user.
6. **Write.** Follow `write-note` for the cover note and every free-text answer, sized to each field's limit. Respect any AI-use policy on the form. Save with `add_artifact` (`cover_note`, `form_answers`).
7. **Fill.** Follow only steps 3–4 of `fill-form` here: fill, read every value back out of the page, and upload the CV from `get_cv`; if `get_cv` has no usable file (missing, gone or unreadable), leave the upload and say so in the summary. Final review and submission happen in steps 8–9 below.
8. **Final review.** Read every value back and save the completed answers with `add_artifact` (`kind: "form_answers"`). If anything needs the user (a question, consent, personal data, login, CAPTCHA, or incomplete required field), queue it with a question and stop. Otherwise ensure the scored role is `queued` with no unresolved question. Do not clear a question without a recorded answer from the user. Call `get_profile` again immediately before submission.
   - `autonomy.auto_apply` is exactly `true`: call `gate_check` and continue only if it passes. Record a note with reason `Automatic application enabled by saved autonomy.auto_apply preference` and the `run_id`, so the audit can distinguish it from review-first submissions.
   - Missing or false: show the role id, company, title, location line, and every field/value, plus anything left blank and why. Say "To submit, type `/job-tracker:approve 42`. I will not submit without it." (with this role's real id), then stop and wait.
9. Follow step 6 of `fill-form` to submit once after the applicable check above. Capture the confirmation page text, `transition` the role to `applied` with that text as `evidence` and the `run_id` (plus `asked_salary`, the salary field's value as submitted, if the form had one), and `add_artifact` (`kind: "confirmation"`). Never report applied without confirmation.
10. **Account-gated flows** (join.com, Workday, anything behind sign-in): prepare everything, leave the tab open, `record` with `status: "queued"` and a `question` saying what is left, and tell the user.
11. Call `finish_run` with a one-line summary.
