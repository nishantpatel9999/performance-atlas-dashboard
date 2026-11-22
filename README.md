# Performance Atlas Dashboard

**Performance Atlas Dashboard** is the reporting product in this fork of `Quantreo/ai-quant-pod`. The upstream research workflows remain available in the repository. Open the example, switch between Portfolio and Strategy, and choose a series. The same controls work across instrument types, trading frequencies and strategy families.

AI coding assistant: **OpenAI Codex, GPT-6 Luna**.

[Copy the AI agent prompt](#create-a-report-with-an-ai-agent) · [Open the standalone example](examples/performance/report.html) · [Reporting guide](docs/performance.md) · [Example input manifest](examples/performance/report.json)

![Portfolio overview with an equity curve, annual returns and drawdown history](docs/performance-preview.png)

## Create a report with an AI agent

Copy this prompt into an agent that can read your files and run commands. Replace the bracketed fields with your project and output locations.

```text
Build an offline, interactive Performance Atlas report from [my project folder
or attached results]. Save it in [output folder, default results/performance-atlas/
inside my project].

1. For each new build or rebuild, resolve the current codex/performance-report
   revision from GitHub once, even from main, an installed skill or a project pin.
   If this operation already has that pin, continue with it. Otherwise, download
   the standalone launcher and resolve the release.
   curl -fsSL https://raw.githubusercontent.com/nishantpatel9999/performance-atlas-dashboard/refs/heads/codex/performance-report/scripts/atlas_release.py -o atlas_release.py
   python atlas_release.py resolve
   Use the returned immutable skill_url for SKILL.md below. Use the 40-character
   revision for FULL_SHA and the following upstream references. Keep private inputs
   local when fetching public release files. If lookup fails,
   report that latest is unverified. Use a historical pin only if I request reproduction.
   Read CLAUDE.md, .agents/skills/performance-atlas-report/SKILL.md,
   docs/performance.md and docs/report-coverage.md. Use the data-check,
   analyze-backtest, strategy-report and portfolio-manager skills under
   .claude/skills/ as read-only references. For Quantreo projects, use
   vault/README.md to locate saved trials, reviews and stress tests.

2. Identify the markets, dates, funding, cash flows, currencies, trading
   sessions, sampling frequency and costs. Label live, paper and backtest
   results. Distinguish training, validation and published out-of-sample
   results. Keep unopened tests sealed. Use actual portfolio equity or
   reconciled member contributions. If inputs are missing, show what you can
   verify and name the exact files or columns needed.

3. For each strategy and portfolio, show equity, total return, compound annual
   growth rate (CAGR), mean return of complete calendar years, signed monthly
   percentage returns, drawdown depth and recovery. Plot six-month rolling
   maximum drawdown and rolling Sharpe, Sortino, Calmar and volatility. Include
   win rate, expectancy, profit factor, costs, compatible benchmark comparisons
   and a strategy correlation matrix with matched observation counts.

4. Put all Metric Explorer charts on one page with one window selector. Use a
   logarithmic count axis for skewed histograms and retain the raw counts.
   Include hover definitions and system, light and dark themes. Where records
   permit, chart daily active strategies and overlay intraday and overnight
   margin in USD. Let me zoom and select a date to see active strategies and
   contracts. At a spike, name contributors supported by that timestamp.
   Label broker measurements, dated estimates and later-rate scenarios.
   Show gaps for missing observations.

5. Run these commands using my project’s paths and IDs. Project-relative paths work.
   For native Quantreo runs, use the pinned engine with my actual project’s data root.
   Use Python 3.12+, Node.js, and Playwright with Chromium for verification.
   python atlas_release.py --revision FULL_SHA build --config CONFIG --output HTML

   Independently check ending equity and maximum drawdown against my ledgers.
   Calculate monthly returns from those ledgers. Write a CSV with columns
   series_id,month,return_fraction for every strategy and portfolio.
   python atlas_release.py --revision FULL_SHA verify-calendar --html HTML --expected CSV --receipt RECEIPT

   Generate and verify a distinct evidence FILE for each strategy and portfolio ID.
   python atlas_release.py --revision FULL_SHA evidence --html HTML --series ID --out FILE
   python atlas_release.py --revision FULL_SHA evidence --html HTML --series ID --check FILE

   For large reports, this optional command reuses one verified snapshot for all strategies and checks.
   python atlas_release.py --revision FULL_SHA batch STEPS.json
   Supply a local JSON array of argument lists. Each starts with "build", "verify-calendar" or "evidence".

Open the finished HTML. Test date filters, chart drill-down and data export.
Check the Build details footer against provenance.report_build in the evidence.
Deliver the report, evidence files, full SHA, version, build time, rebuild command and a short summary of
findings and data gaps. Keep my data and report local unless I request sharing.
```

**Report version.** `YYYY.MM.DD+<first 12 SHA>` uses the UTC committer date and needs no tag or manual bump. **Build details** records the release and the UTC report build time. The input records supply the data dates. A legacy report without build identity has an unknown release. Saved HTML stays readable offline.

## Open the example

Download the example HTML file and open it in a browser. The charts, settings and data are in that file. To build a fresh copy, use Python 3.12 or later and the FULL_SHA resolved in step 1.

```sh
python atlas_release.py --revision FULL_SHA build --demo --output results/performance/report.html
```

The demo contains four synthetic strategy histories, their funded portfolio and a synthetic benchmark. Open **Activity and margin** to inspect strategy counts and modeled overnight capital for each session. Open **Comparisons** on a strategy to inspect its return correlations with peers. Hover or tap an underlined term for its definition, or search **Glossary**. The appearance menu follows your system by default and also offers **Light** and **Dark**. Each shareable HTML file includes its underlying observations, trade records and source metadata.

## Use your own results

1. Copy the example manifest, its CSV, and the optional [overnight activity example](examples/performance/overnight.json). Give each strategy, portfolio and benchmark a unique ID. Remove the `activityFile` entry to use only equity histories.
2. Supply a performance history, currency, return sampling interval and periods per year for each series. A portfolio accepts the actual portfolio equity or its dated net P&L stream.
3. Use the FULL_SHA from step 1 of the agent prompt to build the report. Open the HTML file in a browser.

```sh
python atlas_release.py --revision FULL_SHA build --config examples/performance/report.json --output results/my-report.html
```

The portable builder uses the Python standard library. The Quantreo adapters use the upstream research environment. Both routes produce the same interface. The report also accepts optional benchmark, trade, cost, exposure and custom metric data. [Inputs, native commands and calculation methods](docs/performance.md)

The upstream project contains the research workflow, backtest engine, strategy examples, and construction and review processes. [Quantreo/ai-quant-pod](https://github.com/Quantreo/ai-quant-pod)
