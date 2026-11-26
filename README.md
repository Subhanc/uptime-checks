# Uptime checks

Small scheduled checks that run every hour and report how each one went.

Each check acts as a buyer on a **test** account with a test card, checks the
answer, and cancels what it made. Every check refuses to run against an account
that is not marked as a test account, and cleans up after itself when it fails.

| Check | What it does |
|---|---|
| `shop.probe` | Starts a shop order, changes it, and cancels it. |
| `ticket.probe` | Starts a ticket order and cancels it. |
| `vendor_table.probe` | Reserves a table and releases it. |
| `membership.probe` | Starts a membership and cancels it. |
| `shop.card_payment` and three more | Pays for a test product with a declined test card, then a good one, refunds it, and reads the refund back (`shop.declined_retry`, `shop.refund`, `refunds.settled`). |
| `ticket.card_payment` and two more | The same for a ticket: declined card, good card, the order completes, refund, refund read back (`ticket.declined_retry`, `ticket.refund`). |
| `vendor_table.card_payment` and two more | The same for a vendor table; the refund puts the table back on the floor. |
| `membership.card_payment` and two more | The same for a membership's first payment, then the membership is cancelled. |
| `course.card_payment` and two more | The same for a course bought as a guest; the refund ends the access. |
| `booking.card_payment` and two more | The same for a booking of a probe-only service; the refund also cancels it, freeing the date. |
| `booking.deposit` | Two runs make one answer: each books a probe-only service with a small deposit whose balance falls due minutes later, and checks the previous run's balance was charged automatically, then refunds both payments and cancels it. |

## Files

- `scripts/*-probe.mjs`: the checks. Plain Node, no packages.
- `scripts/paid-probe-lib.mjs`: the steps the paid probes share.
- `scripts/*-probe-fixture.json`: which test account each check uses.
- `scripts/report-reliability-result.mjs`: reports one result, and cleans
  secrets and email addresses out of the output before it reaches the log.
- `.github/workflows/probes.yml`: runs the checks.

These files are generated from another repository and overwritten on every
sync, so do not edit them here.

Run logs here are public. Every check's output passes through the cleaner, and
the last step of every run fails if the probe key shows up in the output.

## Settings it needs

Repository secrets (Settings > Secrets and variables > Actions), all required
unless noted:

- `PROBE_API_KEY`: the key the service expects. Without it every run fails on
  purpose, rather than passing having checked nothing.
- `PROBE_API_URL`: the base URL of the API under test.
- `PROBE_CUSTOMER_EMAIL`, `PROBE_BUYER_EMAIL`: the fixed test buyer addresses.
- `SLACK_ALERTS_WEBHOOK_URL` (optional): posts each failed run to Slack.

## Running it by hand

Actions > Probes > Run workflow. A `deploy` repository dispatch also starts a
run:

```bash
gh api repos/<owner>/<this-repo>/dispatches \
  -f event_type=deploy -f 'client_payload[sha]=<commit>'
```

One red run is not an outage. If the next run fails at the same step the same
way, it is real.
