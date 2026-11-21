---
name: strategy-report
description: "Write a strategy research note or an interactive Performance Atlas report from saved results. Use for a strategy tear sheet, PDF, HTML dashboard, or post-test report covering returns, drawdowns, costs, robustness and risk."
---

# Strategy report

For an interactive strategy report, generate Performance Atlas from the saved account history. Follow the [HTML reporting guide](../../../docs/performance.md) and run the [visible monthly-return check](../../../docs/report-coverage.md#verify-the-monthly-returns-a-reader-sees) on the delivered file. Use the PDF workflow below when the requested output is a research note.

The reader is a professional deciding what to do with the strategy. They want the worst news first, every claim backed by a number, and a document that looks like a research note, not a dashboard. The script computes every number and every figure; your job is the reading: short, exact paragraphs that say what the tables and figures mean.

1. Run `poetry run python lab/strategy_report.py "<Strategy>" compute`. Then read `results/<strategy>/report/numbers.md`: every number you may write is there.
2. Read in the strategy folder, and nothing else: the index, 1.1 (mechanism, payer, sources) and 1.4 to 1.5 (universe, base version, costs) of `Pass 1.md`, the verdict lines of `Pass 2.md` and `Red team.md`, and `Test.md` if it exists.
3. Write `results/<strategy>/report/text.md` with one `## <key>` heading per section, in this order: `abstract`, `hypothesis`, `method`, `performance`, `exposure` (only if numbers.md has an exposure section), `sources`, `concentration`, `implementation`, `robustness`, `luck`, `risks`, `decision`. What each section says, and how to adapt it to the market, is in `reference/sections.md`. `reference/example-text.md` (Crypto Thin Losers) is the bar to meet.
4. Run `poetry run python lab/strategy_report.py "<Strategy>" build`. It writes `<Strategy> - Report.pdf` next to the sheet.
5. Open the PDF and read every page. Check that each number in the text is the one in numbers.md, that nothing overflows, and that the text and the figures say the same thing. Fix `text.md` and build again if needed.
6. Reply in two lines: the path of the PDF and the bold sentence of the abstract.

## Rules

- Numbers come only from numbers.md, the sheet or Test.md, rounded as there. You read, you never compute. A number that is not there stays out.
- Paragraphs, not bullets: three to six sentences a section, plain and precise, like a researcher writing for a colleague. Name the table or figure only when it helps.
- The abstract carries one sentence in bold (`**...**`): the findings that weigh most against the strategy. A report that hides its worst number is worse than none.
- The report describes one strategy. Correlations to other strategies and what a book needs belong to the portfolio manager's report, not here.
- Never open the test period: the script reads it only after `lab/run_test.py`.
- If `build` says no LaTeX engine is found, tell the user to run `brew install tectonic` once.
- Write in English. Never use a long dash.
