---
name: performance-atlas-report
description: Build, audit, or update an interactive Performance Atlas HTML report for saved strategy and portfolio histories. Use for equity, calendar returns, drawdown, distributions, portfolio activity, or margin drill-down.
---

# Build and verify a performance report

Run the commands from the repository root. The report can open offline. Use the [reporting guide](../../../docs/performance.md) for input fields, account conventions and worked examples.

## Report scope

- Put every requested portfolio from the same project in one report. Give each one an option in the same **Portfolio** dropdown. If the user requests hosting, give them one website address.
- For a request for links to each portfolio, use links to selections in the shared site when available. Create separate reports only if the user requests separate deliverables or access rules require them.
- Give each portfolio a unique ID. Reuse a strategy ID when the source history and measurements are identical. Use a distinct ID for a strategy version with different sizing, equity, trades or costs. Link each portfolio to its exact member histories and evidence.

## Build and check

1. Identify the source for each strategy, portfolio and benchmark. Record the funding mark, currency, session clock, date range, sampling frequency and cost basis. Keep account equity, paper allocations and price proxies identifiable throughout the report. Retain raw marks and evidence for each calculated figure.
2. Add all portfolio and linked strategy records to the same `series` array. Use actual portfolio equity or reconciled member contributions for each portfolio. Build with `python -m lab.performance --config report.json --output results/report.html`. For native Quantreo history, use the strategy or book HTML entry point in the guide.
3. Derive an independent reference from each source ledger. A monthly return uses the change relative to the opening equity. Link cash-flow-adjusted returns when the account has deposits or withdrawals. Check first funding, partial periods, missing observations and a true zero.
4. Run `python -m lab.performance.verify_calendar --html results/report.html --expected monthly-reference.csv --receipt results/calendar-check.json`. This opens both monthly calendars for every interactive series. Check visible signed percentages, declared units and the calendar export. For a hosted report, add `--url` with its address to verify the delivered bytes. The [acceptance guide](../../../docs/report-coverage.md#verify-the-monthly-returns-a-reader-sees) includes a ready-to-run synthetic reference.
5. In Metric explorer, show every measure and source diagnostic together. Change the common rolling window. In a skewed distribution switch between linear and logarithmic count axes. Confirm the bar labels and exports preserve the original observations.
6. For a portfolio with activity data, zoom around a spike, select a region, and pin a date. Reconcile the named strategies, instruments, and intraday contributors with the underlying records. Compare the timestamped intraday line with the closing requirement in USD. Record broker measurements, dated schedule estimates and later-schedule scenarios with their own labels. Identify missing timestamps, contract expiries, or margin data wherever they affect the result.
7. Generate and check an evidence file for each strategy and portfolio. Use `python -m lab.performance.evidence --html results/report.html --series ID --out FILE`, then repeat with `--check FILE` in place of `--out FILE`.
8. Select each requested portfolio in the same dropdown. Verify its equity, members, trades, evidence and any available margin details. Repeat at a narrow viewport on the hosted site if applicable. Check a custom date range, keyboard navigation, and light and dark themes. Report the source coverage and any values that remain unknown.
