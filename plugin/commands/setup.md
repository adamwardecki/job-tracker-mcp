---
description: Set up the job-hunt plugin (CV, filters, accounts, connectors, schedule, calibration run). Resumable.
argument-hint: "[step name to jump to, e.g. analytics | cv | filters | accounts | schedule]"
---

Run the job-hunt setup.

Load the `setup` skill and follow it exactly. It drives the conversation; the tracker tools persist and validate everything.

1. Run step 0 (Runtime) of the skill first. If step 0 stops, stop here too. Then call `setup_status`.
2. If its `usage_analytics` item is not answered, ask step 1 (Usage analytics) of the skill now, before any other question, and save the answer with `set_usage_analytics`.
3. Call `start_run` with `kind: "setup"` and the capabilities you detect (see the skill).
4. Call `setup_status` again and show the user a short checklist of what is green, amber and red.
5. Resume at the first step that is not green. If `$ARGUMENTS` names a step, jump to that step instead.
6. Ask multiple-choice questions wherever the answer has a small set of options. One topic per question.
7. Echo every section back as a one-screen summary before calling `save_config` or `save_document`.
8. At the end call `setup_status` again. Setup is done when it is all green, or when every amber item has a user decision recorded with `record_setup_decision` (key and the user's words).
9. Call `finish_run` with a one-line summary.

Never store or ask for passwords. Never create accounts on job sites for the user.
