# Performance Atlas reporting guide

One HTML file holds the data, calculations and charts. It opens from disk and works without a server. Generate a separate file for each dataset you want to share. A recipient can read all embedded records, including trade histories and source metadata. The synthetic example includes a [reproducible evidence manifest](../examples/performance/research_tests/manifest.json).

## Choose a view

| View | Questions it answers |
| --- | --- |
| Overview | How did capital grow? Read CAGR, maximum drawdown and Sharpe together. Inspect the full equity path in source units or indexed to 100. |
| Drawdowns | How deep was each loss? When did it start, bottom, and recover? Read its depth in percent and source units, and compare net gains with the largest cash loss using recovery factor. Compare underwater drawdown, maximum drawdown to date and the worst loss inside a rolling window. |
| Rolling metrics | Did performance persist? Explore trailing return, volatility, Sharpe, Sortino, Calmar and maximum drawdown. The default is six calendar months. |
| Calendar returns | Which years and months contributed? Compare each year's return, maximum drawdown and Sharpe. Read the mean of complete years separately from full-period CAGR. |
| Trades and costs | Inspect trade P&L, win rate, profit factor, payoff, expectancy, win and loss streaks, holding time, long and short results, and recorded costs. |
| Metric explorer | Chart an individual metric, inspect its distribution and download its dated values. Add your own measured series, such as net exposure or turnover. |
| Comparisons | Filter the strategy scorecard by name, family or asset class. Compare two indexed capital paths on a common window. Inspect correlation, beta, alpha, tracking error, information ratio, capture and rolling correlation. A portfolio can also show construction weights, strategy correlations and reconciled contributions. |
| Evidence and methods | Check the capital basis, cost assumptions, timestamps, sample size, gaps, calculation conventions and research-test coverage. |

Use **Settings** to change the date range, rolling window, annual risk-free rate or downside target. Use a chart's pointer or left and right arrow keys to inspect individual marks. **Export data** downloads the selected equity and drawdown series. In Metric explorer it downloads the selected metric. Source totals retain their original dates.

## Connect a project

Start with [the example manifest](../examples/performance/report.json) and [its monthly CSV](../examples/performance/monthly-marks.csv). Run the following command from the repository root.

```sh
python3 -m lab.performance --config examples/performance/report.json --output results/example.html
```

Each series has a unique `id`, a display `name`, a `kind` of `strategy`, `portfolio` or `benchmark`, a `currency`, a sampling `frequency` and `periodsPerYear`. Set `currency` to `INDEX` for dimensionless capital. A report can include multiple portfolios, benchmarks, strategy families, asset classes and overlapping histories. A currency-denominated benchmark can represent 100 units of that currency invested at its opening mark.

| Input mode | Supply | Equity calculation |
| --- | --- | --- |
| `equity` | Dated equity or unitized net asset values, including the funded opening mark | Use the recorded values. |
| `returns` | Dated net simple returns, opening capital and opening date | Multiply each prior balance by one plus the net return. |
| `contributions` | Dated net P&L as a fraction of initial capital, opening capital and opening date | Add each contribution times the original capital. |

Set `csv` to a path relative to the manifest. CSV headers default to `date,equity` for equity and `date,net` for returns or contributions. Use `dateColumn` and `valueColumn` to select different fields. Return modes require `openingCapital` and `openingDate`. Use decimals for returns, such as `-0.012` for a 1.2% loss. Supply unitized equity or an equivalent time-weighted return history when the account has external deposits or withdrawals.

UTC dates such as `2025-01-31` describe daily marks. Use a timestamp with an explicit offset for intraday marks. Mark times must be strictly increasing. The first mark has positive capital. A capital path ends at its first nonpositive mark. A terminal loss can exceed 100% if the source records negative equity.

**Mark frequency and trade frequency are separate.** The report uses every supplied mark for equity and drawdown. It uses UTC period closes for return ratios. Set `frequency` to `daily`, `weekly`, `monthly` or `annual`, and set the matching annualization factor for that series. An intraday strategy can supply minute marks with daily return sampling. A monthly strategy can supply daily marks if the account was valued each day. Set `sessionDates` to a sorted array of ISO session dates for a specific exchange's daily calendar. Without a supplied calendar, the methods panel describes the gap rules.

**Currency conversion.** Combine funded positions in a common currency. To convert a CSV equity path, specify `sourceCurrency`, output `currency` and `fxColumn`. Each FX value is units of output currency per unit of source currency at that mark. Return streams also require `openingFxRate`. Supply trade P&L and costs in the output currency, with units recorded. Factor and market benchmark comparisons need compatible intervals and return bases.

