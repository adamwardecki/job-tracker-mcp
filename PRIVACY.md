# Privacy policy

Effective 14 November 2026. This policy is also available at
[jobtrackermcp.com/privacy.html](https://jobtrackermcp.com/privacy.html).

This policy covers the Job Tracker plugin and this website. Job Tracker is open-source software maintained
by Adam Wardecki ("we"). We do not sell your data. The plugin collects usage analytics and crash reports
only if you allow it.

## Usage analytics and crash reports (optional)

At the start of setup the plugin asks whether you allow anonymized usage data collection for improving the
tool. The default is no. Your answer is stored in the tracker database. If you say yes, the plugin sends
events to PostHog (US cloud) when the tracker records an action: which action it was (for example a setup
step saved, a run started, a role moved from scored to queued, a draft saved), statuses, kinds and counts,
and the plugin, Node.js and operating system versions. Events carry a random install ID, not your name or
account. They never contain company names, job titles, URLs, your CV, messages, your settings, or anything
you type into a form.

If you say yes, the plugin also sends a crash report when the tracker hits a bug: the error type, the place
in the plugin's code where it happened, and the error message with personal details removed (email
addresses, links, file paths, quoted text, long numbers and capitalised words such as names are replaced
with placeholders).

To stop, ask the plugin to turn off usage analytics at any time. It records the change and deletes the
install ID, and nothing more is sent. Setting the environment variable `DO_NOT_TRACK=1` also stops it.

## Data on your computer

Job Tracker stores your profile, job preferences, application history, drafts and interview details on
your computer. It also keeps session records, which on Hermes Agent can include email and page content
read during a session. Files you create, such as cover letters, are saved separately wherever you choose.

## Data shared with other services

Information used in a session is shared with your AI provider. Optional connections to email, calendars,
job boards and other services handle data under their own privacy policies. Applications you approve individually, or authorize through the saved automatic-application preference,
are shared with the employer and its application platform.

## Deleting your data

Local records stay until you delete them. To remove them, delete `~/.job-tracker`, or your custom data folder
if you set one. Uninstalling the plugin does not delete this data. Delete separately saved files and any
drafts, events or conversation history held by connected services where they are stored.

## This website

This site counts page views and clicks on its links and buttons with PostHog (US cloud). It sets no cookies
and stores nothing in your browser, so a returning visit is not linked to an earlier one, and it skips
browsers that send Do Not Track. It is hosted on GitHub Pages, which may log visitors’ IP addresses for
security; see the
[GitHub privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

## Changes and contact

Updates will be published here with a new effective date. For questions, open a
[GitHub issue](https://github.com/adamwardecki/job-tracker-mcp/issues). Issues are public, so do not include
personal data.
