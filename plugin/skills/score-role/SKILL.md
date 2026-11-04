---
name: score-role
description: Scores a verified job role against the user's hard filters and soft preferences, uses check_pay for the pay floor with a looked-up exchange rate, and records scored or dropped with evidence. Use after verify-employer for every verified role, when re-scoring after a user correction, or when deciding which queued roles to prepare first.
---

# Score role

Hard filters first (any miss drops). Then soft preferences (only move the score). Every verdict cites the employer's text.

## Hard rules

- **Only score verified roles.** If `verified_at` is empty, run `verify-employer` first.
- **Pay goes through `check_pay`.** Never eyeball it. Drop only if the band **maximum** is below the floor; straddling bands are kept and flagged with where in the band the user would need to land. Why: a range whose top cleared the floor was once dismissed as "under floor".
- **Look up the exchange rate for today; never guess it.** Use a reliable source (e.g. the ECB reference rate or another central bank, via fetch or search). Pass it as `fx_rate` (units of the floor currency per 1 unit of the posting currency) and write the rate, its date and its source in `score_notes`.
- **Read the per-role stack lines in `profile` before calling anything a gap.** The summary line at the top is not exhaustive. Why: a technology the user had used in two past roles was once scored as a gap from the summary line.
- **A required bullet with nothing honest to point at is a scoring signal**, usually a drop. Do not plan to write around it in the cover note.
- **Apply every active rule** from the `scoring` rules plus the global ones, loaded as Reading rules says in `${CLAUDE_PLUGIN_ROOT}/templates/rules.md` (Hermes: `${HERMES_SKILL_DIR}/../../templates/rules.md`). If they cannot be read, score nothing and return `blocked: rules unreadable`. Cite the rule id in `evidence` (`rule:<id>`) when a rule decides a drop.

## Procedure

1. `get_profile` (filters, prefs), `get_document("profile")`, and the rules loaded above. Read the role and the verify evidence.
2. **Hard filters**, each against the employer's text:
   - **Work mode and location**: from the verified `location_line` and `location_type`. Hybrid only if the user allows it, within `max_days_per_week` and listed cities.
   - **Timezone overlap**: required hours or "must overlap with <zone>" vs `overlap_window`.
   - **Work authorisation**: sponsorship needed where the user has none: drop.
   - **Pay**: call `check_pay` with `comp_min`, `comp_max`, `currency`, `period` (`year` | `month` | `week` | `day` | `hour`), `fx_rate` when the currency differs from the floor's, and `equity` if mentioned. Hourly, daily and monthly bands are converted from the **top** of the band. Verdicts:
     - `drop`: drop with the band quote.
     - `straddles`: keep; flag in `score_notes` ("band X to Y, floor Z, would need upper part of band").
     - `keep`: fine.
     - `unknown` (no band): not a drop. Note it.
   - **Explicitly below-floor salary with equity attached is still a drop.** Tells: "austerity salary", "startup salary", "below market, offset by equity". Equity can justify a "negotiable" answer inside the band; it cannot replace the base.
   - **Excluded industries**: judge the business line the role sits in (see `verify-employer`, parent vs venture).
   - **Excluded role shapes**: a role in an excluded category drops even with a perfect stack. Definitions:
     - *Forward-deployed*: the main job is building inside customers' codebases or being embedded with customers (often sits in a Solutions, Customer or Growth department; titles like solutions, customer, implementation or sales engineer). A product engineer who joins some customer calls or demos is **not** forward-deployed. A JD listing FDE as an acceptable prior background is not a tell.
     - *Backend-only*: backend in the title, or "Full Stack (backend focused)" with no frontend or product surface. Borderline cases: flag with the quote.
     - *People manager*: the role is managing reports as the main job.
   - **Numeric language gates**: a required bullet in a language the user avoids, with a self-rating screening question attached (e.g. "your Java level, 1 to 5"), is a drop with both quotes.
   - **Culture red lines**: overtime as a screening question, or hustle/grind as the centre of the values page ("whatever it takes", "996", "we're not for everyone", "more than 40 hours"): drop with the quote. Strong but generic ambition copy ("all-in", "high standards") with no hours expectation is **not** a drop: surface the quote in `score_notes`. An on-call rotation alone is ordinary; framed as a required screening question on a product role, surface it.
   - **Other excluded work** from rules (e.g. AI-training review gigs): drop with the rule id.
3. **Soft preferences** (score only): title and seniority match, company stage, stack want/avoid (weigh the core of the role, not nice-to-haves), domain and product the user would plausibly care about, contract type, posting age, and signs of a real seat.
4. **Score** on 0 to 10:
   - 8 to 10: clean on every hard filter, core stack and product shape match, domain the user likes.
   - 5 to 7: clean on hard filters, partial match, or one flag for the user.
   - below 5: clean but weak; usually not prepared.
5. **Record.**
   - Pass: `transition` to `scored` with `score`, `score_notes` (filters checked, pay verdict with fx rate and source, flags with quotes, internal reservations and gaps), `reason` (one line), and `evidence` (the decisive quote).
   - Fail: `transition` to `dropped` with `reason` naming the filter, `category` (`location`, `pay`, `industry`, `role_shape`, `stack`, `culture`, `gated`, `other`) and `evidence` = quote or `rule:<id>`.
   - Blocking question (from verification or scoring): `transition` to `scored`, then `transition` to `queued` with `question` = the single question, `blocked_by: "user"`, and the quote(s) as `evidence`. It appears under Needs you.

Gaps and reservations go in `score_notes` only. They never travel into anything written to the employer.

## Output

One line per role: `role_id | score or dropped | decisive quote | flag (if any)`.
