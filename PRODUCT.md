# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Job seekers: one person running their own search. They use Claude Code or Hermes Agent, or are willing to, and want a disciplined, low-noise search instead of volume applications. The site's visitors are these job seekers deciding whether to install the plugin, then setting it up and using it.

## Product Purpose
Job Tracker is a free, open-source plugin for Claude Code and Hermes Agent that runs a job search for one person. Every weekday it finds roles that fit the user's hard filters, verifies each on the employer's own posting, dedupes against everything already touched, and prepares tailored applications. It tracks replies and interviews and writes one short daily report. Success is fewer, better applications.

## Positioning
All data stays local and the tool runs in the user's own environment of choice, and it is free. The tracker is a stdio server on a local SQLite database with no network listener, and nothing is sent to the author. Hosted auto-apply services cannot truthfully claim that.

## Operating Context
Runs inside Claude Code (Desktop or CLI) or Hermes Agent, on the user's machine, with Gmail and Calendar connectors and a browser (Claude in Chrome or the host's) recommended. The site is static HTML/CSS/JS in `site/` with no build step, deployed as is to GitHub Pages at jobtrackermcp.com. Surfaces: landing page (index.html), docs (docs.html), privacy (privacy.html).

## Capabilities and Constraints
- Writes email and LinkedIn drafts only; hooks block every send.
- Submits only through the employer's official apply flow, with the saved auto-apply choice or per-role approval. It never creates accounts, enters passwords, solves CAPTCHAs, ticks consent boxes unprompted, or fills personal-data fields.
- Does not auto-apply at volume.
- Status: early and in active development. Source adapters may break when job sites change.
- Commands are prefixed `/job-tracker:` (setup, sweep, apply, approve, triage, prep, status, board, cover-letter, correct).

## Brand Commitments
- The name stays "Job Tracker".
- Calm voice.
- Japanese zen references (existing assets: sand-ripples.svg, zen-engawa.webp).

## Evidence on Hand
Demo reel and setup videos (`site/assets/job-tracker-reel.mp4`, `setup-desktop.mp4`), the public GitHub repo with CI, and the MIT license. There are no testimonials, user counts, or benchmarks. Do not fabricate any.

## Product Principles
1. Fewer, better applications over volume.
2. The user's data and the user's decisions stay with the user: local only, approval-gated.
3. Verify against the employer's own posting, never an aggregator's tag.
4. Calm over urgency: no hustle or hype framing.
5. Honest about being early.
