# Report evidence

The standalone HTML contains its data and runs offline. A companion research manifest records the evidence for one series across its full history. Python and Node.js generate the manifest using the same numeric code as the browser.

## Reproduce the example

Run these commands from the checkout.

```sh
python -m lab.performance --demo --output results/demo/report.html
python -m lab.performance.evidence --html results/demo/report.html
python -m lab.performance.evidence --html results/demo/report.html --check results/demo/research_tests/manifest.json
```

For a portfolio with an activity ledger, `session_activity` reports the number of dated observations, the share of measured sessions with an active strategy and peak USD requirements for each reported basis.

The default series matches the initial report view. Use `--series ID` for another series and `--out FILE` for its manifest. The command records the HTML hash, embedded JSON hash, code hashes, return intervals, and original equity marks. The example also records its generator hash and seed after reproducing the embedded bundle.

For the independent document check, set `REPORT_PREFLIGHT` to your installed master-quant-validator `scripts/report_preflight.py`. Run the checker on both files.

```sh
python "$REPORT_PREFLIGHT" results/demo/research_tests/manifest.json --html results/demo/report.html --pretty
```

`--check` recomputes the manifest and checks the report binding. The independent checker inspects coverage, result records, and static HTML. Its table count covers tables present in the HTML source. Browser tests can also inspect tables created by JavaScript.

To check each rendered view, use Python with Playwright and Chromium installed. Keep `REPORT_PREFLIGHT` set in the environment.

```sh
PERFORMANCE_REPORT_HTML=results/demo/report.html \
PERFORMANCE_VIEW_RECEIPT=results/demo/rendered-preflight.json \
PERFORMANCE_SERIES_RECEIPT=results/demo/series-preflight.json \
python -m unittest discover -s tests -p test_performance_evidence.py
```

## Verify the monthly returns a reader sees

Keep an independent monthly reference for every interactive strategy and portfolio. Derive it from the original equity or net-return ledger before opening the generated report. Apply each series’ session dates, currency, cash-flow treatment and opening balance. For example, an account rising from 100 to 102 earns 2%. A subsequent fall from 102 to 96 loses 5.88%.

For a funded account without external cash flows, divide the closing equity by the opening equity and subtract one. For cash flows, use a unitized equity series or compound the dated, cash-flow-adjusted returns. A fixed-capital P&L contribution first changes the equity path. Measure its return against that month’s opening equity. Keep cash changes, index points and percent returns in separate fields.

Save the reference as a CSV with one row per measured month. A return is a fraction. Zero records an observed flat month. Leave a missing return blank or omit its row. Use the same series IDs as the report. Include a blank row for a series without any measurable month.

```csv
series_id,month,return_fraction
strategy-a,2024-01,0.02
strategy-a,2024-02,-0.0588235294117647
strategy-a,2024-03,0
strategy-a,2024-04,
```

Run this command with Python Playwright and Chromium installed. Supply a local Chrome executable through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if needed.

```sh
python -m lab.performance.verify_calendar --html results/report.html --expected monthly-reference.csv
```

Try the complete example using the two funded sleeves in this checkout. Its reference uses the original monthly closing balances.

```sh
python -m lab.performance --config examples/performance/report.json --output results/sleeves.html
python -m lab.performance.verify_calendar --html results/sleeves.html --expected examples/performance/monthly-reference.csv
```

The check reads the percentage printed in each cell and compares it with the reference at display precision. It checks the full-precision fraction separately. It selects each portfolio and strategy in both Overview and Calendar returns. Use `--receipt calendar-check.json` to retain the result. The master-quant-validator release check accepts this file through `--calendar-receipt calendar-check.json`. Add `--url YOUR_REPORT_URL` to verify that the delivered site serves the same HTML. A disagreement exits with an error and identifies the series, view and month.

For a changed reporting implementation, also exercise a date filter, keyboard focus and a narrow screen. Check a gain, a loss, a flat month, an absent month and a partial boundary. Confirm that the calendar download retains full precision and names the account unit. Compare activity, trades, costs and benchmarks over the dates their source actually covers.

