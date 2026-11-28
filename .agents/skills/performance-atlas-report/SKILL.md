---
name: performance-atlas-report
description: Build, audit, or update an interactive Performance Atlas HTML report for saved strategy and portfolio histories. Use for equity, calendar returns, drawdown, distributions, portfolio activity, or margin drill-down.
---

# Build and verify a performance report

## Select the release

If this operation already resolved a GitHub revision, open its immutable `skill_url`. If you are reading that copy now, use its revision as `FULL_SHA` and continue with the report. The next separate build starts a new lookup.

For a new build or rebuild without a pin for this operation, fetch the standalone launcher and resolve the current `codex/performance-report` head once. Start here even when using `main`, an installed skill or a saved project pin.

```sh
curl -fsSL https://raw.githubusercontent.com/nishantpatel9999/performance-atlas-dashboard/refs/heads/codex/performance-report/scripts/atlas_release.py -o atlas_release.py
python atlas_release.py resolve
```

Read the skill at the returned immutable `skill_url` and continue at **Report scope**. Use the resolved 40-character `revision` for `FULL_SHA` below and for all checks in this operation. Read linked guides at that revision. If GitHub is unavailable, report that latest could not be verified. Use a historical revision only for explicitly requested reproduction. Finished HTML remains readable offline.

Use project-relative or absolute paths. GitHub supplies only public release files. Process private inputs locally. Keep the report local unless the user requests hosting or sharing.

## Report scope

- Put every requested portfolio from the same project in one report. Give each one an option in the same **Portfolio** dropdown. If the user requests hosting, give them one website address.
- For a request for links to each portfolio, use links to selections in the shared site when available. Create separate reports only if the user requests separate deliverables or access rules require them.
- Give each portfolio a unique ID. Reuse a strategy ID when the source history and measurements are identical. Use a distinct ID for a strategy version with different sizing, equity, trades or costs. Link each portfolio to its exact member histories and evidence.
- For a portfolio of futures strategies, state its funding model, capital step per contract and margin evidence, applying [the portfolio sizing guide](../../../docs/portfolio-sizing.md). Record the sizing inputs: dated margin source, per-contract drawdown and daily profit-and-loss variation. Label every deviation as a choice with its reason. A portfolio without sizing records is missing inputs; name what is missing and which results that affects.

## Build and check

For large reports, `python atlas_release.py --revision FULL_SHA batch STEPS.json` reuses one verified snapshot for all strategies and checks. The optional batch takes a local JSON array of argument lists. Each list starts with `"build"`, `"verify-calendar"` or `"evidence"`.

1. Identify the source for each strategy, portfolio and benchmark. Record the funding mark, currency, session clock, date range, sampling frequency and cost basis. Keep account equity, paper allocations and price proxies identifiable throughout the report. Retain raw marks and evidence for each calculated figure.
2. Add all portfolio and linked strategy records to the same `series` array. Use actual portfolio equity or reconciled member contributions for each portfolio. Build with `python atlas_release.py --revision FULL_SHA build --config CONFIG --output HTML`. For native research-pipeline runs, load the pinned engine with the actual project's data root. Check the resolved vault and saved-run paths against the [reporting guide](../../../docs/performance.md#native-research-pipeline-runs).
3. Derive an independent reference from each source ledger. A monthly return uses the change relative to the opening equity. Link cash-flow-adjusted returns when the account has deposits or withdrawals. Check first funding, partial periods, missing observations and a true zero. Reconcile the Year return column to the year’s actual opening and closing equity. For each Average cell, verify the arithmetic mean, account-unit change and sample count across complete matching periods in the full series. Include measured zeroes. Exclude incomplete periods and gaps. Repeat with a date filter and on the four-year Overview preview.
4. Run `python atlas_release.py --revision FULL_SHA verify-calendar --html HTML --expected CSV --receipt RECEIPT`. Use an independent CSV with columns `series_id,month,return_fraction`. This opens both monthly calendars for every interactive series. Check visible signed percentages, declared units and the calendar export. For a hosted report, add `--url` with its address to verify the delivered bytes. The [acceptance guide](../../../docs/report-coverage.md#verify-the-monthly-returns-a-reader-sees) includes a ready-to-run synthetic reference.
5. In Metric explorer, show every measure and source diagnostic together. Change the common rolling window. In a skewed distribution switch between linear and logarithmic count axes. Confirm the bar labels and exports preserve the original observations.
6. For a portfolio with activity data, zoom around a spike, select a region, and pin a date. Reconcile the named strategies, instruments, and intraday contributors with the underlying records. Compare the timestamped intraday line with the closing requirement in USD. Record broker measurements, dated schedule estimates and later-schedule scenarios with their own labels. Identify missing timestamps, contract expiries, or margin data wherever they affect the result.
7. Generate and check an evidence file for each strategy and portfolio. Use `python atlas_release.py --revision FULL_SHA evidence --html HTML --series ID --out FILE`, then repeat with `--check FILE` in place of `--out FILE`.
   Compare `provenance.report_build` in the evidence with **Build details** in the report. Check the full revision and `YYYY.MM.DD+<first 12 SHA>` version. The UTC committer date determines the release date. `built_utc` records report generation. The ledger dates determine data coverage. A legacy report without identity has an unknown release.
8. Select each requested portfolio in the same dropdown. Verify its equity, members, trades, evidence and any available margin details. On a phone, open the strategy picker and check its count against the available strategies. Swipe a list longer than the screen, select its last entry, and confirm the current view shows that history. Reopen and dismiss it without changing the selection. Repeat on the hosted site if applicable. Check a custom date range, keyboard navigation, and light and dark themes. Report the source coverage and any values that remain unknown.
