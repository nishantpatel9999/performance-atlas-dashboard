# Performance Atlas Dashboard

**Performance Atlas Dashboard** is a complete systematic trading research system. It covers the full path from a trading idea to a verified performance report: a research pipeline run by AI agents, a shared research vault, a Python backtesting and analysis library, a portfolio construction process, and an interactive offline reporting layer with independent verification.

AI coding assistant: **OpenAI Codex, GPT-6 Luna**.

[Copy the AI agent prompt](#create-a-report-with-an-ai-agent) · [Open the standalone example](examples/performance/report.html) · [Reporting guide](docs/performance.md) · [Portfolio sizing guide](docs/portfolio-sizing.md) · [Example input manifest](examples/performance/report.json)

![Portfolio overview with an equity curve, annual returns and drawdown history](docs/performance-preview.png)

## What the system does

The project has two halves that share one method: write what you expect before you look at the result.

1. **The research pipeline** turns sources and ideas into tested strategies. AI agent seats read papers, write technique cards, propose ideas, check data, build strategies, attack them in review, and run sealed out-of-sample tests exactly once. Every run is logged, including the failures.
2. **The reporting layer** turns saved results into one interactive HTML file per project: equity, drawdowns, rolling metrics, calendar returns, trade statistics, costs, correlations, activity and margin. Every visible number can be verified against the original records, and every series carries a machine-checkable evidence file.

## Components

| Component | What it holds |
| --- | --- |
| `vault/` | The shared memory of the research pipeline: reading notes, technique cards, idea journal, strategy sheets, research log, the portfolio book, and the toolbox of defaults and policies. Start with `vault/README.md`. |
| `.claude/agents/` | The research seats: scout, reader, ideator, economist, critic, data, developer, analyst, red team and portfolio manager. One file per seat describes its job, tools and model. |
| `.claude/skills/` | The procedures each seat loads: read a paper, write a technique card, judge an idea, check data, build a strategy, review it, red-team it, report it, construct the book. |
| `.agents/skills/` | The reporting skill an AI coding agent uses to build, verify and evidence a performance report. |
| `lab/` | The Python library: universe, signal, sizing, backtest, diagnostics, trials, sealed-test runner, strategy and book reports, and the performance report builder. Agents call it; they never rewrite it during a build. |
| `data/` | Download scripts for market data. The data itself is built on each machine and read only. |
| `strategies/`, `results/` | One file per strategy, and every saved run. |
| `case-studies/` | Complete worked examples of the pipeline, from first idea to final report. |
| `docs/` | The guides: reporting, report evidence, and portfolio capital and contract sizing. |
| `examples/performance/` | A synthetic report example with its input manifest, CSV and overnight activity file. |
| `scripts/atlas_release.py` | The standalone launcher that resolves, verifies and runs a pinned reporting release. |

## The research pipeline

```
Library (run by hand):  Scout -> Reader -> Technique cards

The desk (/desk):       Ideator -> Economist -> Data -> Developer (train gate)
                        -> Critic -> Economist -> Developer (validation)
                        -> Analyst + Red team -> [you approve the tests]
                        -> sealed test -> Analyst -> report -> Portfolio manager
```

Each seat writes its output into a precise place in the vault, and the next seat reads it from there. The user steps in twice: the theme at the start, and one approval of the batch of sealed tests near the end. Everything else runs on the defaults in `vault/Toolbox/Defaults.md`.

Four rules are not negotiable:

1. The first pass of a strategy is written before any code is written for it.
2. Every backtest run is saved and logged, especially the bad ones.
3. The test period is opened once, only after approval.
4. Entries, weights and exits of the portfolio book change only in the monthly slot, on the user's decision.

## Portfolio construction and sizing

The portfolio manager seat reviews candidates against the existing book and constructs new books from tested strategies. Its reports read correlations over time, hidden market exposures and stress episodes, computed the same way every time so two candidates are judged alike.

For futures portfolios, [the portfolio sizing guide](docs/portfolio-sizing.md) defines how much capital stands behind each contract, when contract counts rise and fall, and how much capital the whole portfolio needs. It covers margin stress, drawdown reserves, siloed and pooled funding, concentration checks, deleveraging, micro contracts and the sizing evidence a report must show. The same method sizes the portfolio in the report and in the account, so the report stays an honest preview of the account.

## The reporting layer

One HTML file holds the data, calculations and charts. It opens from disk and works without a server. Each shareable file includes its underlying observations, trade records and source metadata. The views cover:

- **Overview**: equity growth, CAGR, maximum drawdown and Sharpe, in source units or indexed.
- **Drawdowns**: depth, duration and recovery of every loss episode, underwater curves and rolling windows.
- **Rolling metrics**: trailing return, volatility, Sharpe, Sortino, Calmar and maximum drawdown.
- **Activity and margin**: active strategy counts and overnight capital requirements per session, with drill-down to the positions and contributors at any spike.
- **Calendar returns**: signed monthly and yearly percentage returns with full-history averages.
- **Trades and costs**: profit factor, expectancy, streaks, holding times, concentration and recorded costs.
- **Metric explorer**: every measure and custom diagnostic with distribution charts and export.
- **Comparisons**: correlation matrices, beta, alpha, capture, rolling correlation, construction weights and reconciled member contributions.
- **Evidence and methods**: capital basis, cost assumptions, timestamps, gaps, conventions and research-test coverage.

Reports support system, light and dark themes, phone layouts, keyboard navigation, hover definitions and a searchable glossary.

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
   docs/performance.md, docs/report-coverage.md and docs/portfolio-sizing.md.
   Use the data-check, analyze-backtest, strategy-report and portfolio-manager skills under
   .claude/skills/ as read-only references. For projects built with this research
   pipeline, use vault/README.md to locate saved trials, reviews and stress tests.

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

4. For futures contract portfolios, state the funding model, capital step per
   contract and margin evidence. Use siloed or pooled funding with documented
   stress margins, drawdown reserves and utilization ceilings. Label every
   deviation as a choice with its reason.

5. Put all Metric Explorer charts on one page with one window selector. Use a
   logarithmic count axis for skewed histograms and retain the raw counts.
   Include hover definitions and system, light and dark themes. Where records
   permit, chart daily active strategies and overlay intraday and overnight
   margin in USD. Let me zoom and select a date to see active strategies and
   contracts. At a spike, name contributors supported by that timestamp.
   Label broker measurements, dated estimates and later-rate scenarios.
   Show gaps for missing observations.

6. Run these commands using my project's paths and IDs. Project-relative paths work.
   For native research-pipeline runs, use the pinned engine with my actual project's data root.
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

Open the finished HTML. Select every portfolio in the same Portfolio dropdown.
Check its equity, members and available evidence against my records. Repeat
this check at the website address if hosted, including at phone width.
Test date filters, chart drill-down and data export.
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

The portable builder uses the Python standard library. The native research-pipeline adapters use the research environment. Both routes produce the same interface. The report also accepts optional benchmark, trade, cost, exposure and custom metric data. [Inputs, native commands and calculation methods](docs/performance.md)

## Documentation map

- [Reporting guide](docs/performance.md): inputs, views, calculation methods, activity and margin, native pipeline runs.
- [Report evidence and coverage](docs/report-coverage.md): evidence files, verification commands, acceptance checks.
- [Portfolio capital and contract sizing](docs/portfolio-sizing.md): capital steps, funding models, margin stress, deleveraging, sizing evidence.
- [Vault README](vault/README.md): the research vault and its folders.
- [CLAUDE.md](CLAUDE.md): the research seats, the pipeline and the house rules.
- [Case studies](case-studies/README.md): complete worked examples.