A Python producer can bypass CSV and call the same builder with a validated bundle. Here `times` contains integer Unix milliseconds in UTC and `equity` contains the corresponding values.

```python
from lab.performance import render_bundle

render_bundle({
    "version": 1,
    "title": "Research account",
    "series": [{
        "id": "book", "name": "Combined portfolio", "kind": "portfolio",
        "currency": "USD", "frequency": "monthly", "periodsPerYear": 12,
        "times": [1735603200000, 1738281600000, 1740700800000],
        "equity": [100000, 101200, 100600],
    }],
}, "results/portfolio.html")
```

## Add evidence and measurements

| Input | Use |
| --- | --- |
| `assetClass`, `family`, `accounting`, `status`, `costModel`, `source`, `notes` | Describe instruments, capital, simulated or live history, fees and evidence quality. |
| `benchmarkId` | Reference a benchmark history in the same manifest. Choose a benchmark appropriate to the strategy or portfolio. |
| `tradesCsv` | CSV with `time,pnl` for each closed trade. Optional `side` and `holdingHours` columns enable side and holding-time analysis. An inline `trades` array uses epoch milliseconds. |
| `tradeSummary`, `costs`, `sourceMetrics` | Full-history source figures. Include cost currency and identify the costs covered by each total. The date filter applies to dated observations. |
| `holdings` | A list of `{"id":"strategy-id","weight":0.30}` objects. State the date and meaning of the snapshot in `evidence.holdingsBasis`, such as ending net equity or target risk budget. |
| `evidence.attribution` | For explicitly funded sleeves, set `{"basis":"funded_equity","members":["trend","carry"]}`. The analyzer checks the currency, dates and portfolio reconciliation before reporting contributions. |
| `diagnostics` | Additional dated measurements for each strategy or portfolio. Each record has `name`, `unit`, optional `description`, and `times` and `values` arrays or a relative CSV. Unit `%` takes fractions. Missing values appear as gaps. |
| `evidence` | Attach run version, rules, time splits, cost assumptions, capacity estimates and completed research tests. [Evidence manifest and coverage](report-coverage.md) |

For example, this diagnostic reads two columns from a local CSV. Use the same pattern for gross or net exposure, turnover, leverage, margin, costs, fill rate or option sensitivities. Keep the actual unit on each measurement.

```json
{"name":"Gross exposure","unit":"%","csv":"exposure.csv","dateColumn":"date","valueColumn":"gross","description":"Absolute market value divided by net asset value."}
```

Some measures need additional evidence before they have a clear interpretation. Liquidity and capacity need order size, market volume and a cost or impact model. Trade excursions need prices while each trade was open. Portfolio contribution needs reconciled component histories. Walk-forward, cost stress, parameter sensitivity and resampling need actual test runs. Use the coverage view to see which records the source supplies.

## Native Quantreo runs

Use the upstream environment for these commands. Supply a saved strategy name. The HTML export reads eligible saved runs and respects the desk's recorded test access.

```sh
python3 -m lab.strategy_report "My strategy" html --output results/strategy.html
python3 -m lab.book_report construct "Research book" html \
  --strategy "Strategy A" --strategy "Strategy B" --currency USD \
  --output results/book.html
```

Native HTML exports infer a Monday–Friday calendar when marks span at least 14 days, cover all five weekdays and contain no weekends. Use `--calendar weekday` to select 252 periods per year, or `--calendar daily` to select seven-day sampling at 365. For exchange holidays and other schedules, use `--session-dates sessions.json` with an object containing `sessionDates` and `periodsPerYear`. The report records the source of its calendar assumption and counts missing expected sessions. Native book sizing retains the desk's 365-period convention.

Native P&L is recorded as a contribution to initial capital. The HTML report also computes account-level returns from the resulting equity marks. The native desk's annual mean contribution and an equity CAGR answer different questions. Its target risk weights describe construction, while cash portfolio weights require actual funded positions. Use the generic CSV route to display a separately generated portfolio or historical allocation decision.

## Calculation references

The Sharpe calculation uses excess returns and the sample standard deviation. The Sortino calculation uses the full sample's root mean square shortfall below the chosen target. The report shows the annualization factor, calendar, and active rates with the source data. [William F. Sharpe, The Sharpe Ratio](https://web.stanford.edu/~wfsharpe/art/sr/sr.htm) · [CFA Institute, The Sortino Ratio](https://rpc.cfainstitute.org/-/media/documents/code/gips/the-sortino-ratio.pdf)