For Metric explorer, verify that every applicable measure and custom diagnostic appears on the same page. Change its single rolling window. Check that both count-axis scales preserve bin membership, exact counts and zeros. For Activity and margin, zoom around a spike, select a session and compare the named strategies and contracts with its ledger. Check a timestamped intraday point, an overnight reference and a missing session. Include a position that closes intraday. Identify any later-schedule scenario in the graph and export.

## Supply research evidence

Each canonical series accepts an optional `evidence` object. Supply only fields your source records.

| Field | What to supply |
| --- | --- |
| `runId`, `version`, `rules`, `instrument` | Run identifier, frozen rule version, rule reference, and traded instrument or universe. |
| `execution`, `seed`, `splits` | Signal and fill timing, source seed or deterministic declaration, and actual research dates or holdout design. |
| `provenance` | Source metadata, including `runCommand`, `dataVintage`, `searchSpace`, `codeVersion`, and artifact references. |
| `exposure` | Measured values and their basis. Use `time_in_market_pct`, `avg_gross_exposure`, `avg_net_exposure`, `max_gross_exposure`, `trade_count`, or `turnover_annual`. Exposure fractions use 1 for 100%. |
| `sourceHorizon` | An object with `start` and `end` in UTC epoch milliseconds for source totals. Set `tradeCoverage` to `partial` for incomplete dated trades. |
| `results` | Research test records. Supply a family, status, settings, seed, cost model, data source, and measured outcomes. A `not_run` record needs a reason. |

Set `series.costModel` to the source cost convention. Supply measured amounts and their currency in `series.costs`. Dated trades use close times and signed realized P&L. A full-source summary belongs in `series.tradeSummary`. The audit preserves full-source totals when the visible account stops at capital exhaustion.

For a complete source manifest, bind its exact bytes before rendering the report.

```python
from pathlib import Path
from lab.performance.build import render_bundle
from lab.performance.evidence import attach_source_manifest, build_manifest
from lab.performance.inputs import load_config

bundle = load_config(Path("bundle.json"))
source = Path("research-run.json")
selected = bundle["series"][0]
bundle["series"][0] = attach_source_manifest(selected, source)
html = render_bundle(bundle, Path("report.html"))
manifest = build_manifest(html, series_id=selected["id"], source_manifest=source)
```

`attach_source_manifest` returns a new series. It embeds the supplied results, source filename, and SHA-256. Keep the source file with the report. Use a source manifest with one baseline and inline result records for the selected series. The browser can show the results in its Evidence and methods view.

```sh
python -m lab.performance.evidence --html report.html --source-manifest research-run.json
python "$REPORT_PREFLIGHT" research_tests/manifest.json --html report.html
python "$REPORT_PREFLIGHT" research-run.json --html report.html
```

## Interpret coverage

Each of the 79 registry entries points to a datum or gives its reason for absence. Use the opening mark and all later marks for drawdown. Risk ratios use valid UTC period closes. The benchmark section records the number of matched return intervals. The manifest records separate source fields for costs, exposure, source test outcomes, and allocation weights.

A dated diagnostic named `Gross exposure` or `Net exposure` can supply measured exposure. Use unit `%` with fractional values at every account mark. The audit records the mean and extreme exposures. It also counts observed days with a positive gross position. A cost ratio derived from the trade ledger divides recorded total costs by the sum of positive realized trade outcomes.

The winning-trade test needs a complete dated ledger. Supply the matching total trade count or set `tradeCoverage` to `complete`. The audit removes positive trade outcomes in descending order, up to 5% of all closes rounded up. The result lists the exact source indices and the change in closed-trade P&L. An execution replay would be necessary to measure drawdown for the altered strategy. A supplied winner-removal test takes precedence.

Keep the audit manifest next to its source report when sharing. Review the evidence fields and source references you choose to include.
