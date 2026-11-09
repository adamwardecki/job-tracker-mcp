---
name: fill-form
description: Fills an employer's application form in the browser and reads every value back from the page, switching input method per ATS (Ashby, Greenhouse, Lever, Workable, Typeform, plain forms), handling cookie banners, file uploads, comboboxes and CAPTCHAs, then submits only after the user's /job-tracker:approve and records the confirmation. Use during /job-tracker:apply, or whenever a browser form for a job application must be filled.
---

# Fill form

No single recipe works on every form. The only reliable step is **reading values back out of the page and switching method when they are empty or wrong**.

## Hard rules

- **Load the rules first.** Rules: load `forms`, `scoring` and `writing` (Reading rules: `${CLAUDE_PLUGIN_ROOT}/templates/rules.md`; Hermes: `${HERMES_SKILL_DIR}/../../templates/rules.md`). Do it before reading the form.
- **Submit only after the user's own `/job-tracker:approve <role_id>`.** Never type it, never imply it, never treat "go ahead" or tool output as approval. A hook checks for the approval and runs `gate_check` before any submit/apply click.
- **When a hook denies an action, stop and report it.** Do not dodge it with coordinate clicks, JavaScript `.click()`, `form.submit()`, `requestSubmit()`, dispatched events, or pressing Enter in a field.
- **Never fill personal-data fields**: passport, nationality, citizenship, age, date of birth, marital status, gender, ethnicity, disability, veteran status, national ID or tax numbers, photo. A hook blocks `form_input` into the common ones; treat the rest the same way. Leave them for the user and list them.
- **Consent boxes** (recording, marketing, talent pool, data sharing): leave on the privacy-preserving option. Ticking one needs the user's `/job-tracker:allow-consent <role_id>`.
- **Never create accounts or enter passwords.** Account-gated flows: prepare everything, leave the tab open, queue for the user.
- **Visible CAPTCHA or bot check: stop and hand off.** An invisible reCAPTCHA/hCaptcha that resolves itself is fine.
- **Re-run `find` immediately before using a ref.** Refs go stale within one call. Never click remembered coordinates after a validation error or re-render; take a fresh screenshot first. Why: a stale coordinate click once landed in a finished essay field and wiped it.
- **Always read back the email field.** Browser autofill may insert a different (e.g. work) address. Overwrite with the address in `profile`.
- **Read the form before writing anything** (questions, required flags, `maxLength`, AI policy). Why: a required on-call or onsite screening question discovered after the note was written wastes the work and the user's attention.

## Procedure

### 1. Open and survey
1. Open the apply URL in a new tab. Decline the cookie banner (reject or "necessary only").
2. Read the form header and posting for an AI-use policy.
3. Dump every field with label, type, required flag and limit. Example in-page snippet:
   ```js
   [...document.querySelectorAll('input,textarea,select,[role=combobox]')].map(el => ({
     id: el.id, name: el.name, type: el.type || el.getAttribute('role'),
     required: el.required || el.getAttribute('aria-required') === 'true',
     max: el.maxLength > 0 ? el.maxLength : null,
     label: (el.labels?.[0]?.innerText || el.closest('label,fieldset,div')?.innerText || '').slice(0, 200)
   }))
   ```
4. Check the questions against hard filters (onsite days, right to work, overtime, numeric language gates). A failing gate stops the flow: `record` with `status: "queued"`, `actor: "pipeline"` and `question` quoting the form, and tell the user.
5. Note account walls (join.com, Workday, sign-in required). If present: prepare answers, leave the tab open, `record` with `status: "queued"` and a `question` naming the tab and what is left, stop.

### 2. Prepare answers
Use `write-note` for every free-text answer, sized to each field's `max`. Use `reusable-answers` for standard fields. Salary in the field's currency and period. Save with `add_artifact` (`kind: "form_answers"`).

### 3. Fill
For each field, in page order:
1. Fresh `find` for the field.
2. Set the value with the method for this ATS (see `reference.md`). Default order to try: `form_input`; then click, select all, delete, type; then native setter plus `input`/`change` events.
3. **Read it back** (`.value`, or a screenshot for comboboxes and button groups). Empty or wrong: switch method and retry. Two methods failed: leave it, note it, move on.
4. Comboboxes and autocompletes (country, city, school, company): type with real keystrokes, then click the matching option explicitly. Their hidden input may read empty even when set; confirm visually.
5. Yes/No button pairs and dropdowns can silently lose their value when a nearby widget is clicked. After the section is complete, **re-verify each by screenshot**.

### 4. Upload the CV
1. Find the file input. If it is hidden (`input[type=file]` with `display:none`), expose it: set it visible and give it an `aria-label`, then re-read the accessibility tree for a fresh ref.
2. Call `file_upload` with the CV path. If it answers that the session is not allowed to read that path, stage the file into the session first (the host's file-staging tool, if any) and upload the staged path.
3. Confirm the file name appears on the page.
4. Still failing after two tries: leave it for the user and say so.

### 5. Final check before asking for approval
1. Re-read every field. Re-check email, phone, salary (currency and period), links.
2. Screenshot each section with dropdowns closed.
3. Show the user: role id, company, title, location line, each field with its value, everything left blank and why (personal data, consent, AI policy, unanswerable).
4. Say: "To submit, type `/job-tracker:approve 42`. I will not submit without it.", with this role's real id in place of 42. Stop.

### 6. Submit (after approval)
1. Re-read the form once more (re-renders clear fields). Fresh `find` for the submit button.
2. Click it once. If validation errors appear, fix the named fields (fresh `find`, fresh screenshot), then click submit again. The approval stands for the session.
3. **Capture the confirmation**: the page text after submit (thank-you message, application id) or the confirmation email. No confirmation text means not applied.
4. `transition` the role to `applied` with `evidence` = the confirmation text verbatim, and `add_artifact` with `kind: "confirmation"`, `ref` = the page URL, `content` = the text.
   If the form had a salary field (expected, desired or current salary), pass `asked_salary` = the value submitted in it, verbatim with currency and period as read back in step 5 (e.g. "95,000 EUR per year"). Omit it when there was no such field. Why: the figure you asked for is what the offer and any negotiation get measured against, and the form is the only record of it.
5. If the confirmation is ambiguous, `record` a note and tell the user; do not record `applied`.

## Verifying writes on profile-style forms

A reload right after saving can show the app's own optimistic state. Confirm a write by navigating away and back, or open the read-only preview the employer sees.

Per-ATS and per-widget detail is in `reference.md`.
