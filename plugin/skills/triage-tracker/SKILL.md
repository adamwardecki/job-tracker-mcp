---
name: triage-tracker
description: Safely reconciles and cleans third-party job tracker boards (JobCopilot-style kanban columns such as Saved, Applied, Contacted) in the browser, resolving columns by header text and running guard.js before every delete round. Use for /job-tracker:triage, for reconciling an auto-apply tool's Applied column against the tracker, or before any delete, archive or bulk action on a job board.
---

# Triage tracker

Board triage is the one place the plugin deletes things. Every rule here exists because a card was once deleted from the wrong column.

## Hard rules

- **Resolve every column by its header text, never by index or class.** Operate only on descendants of that column node. Why: on one board the same class marked all five column containers, Saved and Applied cards had identical markup, and a `[0]` index deleted a card from Applied.
- **Run the guard before every delete round** (see below). A hook denies the delete unless the latest `JOBHUNT_TRIAGE_GUARD` line shows `ok: true` with no other click since.
- **Selection must exactly equal the intended list**, and **every protected column must have 0 checked**. The guard checks both; you also check them yourself.
- **Re-measure header controls after any selection change.** Selecting cards adds icons to the header and shifts the checkbox; clicks aimed at the old checkbox position have landed on the trash icon.
- **Click buttons via the button element**, not an inner `svg`. A click on the svg can silently do nothing.
- **Confirm dialogs are not a safeguard.** They read the same in every column.
- **Verify protected column counts are unchanged after each round.** If any changed, stop at once and tell the user.
- **Never enable auto-apply, change board settings, or withdraw applications.** Save-only.
- **Hook denials are final for that click.** Re-run the guard and fix the selection; never delete by coordinates or JS to get around a denial.
- Deletes need the user: agree the delete criteria with them before the first round.

## The guard

File: `guard.js` in this skill's directory (`${CLAUDE_PLUGIN_ROOT}/skills/triage-tracker/guard.js` on Claude Code, `${HERMES_SKILL_DIR}/guard.js` on Hermes; use whichever path is expanded). Read it, replace the INPUT placeholder on its last line (the only occurrence) with the input object as JSON, and run the whole file in the board tab with `javascript_tool` (Claude in Chrome) or `browser_console` with `expression` (Hermes).

Input:
```json
{
  "column": "<header text of the column you are deleting from, e.g. Saved>",
  "protectedColumns": ["Applied", "Contacted", "Interviewing", "Offer"],
  "intended": ["<card title>", "<card title>"],
  "expectedCounts": {"Applied": 5},
  "allColumns": ["Saved", "Applied", "Contacted", "Interviewing", "Offer"]
}
```
- `column`: the header text as shown, without the count.
- `protectedColumns`: every column that must not change. Always include Applied and anything after it.
- `intended`: the exact card titles you mean to delete in this round, as they appear on the cards.
- `expectedCounts` (from round 2 on): the protected counts from the previous guard output. A changed count fails the guard.
- `allColumns` (optional): every header on the board. It helps the guard find column boundaries.
- `titleSelector` (optional): a CSS selector for the title element inside a card, if the first line of the card is not the title.

Output: one line, `JOBHUNT_TRIAGE_GUARD {json} JOBHUNT_END`. The JSON has `ok`, `problems`, `selected`, `missing`, `extra`, `protected` (count and checked per column) and `delete_controls` (the column's delete buttons with their current centre coordinates, for re-measuring). `ok: false` means: do not delete; fix the selection and run the guard again.

What the delete hook accepts after a passing guard: the delete control and then the confirm button in its dialog. Any other click (selecting another card, a coordinate click) invalidates the guard, and a guard more than about 40 tool calls old is stale.

## Procedure

### 1. Open the board
- Get the URL from something that has it: the tool's recap email link, `get_profile`, or the user. Never guess the hostname; a login redirect on a guessed URL proves nothing.
- If genuinely logged out, stop and ask the user to sign in.

### 2. Map the columns
- Find each column node by header text, e.g. find the element whose own header reads `Saved` and take its column container.
- Record each column's header count (e.g. "Applied (5)") as the **baseline**. Keep this list for the whole session.

### 3. Reconcile the Applied column (every run, read-only)
- Read every card inside the Applied column only: company, title, link, date.
- For each, `find_company` with the card's link as `url` (`exact_role_ids` names the role if it is tracked). If the tracker has no live application for it:
  - `upsert_role` with `source` = this board and the card's link as `url`. If it returns `possible_role_ids`, check them as in Identity in `source-roles`: when one is this posting, record on that role and link the new row under it with `link_duplicate_role`. Why: a second row would split the application's history, and the submit gate reads that history. Then `record` with `status: "applied"`, `actor: "user"`, reason "Filed by <tool> in the user's name", evidence = the card text verbatim.
  - Check it against hard filters from the card and, if cheap, the employer page. Any violation: `record` a note with the quote and a `question` (e.g. "Withdraw?"), and tell the user in the session. The application is already out; only the user can decide to withdraw.
- Report how many Applied cards there are and how many were new to the tracker.

### 4. Harvest the Saved column
- Read cards inside the Saved column only. The list may be virtualised: it can advance only on real scroll events (the browser's scroll action), not `scrollTop` or synthetic wheel events. Budget roughly one scroll per few cards; do not loop JS scrolling (it can freeze the renderer).
- For each card: `find_company` with the card's link as `url`. New and plausible: `upsert_role` as `found` with that `url` (it goes through `verify-employer` later). Already seen, dropped, stale, or clearly excluded by title: candidate for deletion.

### 5. Agree criteria with the user
Show the counts and a sample of each group, and propose the delete criteria (e.g. "delete Saved cards already in the tracker or with excluded titles"). Proceed only on the user's yes.

### 6. Delete in rounds (10 to 20 cards per round)
For each round:
1. Pick the round's cards from the Saved column's current DOM.
2. For each card: fresh `find`, confirm the card is still inside the Saved column node, tick its checkbox.
3. Re-measure the header controls (locate the delete button from the DOM inside the Saved column header, not from earlier coordinates).
4. Run the guard with `column`, `protectedColumns` and the round's `intended` titles. Require `ok: true`.
5. Next action must be the delete: click the delete control via its **button** element (fresh `find`), then the confirm button in the dialog. No other clicks in between.
6. Read all column header counts. Saved must drop by exactly the round size. Every protected column must equal the baseline. If not: stop, report the exact before and after counts, and do nothing else.
Delete as you go rather than loading the whole list first; the pile shrinks and scrolling gets cheaper.

### 7. Finish
- `set_source_status` for the board with counts.
- Report: Applied reconciled (count, new), new leads, deleted, protected counts before and after.
