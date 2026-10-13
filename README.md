# Tax deadline reminder

A Google Apps Script that emails tax deadline reminders and mirrors the
deadlines onto Google Calendar, with a web dashboard for configuration.

It covers three kinds of deadline:

- Federal estimated tax instalments (individual Form 1040-ES or corporate
  Form 1120-W)
- Texas sales & use tax returns (monthly, quarterly or annual)
- Annual returns and their extended deadlines (personal Form 1040, business
  returns by entity type, and the Texas franchise tax report)

Statutory dates are rolled forward past weekends and holidays, including
Emancipation Day for IRS deadlines, so the observed date is correct in any
year without editing the tables.

## Files

- `Code.gs` — all server-side logic: deadline engine, reminder emails,
  calendar sync, settings storage and the dashboard's data endpoints.
- `Dashboard.html` — the web dashboard (not yet in this repository; see
  setup step 2).

## Setup

1. Go to script.google.com and create a new project. Paste `Code.gs` in as
   `Code.gs`.
2. Add an HTML file named exactly `Dashboard` and paste `Dashboard.html` in.
3. Project Settings → set the timezone to `America/Chicago`.
4. Run `setup()` once and approve the permission prompt. This installs the
   daily trigger, builds the calendar events and logs the next year of
   deadlines.
5. Deploy → New deployment → Web app, with **Execute as: Me** and
   **Who has access: Only myself**. Open the deployment URL to reach the
   dashboard.

Settings live in Script Properties, so redeploying will not clobber them.

## How it runs

- `checkDeadlines()` runs once a day on a time-based trigger. For each
  upcoming deadline it sends one email when a configured lead time (default
  21, 7, 3 and 0 days out) is crossed, records the send so it is never
  repeated, tops up calendar events, and prunes records older than two years.
- `saveSettings()` is called by the dashboard. It normalizes the input,
  stores it, reinstalls the trigger at the chosen hour and rebuilds the
  calendar events from scratch.
- `sendTestEmail()` sends the next upcoming deadline as a `[test]` email so
  you can check delivery from the dashboard.
