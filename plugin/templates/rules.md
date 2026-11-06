# Rules

<!--
Rules are your standing preferences and corrections. They live in the tracker (add_rule, list_rules,
get_rule, set_rule_types, deactivate_rule), not in this file. This template shows what a good rule looks like, so the ones
you add by hand or via /job-tracker:correct are usable by a future run that has never seen the conversation.
-->

Every rule has five parts:

| Field | What it holds |
|---|---|
| **text** | The rule, imperative, one or two sentences. Says what to do and where the line is. |
| **reason** | Why. What went wrong, or what you said. A rule with a reason generalises correctly to new cases. |
| **example** | The concrete case that produced it: company, role, the quote involved. |
| **date** | Set automatically (`added_on`). Later rules win over earlier ones on the same point. |
| **types** | Who reads it: one or more of `sourcing`, `scoring`, `forms`, `writing`, `inbox`, `reporting`. Leave it out for `global`, which every reader gets. A rule that is not global reaches only the workflows that name its type. |

## Good rules

```
text:    Drop a role on location only after quoting the employer's own posting. Aggregator tags are leads.
reason:  A role was dropped as "UK only" from a job-board tag; the employer's page said "Remote - International".
example: <Company>, <Role>: board tag "UK", ATS location line "Remote - International".
date:    <YYYY-MM-DD>
```

```
text:    Customer calls inside a product role are fine. Drop only roles that ARE forward-deployed
         (the main job is building inside customers' codebases or being embedded with customers).
reason:  A product role was flagged because it mentioned joining partner calls. User: "joining calls is fine".
example: <Company>, <Role>: "you'll join customer calls to understand integrations".
date:    <YYYY-MM-DD>
```

```
text:    Answer salary fields in the currency and period the field asks for. Convert at the day's rate.
reason:  A field asking for "gross, in $" got a figure in another currency.
example: <Company> form: "Salary expectations (annual, gross, in $)".
date:    <YYYY-MM-DD>
```

## Weak rules (avoid)

- "Be careful with locations." (No line, no action.)
- "Don't apply to <Company>." (No reason: a future run cannot tell if it still applies. Add why.)
- "Never mention gaps, except sometimes." (Contradicts itself. Split into two rules with their scope.)

## Narrow overrides

An override of one case is not a reversal of the rule. If you say "apply anyway" to one role, the
rule stays and the role gets an event with `actor: user`. Only replace a rule when you mean it to
change for every future case; then deactivate the old one.

## Reading rules

Every workflow that applies rules reads them this way. Its own line says which `types` to pass; the steps are here once.

1. Call `list_rules` with those `types`, or with no `types` when the workflow reads all types. Global rules always come back too. Save the first page's `rules_revision` as the collection revision. A page is not the whole set: call again with `cursor` = `next_cursor` until it is `null`.
2. An entry `{id, types, requires_detail: true}` has no text (it is too long for a page). Call `get_rule` with its `id` and `expected_revision` = the collection revision on the first call for every oversized rule, then again with `cursor` = `next_cursor` until it is `null`. Join the `chunk`s in order and `JSON.parse` the result. Compare every page and detail response `rules_revision` with the collection revision. Never act on partial JSON.
3. The rules are complete only when `next_cursor` is `null` and every `requires_detail` entry has been rebuilt. Until then do none of the work that depends on them.
4. If a call says the rules changed (a stale `rules_revision`), or any returned revision differs, discard all list pages and detail chunks together and start again from the first page. Never mix pages or details from two revisions.
5. After two attempts that fail (stale again, or an error), stop. Report `blocked: rules unreadable` and do not do the work that depends on them; never carry on with the part you did read. A subagent returns that token as its result. Anything else says it to the user or at the top of the report, as an incomplete run.
6. Reuse a complete collection from earlier in this run, for the same types or for all types, only if nothing wrote a rule since (`add_rule`, `set_rule_types`, `deactivate_rule`). After any rule write, read again. A subagent always reads its own.

Why: a sweep that read only the first page missed standing rules and re-queued roles the user had ruled out. A rule can change after the final list page but before the first detail chunk, so the collection revision must cross that boundary too. This is agent behaviour; the server returns one page per call and never loops for you.
