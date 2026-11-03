---
name: verify-employer
description: Verifies a job lead against the employer's own posting (ATS page, careers page, apply form) before it is scored, and records verified or dropped with a verbatim quote. Use for every role in found status, whenever an aggregator, recruiter or broker tag (remote, location, salary, industry, seniority) would decide a role, and when two sources disagree on a hard filter.
---

# Verify employer

Load the employer's own posting, quote it, and decide. This step is the only way `roles.verified_at` gets set.

## Hard rules

- **Aggregator tags are leads, never verdicts.** Location, industry, seniority, salary and "Remote" from LinkedIn, boards, brokers or recruiters are unverified. Before writing any drop reason, open the employer's page and **quote it**. Why: wrong drops happened on stale tags, and wrong approvals happened four times on "Remote" tags that the ATS contradicted (e.g. "Hybrid (8 days/month)").
- **The live employer ATS is the authority.** A careers page, ATS posting or the apply form itself. Not a recruiter's rewrite, not a cached aggregator copy.
- **Every `verified` needs** `evidence` (the ATS URL plus the verbatim location line), `location_line` (verbatim) and `location_type` (`remote` | `hybrid` | `onsite` | `unknown`).
- **Every `dropped` needs** `evidence`: a verbatim employer quote, a URL plus quote, or `rule:<id>`.
- **Conflicting employer sources → flag, never pick the optimistic reading.** If the employer's own sources disagree on a hard filter (e.g. "remote" in their HN post, "Hybrid" on their ATS), do not drop and do not approve. `transition` to `verified` (you did read the employer's page) with **both quotes** in `evidence`, and hand the single question to `score-role`, which queues the role with that `question` for the user.
- **Forms are evidence too.** A screening question like "Can you work onsite 3 days a week?" or "Do you have the right to work in <country>?" overrides "Remote" in the posting.
- Read the location line and location type **now**, during verification. Not at the form. Why: a role once reached the user's approval before anyone noticed it was gated to three countries.

## Procedure

1. **Get the employer URL.** From the lead's URL, a "View job post"/apply link, or the employer's careers page. If the lead came via a recruiter or broker, find the employer's own page anyway; a recruiter's rewrite can drop the whole tech stack.
2. **Bind the employer URL to the role.** If the role's `url` is not this employer page, `upsert_role` with its `id` and `url` = the employer page (pass `identity_evidence` if the tool asks for it, saying how the lead links to this page). If the tool answers that the URL belongs to another role, this lead is that posting: do not verify it as new. `link_duplicate_role` with that role as `canonical_role_id`, this one as `duplicate_role_id` and the shared URL as `evidence` (if it refuses because this role moved last, swap them as its error says), and return `duplicate of <id>`. Why: the employer URL is the posting's identity; verifying a second row for it would let one job be prepared, and applied to, twice.
3. **Load it.** Prefer the ATS posting API or a plain fetch (works without a browser; see `source-roles/reference.md`). Use the browser only if fetch cannot render it.
   - Posting gone (404, "no longer active", redirect to the board root): `transition` to `dropped`, reason "posting closed", evidence = URL plus the message seen.
4. **Read, in this order, and copy verbatim:**
   1. Location line and workplace/location type. Secondary locations. Any country list.
   2. The employer's identity: the About block, who actually employs the hire. Recruiting agency or staffing firm presenting a client is a different employer.
   3. Pay band if published, with currency and period.
   4. Deadline field and any application caps ("may not apply more than N times in 60 days").
   5. Open-position count on the board.
   6. If the apply form is reachable without login: its screening questions (Greenhouse `?questions=true` works by fetch).
5. **Check the tells below.** Each produces a drop (with quote) or a question for the user (passed to `score-role`).
6. **Record.** If the role passes: `transition` to `verified` with `evidence`, `location_line`, `location_type`, and update the role with any comp, stack, industry and ATS details via `upsert_role` (with `id`). Otherwise `transition` to `dropped` with the quote and a `category` (`location`, `pay`, `industry`, `role_shape`, `stack`, `culture`, `duplicate`, `gated`, `other`). Pass the `run_id` when you have one.

## Tells and what they mean

**Location and work authorisation**
- Employer's location line excludes the user's country, and the employer's own signals all point to one country (single office, office perks, local-language posting, no other countries anywhere): drop. Do not turn it into a question for the user.
- Every opening at the employer is gated to countries the user cannot work in: drop.
- A multi-country whitelist that omits the user's country, at an employer that is genuinely remote and global: do not drop silently. Check the employer's **other reqs** on the same board. If another req lists the user's country, the omission is deliberate: drop with both quotes. If not, pass the question to the user with the quote; lists get extended for the right candidate.
- Screening question gating on residence or right to work elsewhere: drop with the question text.
- An unqualified "Remote" with no country list on the employer's own ATS, or "work from anywhere", is open.
- A company entity in the user's country means nothing if no req is open there.

**Offshore staffing and EOR**
- Country suffix in the title: `(PK)`, `(IN)`, `(PHL)`, `(ZA)`.
- Bracketed req codes like `[AB123]`.
- Near-duplicate posts that differ only by country.
- Bands in INR or PHP.
- Mission copy about "connecting talent with global teams" or "breaking down geographic barriers": the company places engineers rather than employing them for its own product.
These JDs are often excellent on the work. The geography still decides. Drop with the location quote.

**Funnel reqs**
- Four-figure open-position count at a small company, the same title repeated per country, or several company pages posting identical titles the same week: the req is probably not a real seat. Drop with the count as evidence, or flag if the rest is strong.

**Parent vs venture**
- Judge the business line the role sits in, not an unrelated sibling venture of the parent. An excluded industry in a sibling venture with its own product, team and GM is not a drop. An excluded industry that is the employer's largest stated business line, or a role that spans "our portfolio", is.

**Freshness**
- A passed "Deadline to apply" field does not prove the form is closed. Check the form before dropping.
- Several reqs with the same title (e.g. one marked "(Backend)"): identify which one is being recruited for; one may be an excluded shape.

**Stale or wrong industry tags**
- Industry tags on aggregators can be years out of date (e.g. a business sold off). Check the employer's current About page before applying an excluded-industry drop.

## Output

Return one line per role: `role_id | verified|dropped|duplicate of <id> | location_line (verbatim) | one-line reason | question for the user (if any)`.
