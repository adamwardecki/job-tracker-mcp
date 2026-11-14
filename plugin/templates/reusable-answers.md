# Reusable answers

<!--
Answers to the questions application forms ask again and again, in your own words.
Saved with save_document(name: "reusable-answers"). The plugin adapts from these instead of
drafting fresh, and sizes them to each field's character limit.
Keep each answer true and specific. Run your own longer answers past the writing rules
(no dashes, no volunteered gaps) once; the plugin lints them again before use.
-->

## Fields the plugin will never fill

The plugin leaves these for you, every time, even if you write an answer here. A hook blocks
the common ones.

- Passport details, nationality, citizenship
- Age, date of birth
- Marital status, gender, pronouns
- Ethnicity, race, disability, veteran status, religion, sexual orientation (equal-opportunity surveys)
- National ID, tax, social security or similar numbers
- Photos
- Passwords, account creation, CAPTCHAs
- Consent checkboxes (recording, marketing, talent pool, data sharing), unless you type
  `/job-tracker:allow-consent <role_id>` for that role

## Standard fields

- **Preferred name:** <...>
- **Email for applications:** <...> (the plugin always reads this field back; browser autofill can insert another address)
- **Phone:** <...>
- **Location (city, country):** <...>
- **LinkedIn / portfolio / GitHub / publications:** <...>
- **Work authorisation statement:** <e.g. "Authorised to work in <region> without sponsorship.">
- **Requires sponsorship:** <Yes / No>
- **Willing to relocate:** <Yes / No / Depends>
- **Notice period / start date:** <...>
- **How did you hear about us:** the true source for each role (the plugin fills it per role)

## Salary

- **Band (your currency, period, gross/net):** <e.g. 00,000 to 00,000 <CUR> per year, gross>
- **Answer when the role has no equity:** <e.g. "<band> gross per year">
- **Answer when the role offers equity (text field):** <e.g. "Negotiable depending on the equity package">
- **Number-only field with equity on offer:** the plugin asks you for the figure.
- **Other currency or period:** the plugin converts your band at the day's rate and writes it in the field's currency and period.

## Short answers (one or two sentences, fits 255 characters)

- **Why are you looking:** <...>
- **What are you looking for next:** <...>
- **Remote work experience:** <...>
- **Timezone overlap you can offer:** <...>

## Long answers (in your own words)

### "Tell us about yourself"
<...>

### "Describe the most complex thing you have built" / "Walk us through a project end to end"
<...>

### "How do you use AI tools in your work?"
<...>

### "Why do you want to work here?"
Written per role by the plugin from the employer's own page and your stories. Leave this empty.

## AI-use policies

If a form asks you not to use AI, the plugin leaves its free-text fields empty and gives you raw
material (facts, angle, stories) in the role's notes instead.
