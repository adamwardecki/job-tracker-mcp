---
description: Write a cover letter for one role, optionally as a one-page A4 PDF.
argument-hint: "<role-id> [--pdf]"
---

Write a cover letter for the role in `$ARGUMENTS`.

**If the tracker tools are missing** (search for them first if tools are deferred), or a hook error says `node` could not start: Node.js, which the plugin runs on, is missing or too old. Tell the user that in one sentence, offer to run `/job-tracker:setup` (it installs Node.js), and stop.

1. Parse the role id and the optional `--pdf` flag. If the role id is missing, call `open_items` and ask which queued role.
2. Load the `write-note` skill and follow it: read the role, the employer page, `profile`, `stories`, `reusable-answers` and `voice` (if present). Rules: load `writing` (Reading rules: `${CLAUDE_PLUGIN_ROOT}/templates/rules.md`; Hermes: `${HERMES_SKILL_DIR}/../templates/rules.md`). Motivation first, 150 to 200 words unless config says otherwise. Humanizer pass. `lint_prose` must pass before saving.
3. Save the text with `add_artifact` (`kind: "cover_note"`) and show it to the user.
4. **With `--pdf`:** lay it out as one A4 page, standard letter layout, in this order:
   1. Name and contact header (name, email, phone if in `profile`, city and country). No bare tracking links.
   2. A thin horizontal rule.
   3. Recipient block (company name, hiring team or named person if known) and the date.
   4. A role title line, e.g. "Senior Product Engineer". No "Re:".
   5. Salutation ("Dear <name>," or "Dear <Company> team,").
   6. Body (the note).
   7. "Kind regards," and the user's name.
   Render it with a PDF-capable skill or tool if one is available (e.g. the `pdf` skill), otherwise HTML printed to PDF. Then **verify visually**: render page 1 to an image and look at it. Check it is one page, nothing is clipped, there are no dashes or placeholder text, and the name and date are right. Fix and re-render until it passes. Save with `add_artifact` (`kind: "cover_letter_pdf"`, `ref` = the file path or link) and give the user the file.
