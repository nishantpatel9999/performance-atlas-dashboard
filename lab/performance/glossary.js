/* Offline reader help. Each row contains a term, its meaning in Atlas, and its display aliases. */
(() => {
  "use strict";

  const dictionary = [
    // Returns, capital and units.
    ["CAGR", "Compound annual growth rate. It is the constant yearly rate that connects opening and closing equity over the elapsed time.", "Annual growth (CAGR)", "Compound annual growth (CAGR)", "Full-period CAGR", "Annualized compound growth", "Compound annual growth rate"],
    ["Total return", "The change from opening equity to closing equity, divided by opening equity.", "Holding-period return"],
    ["Return", "The gain or loss over one interval, as a fraction of its opening value.", "Returns", "Simple return", "Period return"],
    ["Log return", "The natural logarithm of closing value divided by opening value. Log returns add across consecutive intervals with positive values.", "Cumulative log return", "Logarithmic return", "Log returns"],
    ["Compound return", "Growth when each period's gain or loss changes the capital used for the next period.", "Compounded returns", "Compounding", "Reinvested returns"],
    ["Equity", "The value left in the account after subtracting its liabilities. It includes gains and losses on open positions when the source marks them.", "Account equity", "Equity balance"],
    ["Opening equity", "The account value used as the starting point for a measurement.", "Opening capital", "Starting equity", "Starting capital", "Opening balance"],
    ["Closing equity", "The account value at the last mark in the selected interval.", "Ending equity", "Ending capital", "Closing balance"],
    ["Change in equity", "Closing equity minus opening equity, in the units supplied by the source.", "Net change in equity"],
    ["Equity mark", "An account value recorded at a particular time. A chart can only show losses visible at its recorded marks.", "Equity marks", "Opening mark", "Closing mark", "Marks"],
    ["Equity curve", "The account's value at successive recorded times.", "Equity history", "Equity path"],
    ["Indexed equity", "Equity rescaled to start at 100. An index value of 108 means an 8% gain from the opening value.", "Equity index", "Indexed comparison", "Indexed performance", "Growth of 100", "Index"],
    ["Source units", "The units in which the source recorded the values, such as dollars, contracts, or index points.", "Source currency", "Currency or unit"],
    ["NAV", "Net asset value. It is the value of assets less liabilities. A per-unit NAV divides that value by the number of units.", "Net asset value"],
    ["USD", "United States dollars. A value in USD is a money amount.", "US dollar", "U.S. dollars"],
    ["FX", "Foreign exchange. An FX rate converts an amount from one currency into another.", "Foreign exchange", "FX rate", "Currency conversion"],
    ["P&L", "Profit and loss. A positive amount is a gain and a negative amount is a loss.", "PnL", "Profit and loss", "Profit or loss", "P/L"],
    ["Cash P&L", "The gain or loss expressed in money. The currency and the source's cost treatment determine how to read it.", "Cash PnL", "Dollar P&L", "Monetary P&L"],
    ["Net P&L", "Profit or loss after the costs included by the source.", "Net Pnl", "Net profit", "Net trading P&L"],
    ["Gross P&L", "Profit or loss before the costs identified by the source.", "Gross Pnl", "Before reported costs"],
    ["Fixed initial capital", "The original capital amount stays fixed when converting each P&L contribution into money.", "Fixed-capital contributions", "Fixed capital", "Fixed-capital", "Net contributions"],
    ["Capital basis", "The capital amount against which the source measures a gain, loss or position.", "Accounting basis", "Measurement basis"],
    ["External cash flow", "Money added to or withdrawn from an account by its owner.", "External cash flows", "Deposits and withdrawals"],
    ["Unitized equity", "Account value per unit. Issuing or redeeming units separates deposits and withdrawals from investment performance.", "Unitized NAV", "Unitized"],
    ["Time-weighted return", "Growth across successive periods after splitting the history at external cash flows.", "TWR", "Time-weighted returns"],
    ["Basis point", "One hundredth of a percentage point. A cost of 10 basis points is 0.10%.", "Basis points", "bp", "bps"],
    ["Percentage point", "The difference between two percentages. A rise from 2% to 3% is one percentage point.", "Percentage points", "pp"],
    ["Annualization", "Expressing a measure on a yearly basis. The report uses elapsed time for CAGR and periods per year for return ratios.", "Annualized", "Annualised", "Periods per year", "Annualization factor"],
    ["Calendar return", "Growth between the opening and closing marks for a calendar period.", "Calendar returns", "Annual returns", "Calendar year returns", "Monthly returns", "Daily returns", "Weekly returns", "Year-by-year performance"],
    ["Mean full-year return", "The arithmetic average of the individual returns for complete calendar years.", "Mean calendar-year return", "Full-year averages"],
    ["Full year", "A calendar year with both boundaries and sufficient observations under the series calendar.", "Complete years", "Complete calendar years"],
    ["Partial coverage", "Only part of the period has the observations needed to measure it.", "Partial year", "Partial years", "Partial ledger", "Partial history"],
    ["YTD", "Year to date. The selection starts on January 1 of the final observed year, or at the first available mark if later.", "Year to date", "Year-to-date"],
    ["Date range", "The start and end dates included in the analysis.", "Analysis period", "Selected period", "Selected dates", "Recorded interval", "Custom date range"],
    ["1Y", "The trailing one-year date range.", "1 year"],
    ["3Y", "The trailing three-year date range.", "3 years"],
    ["5Y", "The trailing five-year date range.", "5 years"],
    ["UTC", "Coordinated Universal Time. Atlas uses this shared clock to assign observations to dates.", "Coordinated Universal Time", "Timestamp UTC"],
    ["Timestamp", "The date and time attached to an observation.", "Timestamps", "Epoch milliseconds"],
    ["Session", "One trading period on the calendar used by the source.", "Sessions", "Exchange sessions", "Trading session", "Supplied exchange sessions"],
    ["Close-to-close return", "The change from the previous recorded period close to the current close, divided by the previous close.", "Close-to-close returns", "Period closes"],
    ["Return sampling", "Taking a closing value for each declared period to calculate returns.", "Sampling", "Sampling frequency", "Rolling closes"],
    ["Missing interval", "The expected closing observations do not cover an interval. Atlas leaves that interval's return unavailable.", "Missing intervals", "Gaps", "Gap rules", "Missing values", "Largest mark gap"],
    ["Possible holiday interval", "A gap that the weekday rule allows as a possible market holiday. A supplied session calendar gives more precise dates.", "Possible holiday intervals"],
    ["Observation", "A value recorded by the source at a particular time.", "Observations", "Recorded observations", "Valid return observations", "Latest recorded value"],
    ["Mean observation", "The sum of the recorded values divided by the number of recorded values.", "Arithmetic mean", "Arithmetic average"],
    ["Heatmap", "A table that uses color to show the size and direction of a value. In the monthly return chart, a dot means no value.", "Monthly return heatmap"],

    // Drawdowns and return risk.
    ["Drawdown", "The percentage fall from a previous equity high to a later value. Equity of 80 after a high of 100 is a 20% drawdown.", "Drawdowns", "Drawdown history", "Peak-to-trough loss"],
    ["Underwater drawdown", "The loss at each mark relative to the running equity high. It returns to zero when equity regains that high.", "Underwater", "Current drawdown"],
    ["Maximum drawdown", "The largest percentage fall from an equity high to a later low in the selected history.", "Max drawdown", "Max DD", "MDD", "Worst peak-to-trough loss", "Maximum percentage drawdown"],
    ["Maximum drawdown to date", "The worst percentage drawdown observed from the start of the selection through that mark.", "Worst to date", "Worst drawdown to date", "Running maximum drawdown"],
    ["Rolling maximum drawdown", "The worst percentage fall with both the peak and the later low inside the same trailing window.", "Rolling drawdown", "Rolling max drawdown", "Rolling DD"],
    ["Mean yearly maximum drawdown", "Find each complete year's largest percentage drawdown, then average those yearly values.", "Mean full-year maximum", "Average annual maximum drawdown"],
    ["Largest loss in source units", "The largest fall from an earlier equity high, measured in the account's original units.", "Cash drawdown", "Maximum cash drawdown", "Dollar drawdown", "Absolute drawdown amount"],
    ["Shallowest drawdown", "A smaller fall from the high. A maximum drawdown of −5% is shallower than −20%."],
    ["Drawdown episode", "An interval from an equity peak through a decline until recovery or the last recorded mark.", "Drawdown episodes"],
    ["Peak", "The earlier equity high used to measure a drawdown.", "Running high", "High-water mark"],
    ["Trough", "The lowest observed value during a drawdown episode."],
    ["Recovery", "The first mark that reaches the previous peak again. An open episode still has an unrecovered loss."],
    ["Depth", "The size of the decline between an episode's peak and trough.", "Drawdown depth"],
    ["Longest underwater span", "The longest elapsed time from an equity peak until recovery or the last mark of an open drawdown.", "Drawdown duration", "Time under water", "Time underwater"],
    ["Ulcer index", "A measure of repeated or deep losses. Atlas squares each percentage drawdown, averages those squares, then takes the square root."],
    ["Recovery factor", "Net change in equity divided by the largest peak-to-trough loss in the same money or index units."],
    ["Rolling window", "A trailing period that ends at the date being measured. A six-month window moves forward with each new date.", "Trailing window", "Rolling and risk measures", "Rolling metrics"],
    ["Rolling return", "Growth from the opening value of a trailing window to its closing value."],
    ["Volatility", "How much returns vary around their average. Atlas uses the sample standard deviation and expresses it on a yearly scale.", "Annual volatility", "Annualized volatility", "Rolling volatility", "Return volatility"],
    ["Standard deviation", "A measure of how far observations typically fall from their mean.", "Sample deviation", "Sample standard deviation"],
    ["Variance", "A measure of variation based on squared differences from the mean.", "Return variance"],
    ["Downside deviation", "The size of returns that fall short of the target. Atlas averages squared shortfalls across all sampled returns and takes the square root.", "Annual downside deviation"],
    ["Risk-free rate", "The assumed annual return on cash used to calculate excess return. Change it in Report settings.", "Annual risk-free rate", "Risk free rate", "Annual cash"],
    ["Downside target", "The annual return threshold used to measure shortfalls. Atlas converts it to a target for each return period.", "Annual downside target", "Target return", "Minimum acceptable return"],
    ["Excess return", "The investment return minus the cash return for the same period.", "Excess returns"],
    ["Risk-adjusted return", "A return measure that also accounts for the risk taken to earn it.", "Risk-adjusted returns"],
    ["Sharpe ratio", "Average return above the assumed cash rate relative to the variability of returns. Atlas expresses the ratio on a yearly basis.", "Sharpe", "Rolling Sharpe", "Rolling Sharpe ratio"],
    ["Sortino ratio", "Average return above the target relative to the size of shortfalls below it. Atlas expresses the ratio on a yearly basis.", "Sortino", "Rolling Sortino", "Rolling Sortino ratio"],
    ["Calmar ratio", "Compound annual growth divided by the size of the worst percentage drawdown over the same interval.", "Calmar", "Rolling Calmar", "Rolling Calmar ratio"],
    ["Omega ratio", "Add up returns above the target and divide by the total shortfall below the target. Each distance is measured from the target.", "Omega"],
    ["Gain-to-pain ratio", "Total net return divided by the absolute sum of losing-period returns over the same history. The sampling period matters.", "Gain-to-pain", "Gain to pain", "GPR"],
    ["Historical VaR", "Value at risk. Atlas shows the 5th percentile of past period returns. A value of −3% puts roughly one return in twenty at −3% or worse.", "Value at risk", "VaR", "Historical VaR (5th percentile)", "VaR95", "VaR 95%"],
    ["Expected shortfall", "Conditional value at risk. Atlas averages returns at or below the historical 5th percentile. The result keeps the return sign.", "CVaR", "Conditional value at risk", "Expected shortfall (CVaR 5%)", "CVaR95", "CVaR 95%"],
    ["Percentile", "A point in an ordered set of observations. About 5% of observations fall at or below the 5th percentile.", "Percentiles", "5th percentile", "95th percentile"],
    ["Tail ratio", "The 95th-percentile return divided by the size of the 5th-percentile return. It compares the two ends of the distribution.", "Tail ratio (95th / |5th|)"],
    ["Log count axis", "Bar height uses the logarithm of one plus the count. This makes small frequencies visible beside a large bar. Tick labels and tooltips give actual counts.", "Logarithmic count axis"],
    ["Intraday margin", "The USD capital requirement at a recorded time within a trading session. Its high can exceed the requirement at the close.", "Intraday broker margin", "Modeled intraday margin"],
    ["Margin scenario", "An estimate that applies an explicitly chosen schedule to positions. The schedule date can differ from the trading date.", "Intraday margin scenario", "Overnight margin scenario"],
    ["Return distribution", "The frequency of returns of different sizes. Its tails contain the most extreme results.", "Distribution and tails", "Distribution of observations", "Histogram", "Tails"],
    ["Skewness", "The asymmetry of the return distribution. Positive skew means its positive tail extends farther."],
    ["Excess kurtosis", "A measure of extreme observations relative to a normal distribution. A normal distribution has excess kurtosis of zero.", "Kurtosis"],
    ["Best / worst return", "The highest and lowest observed period returns in the selected dates."],
    ["Positive returns", "The share of usable return intervals with a gain. A flat interval counts in the total."],

    // Benchmarks and construction.
    ["Benchmark", "A reference investment or series used to compare performance.", "Reference series", "Comparison series", "Benchmarks"],
    ["Matched return intervals", "Periods for which both series have the same opening and closing times.", "Paired return intervals", "Matched intervals", "Shared intervals", "Aligned returns"],
    ["Selected / reference coverage", "The share of valid return intervals in each series that have a matching interval in the other series."],
    ["Common-window performance", "Results measured over the dates shared by the compared histories.", "Common window", "Common dates"],
    ["Active return", "The selected return minus the reference return over the same interval.", "Relative return"],
    ["Correlation", "How closely two series move together, from −1 to +1. Zero means no measured linear relationship.", "Strategy correlations", "Pairwise correlation", "Pearson correlation", "Correlation matrix"],
    ["Rolling correlation", "Correlation calculated again for each trailing group of matched return intervals.", "Rolling comparison correlation"],
    ["Beta", "How much the selected series tends to move when the reference moves by one unit of return."],
    ["Alpha", "The average excess return left after accounting for the series' beta to the reference. Atlas shows an annualized estimate.", "Annualized alpha"],
    ["Tracking error", "How much the difference between the selected and reference returns varies over time.", "Annualized tracking error"],
    ["Information ratio", "Average return above the reference divided by tracking error, both expressed on a yearly basis.", "IR"],
    ["Upside capture", "Selected returns on the reference's positive intervals divided by reference returns on those intervals. Atlas uses the sums.", "Upside capture ratio"],
    ["Downside capture", "Selected returns on the reference's negative intervals divided by reference returns on those intervals. Atlas uses the sums.", "Downside capture ratio"],
    ["Upside / downside capture", "The two capture ratios show relative performance separately when the reference gains and when it loses."],
    ["Strategy", "A set of trading rules whose results can be measured as one history.", "Strategies"],
    ["Portfolio", "A group of investments or strategies measured together.", "Book", "Portfolios"],
    ["Strategy family", "A source-defined group of strategies with similar trading ideas.", "Family"],
    ["Asset class", "A broad kind of investment, such as equities, bonds or currencies.", "Asset classes"],
    ["Strategy scorecard", "A table of strategies and their measurements for the selected dates."],
    ["Construction weights", "The weights used to form a portfolio. The source states whether they represent capital allocations or risk budgets.", "Risk weight", "Risk weights", "Portfolio weights"],
    ["Portfolio attribution", "An analysis of how funded parts of a portfolio contributed to its return or risk.", "Attribution"],
    ["Return contribution", "The part of the portfolio's change in value attributable to a member, divided by opening portfolio equity.", "Return contributions"],
    ["Risk share", "A member's contribution to portfolio return variance. It depends on how the member moves with the whole portfolio.", "Risk shares", "Risk contribution"],
    ["Funded sleeve", "A separately tracked part of the portfolio with allocated capital. Its equity must reconcile to the portfolio for funded attribution.", "Funded sleeves", "Funded equity"],
    ["Diversification multiplier", "A scale factor based on how member returns move together. It adjusts the portfolio toward its risk target.", "IDM"],
    ["Standalone estimate", "A modeled value for one strategy or position considered on its own. A combined account may have different costs, offsets, or capital needs.", "Standalone", "Standalone comparison"],
    ["Exposure", "The amount affected by a change in market prices, often expressed as a share of account equity."],
    ["Gross exposure", "The total size of long and short positions, counting both as positive. It can exceed account equity."],
    ["Net exposure", "Long exposure minus short exposure. It measures the overall directional position."],
    ["Leverage", "Using positions whose market exposure is larger than the equity supporting them.", "Gross leverage"],
    ["Turnover", "The amount traded relative to the capital base over a period."],
    ["Rebalance", "A trade that changes holdings toward the strategy's target positions.", "Rebalances", "Rebalancing"],

    // Positions, broker sessions and margin.
    ["Active during session", "The number of distinct strategies that held a position at any time during the trading session. A strategy can close its last position before the session ends.", "Active strategies", "Peak active strategies", "Active counts recorded"],
    ["Held overnight", "The number of distinct strategies with an open position at the broker's session close.", "Peak held overnight", "Overnight strategies"],
    ["Overnight margin", "The collateral required to carry positions past the broker's session close. The source identifies a broker amount or a schedule estimate.", "Overnight requirement", "Margin requirement", "Capital requirements"],
    ["Broker overnight margin", "The broker's recorded overnight margin requirement for the account's closing positions.", "Broker requirement"],
    ["Overnight initial margin", "The collateral a broker requires to establish a position and carry it past the session close.", "Initial margin", "Initial overnight margin"],
    ["Maintenance margin", "The minimum collateral a broker requires to keep an existing position open.", "Overnight maintenance margin"],
    ["Required equity", "The minimum account equity the broker reports for the positions. Its calculation can include requirements beyond overnight margin.", "Broker required equity"],
    ["Modeled overnight margin", "An estimate from the closing positions, the applicable dated margin schedule and any required currency conversion.", "Schedule estimate", "Margin estimate", "Margin schedule"],
    ["Margin load", "Overnight margin divided by positive account equity in USD at the same close. Atlas calculates this share for recorded margin and schedule estimates.", "Peak margin load", "Margin utilization"],
    ["Contract multiplier", "The number of underlying units represented by one contract. Multiply quantity by price and the multiplier to find the position's notional value.", "Contract size"],
    ["Notional value", "The value of the underlying exposure. A futures position's absolute notional equals absolute contract quantity times price times contract multiplier.", "Notional exposure", "Notional"],
    ["Per-contract margin", "A collateral amount for each contract. Multiply the absolute net contract quantity by the applicable rate.", "Per-contract rate"],
    ["Net quantity", "The signed total position in an instrument within the same account. Opposing quantities offset each other.", "Closing quantity", "Net position"],
    ["Session coverage", "The trading sessions for which the source supplied a count or a requirement. A missing observation leaves that value unknown.", "USD requirements recorded"],
    ["Index points", "A change in the level of an index, measured on the index's own scale.", "Index point"],

    // Closed trades, costs and concentration.
    ["Closed trade", "A trade for which the source recorded a closing time and realized profit or loss.", "Closed trades", "Trades", "Trade outcomes", "Trade ledger", "Dated ledger"],
    ["Long", "A position that benefits from a rise in the instrument's price.", "Long position", "Long trades"],
    ["Short", "A position that benefits from a fall in the instrument's price.", "Short position", "Short trades"],
    ["Trade side", "The source's direction for a trade, such as long or short.", "Side"],
    ["Win rate", "Winning closed trades divided by all closed trades in the group, including flat trades.", "Percent profitable", "Winning percentage"],
    ["Wins", "Closed trades with positive recorded profit or loss.", "Winning trades", "Winners"],
    ["Losses", "Closed trades with negative recorded profit or loss.", "Losing trades", "Losers"],
    ["Flats", "Closed trades with zero recorded profit or loss.", "Flat trades", "Breakeven"],
    ["Gross profit", "The sum of the positive trade outcomes in the selected group. Each outcome retains the cost treatment in the ledger.", "Total winning P&L"],
    ["Gross loss", "The sum of the negative trade outcomes in the selected group. Atlas keeps the loss sign when it summarizes the dated ledger.", "Total losing P&L"],
    ["Profit factor", "Total profit from winning trades divided by the absolute total loss from losing trades. The ratio needs a nonzero loss."],
    ["Expectancy per trade", "Total recorded profit or loss divided by the number of closed trades in the group.", "Expectancy", "Average trade"],
    ["Average winner", "Total profit on winning trades divided by the number of winners.", "Average win"],
    ["Average loser", "Total loss on losing trades divided by the number of losers.", "Average loss"],
    ["Payoff ratio", "Average winning trade divided by the absolute average losing trade.", "Average win / |average loss|", "Payoff"],
    ["Largest winner", "The largest positive outcome of a closed trade in the group.", "Largest winning trade"],
    ["Largest loser", "The most negative outcome of a closed trade in the group.", "Largest losing trade"],
    ["Largest win share", "The largest winning trade divided by total gross profit in the same group. It measures how much one trade contributed to all gains.", "Largest winner / gross profit", "Largest winner share"],
    ["Largest loss share", "The absolute size of the largest losing trade divided by the absolute total loss in the same group.", "Largest loss / gross loss", "Largest loser share"],
    ["Trade streak", "Consecutive winning trades or consecutive losing trades in closing order.", "Longest winning / losing streak", "Winning streak", "Losing streak"],
    ["Holding time", "The elapsed time between opening and closing a trade.", "Holding times", "Mean holding time", "Holding hours"],
    ["Execution costs", "The costs the source attributes to trading, such as commissions, fees, spread and slippage.", "Transaction costs", "Trading costs", "Cost assumptions", "Cost model"],
    ["Commission", "A fee a broker charges for a trade.", "Commissions", "Broker fees"],
    ["Spread", "The difference between the prices available to buy and sell an instrument at the same time.", "Bid-ask spread"],
    ["Slippage", "The difference between the expected execution price and the actual or modeled fill price."],
    ["Financing", "The cost of funding a position over time.", "Financing costs", "Funding costs"],
    ["Borrow fees", "The fee for borrowing an instrument, often to sell it short.", "Borrow cost"],
    ["Profitable rolling windows", "Trailing periods with positive growth. The share divides their count by all eligible periods, including flat periods. Consecutive windows can overlap.", "Profitable / eligible", "Profitable share"],
    ["Excluded closes", "Sampled closing observations that lack the history or return coverage required for the rolling window."],

    // Evidence, research methods and file formats.
    ["Baseline", "The original run or reference result against which a research test measures a change."],
    ["Backtest", "An evaluation of trading rules on historical observations using stated assumptions.", "Backtested", "Simulated history"],
    ["Diagnostic", "A measurement supplied by the source for a strategy or portfolio, with its own units and observation dates.", "Diagnostics", "Source diagnostic"],
    ["Data coverage", "The inputs and dates for which the source supplied usable observations."],
    ["Sample size", "The number of observations used for a measurement."],
    ["Monte Carlo", "A simulation that repeats random draws under stated assumptions to examine a range of possible outcomes.", "Monte Carlo simulation", "Resample outcomes"],
    ["Bootstrap", "A simulation that samples from observed data with replacement.", "Bootstrapping", "Block bootstrap"],
    ["Out-of-sample", "A period reserved for evaluating rules after selecting their parameters.", "OOS", "Out of sample"],
    ["In-sample", "The data used to select or fit rules and parameters.", "In sample"],
    ["Walk-forward", "A sequence of tests that fits rules using earlier data and evaluates them on the following period.", "Walk forward", "Walk-forward analysis"],
    ["Parameter sensitivity", "How much results change when the strategy uses different parameter values.", "Parameter neighbors", "Nearby parameters"],
    ["Winner removal", "A test that removes selected winning trades and measures the resulting change.", "Remove winning trades"],
    ["Random trade removal", "A test that removes randomly selected trades and recalculates results."],
    ["Trade shuffle", "A test that changes the order of recorded trades to examine the effect on the equity path.", "Change trade order"],
    ["Cost sensitivity", "A test that changes assumed trading costs and measures their effect on results."],
    ["Signal frequency", "How often the strategy evaluates a signal or can act on it.", "Signal cadence"],
    ["Price perturbation", "A test that changes input prices by specified amounts and measures the resulting change.", "Perturb prices"],
    ["HTML", "Hypertext Markup Language. The offline report stores its text, charts, code and data in one HTML file."],
    ["CSV", "Comma-separated values. A plain text table format used to import or export dated observations."],
    ["JSON", "JavaScript Object Notation. A text format for structured data, including the report manifest."],
  ];

  const keyOf = text => text.trim().toLowerCase().replace(/\s+/gu, " ");
  const literal = text => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const inlineTerm = "[data-atlas-term]";
  const namedLabel = "h1,h2,h3,h4,h5,h6,th,td:first-child,dt";
  const passiveRegion = ".chart-legend,button[data-range]";
  const surfaces = [
    namedLabel, ".kpi-label", ".kpi-foot", ".definitions dd",
    "p", ".empty", ".evidence-list li", ".section-title > span", ".chart-meta", ".toolbar > span", ".field-label",
  ].join(",");
  const excluded = [
    "a", "button", "label", "input", "select", "textarea", "summary", "nav", "dialog", "script", "style",
    "pre", "code", "samp", "kbd", "svg", "canvas", "[hidden]", "[contenteditable=true]", "[role=tooltip]",
    ".chart", ".chart-legend", ".heat", ".kpi-value", ".source-value", "dd:not(.definitions dd)",
    ".series-context", ".allocation-list", ".checkbox-list", ".corr-detail-title", ".corr-grid th:not(:first-child)",
  ].join(",");
  // Only these tables use the first data column for named measures or research methods.
  const labelColumns = new Set(["Measure", "Data", "Test family"]);
  const labelOnly = new Set(["short", "long", "side", "book", "index", "family", "losses", "wins", "ir"]);
  const settingTerms = new Map([
    ["setting-months", "Rolling window"], ["setting-rf", "Risk-free rate"], ["setting-target", "Downside target"],
    ["date-from", "Date range"], ["date-to", "Date range"], ["rolling-window", "Rolling window"],
  ]);

  function makeCatalog(report, diagnostics, names) {
    const aliases = new Map();
    function add(term, definition, otherNames = []) {
      if (typeof term !== "string" || !term.trim() || typeof definition !== "string" || !definition.trim()) return;
      const previous = aliases.get(keyOf(term));
      const keys = new Set([keyOf(term), ...otherNames.map(keyOf), ...(previous?.keys || [])]);
      const entry = {term, definition, keys};
      for (const key of keys) aliases.set(key, entry);
    }
    for (const [term, definition, ...otherNames] of dictionary) add(term, definition, otherNames);
    for (const [term, definition] of Object.entries(report.glossary || {})) add(term, definition);
    for (const {name, description, unit} of diagnostics) {
      if (description?.trim()) add(name, description);
      else if (!aliases.has(keyOf(name))) {
        add(name, unit ? "The source records this measurement in " + unit + "." : "A measurement supplied for this series.");
      }
    }
    // Match whole names in one pass. A longer source name can contain a shorter glossary term.
    const keys = [...new Set([...aliases.keys(), ...names])].sort((a, b) => b.length - a.length);
    const words = keys.map(key => literal(key).replace(/ /g, "\\s+")).join("|");
    const match = new RegExp("(?<![\\p{L}\\p{N}_])(?:" + words + ")(?![\\p{L}\\p{N}_])", "giu");
    const entries = [...new Set(aliases.values())].sort((a, b) => a.term.localeCompare(b.term));
    return {aliases, entries, match};
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function makeDialog() {
    const dialog = element("dialog", "atlas-glossary");
    dialog.id = "atlas-glossary";
    const header = element("div", "dialog-header");
    const title = element("h2", "", "Glossary");
    title.id = "atlas-glossary-title";
    dialog.setAttribute("aria-labelledby", title.id);
    const close = element("button", "small-button", "Close");
    close.type = "button";
    close.setAttribute("aria-label", "Close glossary");
    close.addEventListener("click", () => dialog.close());
    header.append(title, close);
    const label = element("label", "", "Search terms and definitions");
    const search = element("input");
    search.type = "search";
    search.autocomplete = "off";
    label.append(search);
    const status = element("p", "atlas-glossary-count");
    status.setAttribute("role", "status");
    const results = element("dl", "atlas-glossary-results");
    dialog.append(header, label, status, results);
    document.body.append(dialog);
    let opener;

    function render(entries) {
      const query = keyOf(search.value);
      const exact = [], related = [], definitions = [];
      for (const entry of entries) {
        if (!query || entry.keys.has(query)) exact.push(entry);
        else if ([...entry.keys].some(key => key.includes(query))) related.push(entry);
        else if (keyOf(entry.definition).includes(query)) definitions.push(entry);
      }
      const matches = exact.concat(related, definitions);
      const fragment = document.createDocumentFragment();
      for (const entry of matches) {
        const row = element("div");
        row.append(element("dt", "", entry.term), element("dd", "", entry.definition));
        fragment.append(row);
      }
      results.replaceChildren(fragment);
      results.scrollTop = 0;
      status.textContent = matches.length ? matches.length + (matches.length === 1 ? " term" : " terms") : "No matching terms.";
    }
    dialog.addEventListener("keydown", event => {
      // A native search field consumes Escape to clear a nonempty query.
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      dialog.close();
    });
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      results.replaceChildren();
      if (opener?.isConnected) opener.focus({preventScroll: true});
    });
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
        dialog.close();
      }
    });
    function open(query, from, entries) {
      if (!dialog.open) opener = from;
      search.value = query;
      render(entries);
      if (!dialog.open) dialog.showModal();
      search.focus();
    }
    return {dialog, search, render, open};
  }

  function makeTooltip() {
    const tip = element("div", "atlas-term-tip");
    tip.id = "atlas-term-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.append(tip);
    let anchor = null;
    let timer;

    function describe(add) {
      const ids = new Set((anchor.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
      if (add) ids.add(tip.id);
      else ids.delete(tip.id);
      if (ids.size) anchor.setAttribute("aria-describedby", [...ids].join(" "));
      else anchor.removeAttribute("aria-describedby");
    }
    function hide() {
      clearTimeout(timer);
      if (!anchor) return;
      describe(false);
      anchor = null;
      tip.hidden = true;
      tip.replaceChildren();
    }
    function position() {
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = document.documentElement.clientWidth, height = window.innerHeight;
      if (!anchor.isConnected || !anchor.getClientRects().length || rect.bottom < 0 || rect.top > height) {
        hide();
        return;
      }
      const gap = 5, edge = 8;
      const box = tip.getBoundingClientRect();
      const below = height - rect.bottom - gap;
      const above = rect.top - gap;
      const top = box.height + edge <= below || below >= above ? rect.bottom + gap : above - box.height;
      tip.style.left = Math.max(edge, Math.min(rect.left, width - box.width - edge)) + "px";
      tip.style.top = Math.max(edge, Math.min(top, height - box.height - edge)) + "px";
    }
    function show(target, entry) {
      clearTimeout(timer);
      if (target === anchor) return;
      hide();
      anchor = target;
      (anchor.closest("dialog[open]") || document.body).append(tip);
      tip.replaceChildren(element("strong", "", entry.term), element("span", "", entry.definition));
      describe(true);
      tip.hidden = false;
      position();
    }
    function leave() {
      clearTimeout(timer);
      if (anchor && anchor !== document.activeElement) timer = setTimeout(hide, 180);
    }
    tip.addEventListener("pointerenter", () => clearTimeout(timer));
    tip.addEventListener("pointerleave", leave);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return {tip, show, hide, leave, get anchor() { return anchor; }};
  }

  function mount({report}) {
    const content = document.getElementById("content") || document.querySelector("main") || document.body;
    const settings = document.getElementById("settings");
    const reader = makeDialog(), tooltip = makeTooltip();
    const names = new Set((report.series || []).map(s => keyOf(s.name)).filter(Boolean));
    const generatedNames = new WeakMap(), generatedTitles = new WeakMap();
    let catalog, signature, tabStop;

    // A source can supply its own accessible name or title. Only revise attributes we supplied.
    function setGenerated(node, attribute, value, owned) {
      const current = node.getAttribute(attribute);
      if (current !== null && current !== owned.get(node)) {
        owned.delete(node);
        return;
      }
      if (value) {
        node.setAttribute(attribute, value);
        owned.set(node, value);
      } else if (owned.delete(node)) node.removeAttribute(attribute);
    }
    function describeRegion(region) {
      if (region.matches("button")) {
        const entry = catalog.aliases.get(keyOf(region.dataset.range));
        setGenerated(region, "title", entry?.definition, generatedTitles);
        return;
      }
      for (const item of region.querySelectorAll(".legend-item")) {
        const key = keyOf(item.textContent);
        const entry = names.has(key) ? null : catalog.aliases.get(key);
        setGenerated(item, "title", entry?.definition, generatedTitles);
      }
    }
    function nameLabel(label) {
      let name;
      if (!label.hasAttribute("aria-labelledby") && label.querySelector(inlineTerm)) {
        // Atlas labels use text and can include decorative icons.
        let source = label;
        const hidden = "[hidden],[aria-hidden=true]";
        if (label.querySelector(hidden)) {
          source = label.cloneNode(true);
          source.querySelectorAll(hidden).forEach(node => node.remove());
        }
        name = source.textContent.trim().replace(/\s+/gu, " ");
      }
      setGenerated(label, "aria-label", name, generatedNames);
    }
    function annotateText(node, labels) {
      const surface = node.parentElement.closest(surfaces);
      if (!surface) return;
      const text = node.data;
      const label = surface.matches(namedLabel) || surface.matches(".kpi-label") ? keyOf(text) : "";
      let end = 0, fragment;
      for (const match of text.matchAll(catalog.match)) {
        const key = keyOf(match[0]), entry = catalog.aliases.get(key);
        if (!entry || (key !== label && (names.has(key) || labelOnly.has(key)))) continue;
        fragment ||= document.createDocumentFragment();
        const term = element("button", "atlas-term", match[0]);
        term.type = "button";
        term.tabIndex = -1;
        term.dataset.atlasTerm = entry.term;
        term.setAttribute("aria-label", "Define " + match[0]);
        fragment.append(text.slice(end, match.index), term);
        end = match.index + match[0].length;
      }
      if (fragment) {
        fragment.append(text.slice(end));
        const owner = surface.closest(namedLabel);
        if (owner) labels.add(owner);
        node.replaceWith(fragment);
      }
    }
    function skip(node) {
      if (node.localName === "tbody") {
        const table = node.closest("table");
        return !labelColumns.has(table?.tHead?.rows[0]?.cells[0]?.textContent.trim());
      }
      if (node.localName === "td") return node.cellIndex !== 0;
      return node.matches(excluded);
    }
    function annotate(root) {
      if (!content.contains(root)) return;
      const region = root.closest(passiveRegion);
      if (region) {
        describeRegion(region);
        return;
      }
      for (let node = root; node && node !== content; node = node.parentElement) {
        if (skip(node)) return;
      }
      const labels = new Set();
      const enclosing = root.closest(namedLabel);
      if (enclosing) labels.add(enclosing);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
          if (node.matches(passiveRegion)) describeRegion(node);
          if (generatedNames.has(node)) labels.add(node);
          return skip(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        },
      });
      // Collect before replacing nodes so that the walker stays in the original tree.
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) annotateText(node, labels);
      for (const label of labels) nameLabel(label);
    }
    function unwrap() {
      const parents = new Set();
      for (const term of content.querySelectorAll(inlineTerm)) {
        parents.add(term.parentElement);
        term.replaceWith(document.createTextNode(term.textContent));
      }
      for (const parent of parents) parent.normalize();
    }
    function setTabStop(next) {
      if (tabStop) tabStop.tabIndex = -1;
      tabStop = next;
      if (tabStop) tabStop.tabIndex = 0;
    }
    const visible = term => !term.closest("details:not([open]), [hidden]") && term.getClientRects().length > 0;
    function repairTabStop() {
      if (tabStop && content.contains(tabStop) && visible(tabStop)) return;
      setTabStop(Array.from(content.querySelectorAll(inlineTerm)).find(visible));
    }
    const observer = new MutationObserver(records => {
      const roots = new Set();
      for (const {target} of records) {
        const root = target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
        if (root && content.contains(root) && (!root.closest(excluded) || root.closest(passiveRegion))) roots.add(root);
      }
      if (tooltip.anchor && !tooltip.anchor.isConnected) tooltip.hide();
      if (!roots.size) return;
      observer.disconnect();
      for (const root of roots) annotate(root);
      repairTabStop();
      observe();
    });
    function observe() {
      observer.observe(content, {childList: true, characterData: true, subtree: true});
    }
    function refresh({series} = {}) {
      observer.disconnect();
      tooltip.hide();
      const diagnostics = series?.diagnostics || [];
      // The glossary depends on metadata. Measurement histories can contain millions of values.
      const next = JSON.stringify(diagnostics.map(d => [d.name, d.description, d.unit]));
      if (next !== signature) {
        if (catalog) unwrap();
        catalog = makeCatalog(report, diagnostics, names);
        signature = next;
        if (reader.dialog.open) reader.render(catalog.entries);
      }
      annotate(content);
      repairTabStop();
      observe();
    }

    function triggerFor(node) {
      if (!(node instanceof Element)) return null;
      const term = node.closest(inlineTerm);
      if (term) return term;
      const field = node.closest("label, input, select");
      const control = field?.localName === "label" ? field.control : field;
      return control && settingTerms.has(control.id) ? control : null;
    }
    function show(target) {
      const name = target.dataset.atlasTerm || settingTerms.get(target.id);
      const entry = catalog.aliases.get(keyOf(name));
      if (entry) tooltip.show(target, entry);
    }
    document.addEventListener("pointerover", event => {
      if (event.pointerType === "touch") return;
      const target = triggerFor(event.target);
      if (target && target !== triggerFor(event.relatedTarget)) show(target);
    });
    document.addEventListener("pointerout", event => {
      if (triggerFor(event.target) !== tooltip.anchor || !tooltip.anchor) return;
      if (triggerFor(event.relatedTarget) !== tooltip.anchor && !tooltip.tip.contains(event.relatedTarget)) tooltip.leave();
    });
    document.addEventListener("focusin", event => {
      const target = triggerFor(event.target);
      if (target) {
        if (target.matches(inlineTerm)) setTabStop(target);
        show(target);
      }
    });
    document.addEventListener("focusout", event => {
      if (event.target === tooltip.anchor) tooltip.hide();
    });
    document.addEventListener("pointerdown", event => {
      if (!tooltip.tip.contains(event.target) && triggerFor(event.target) !== tooltip.anchor) tooltip.hide();
    }, true);
    document.addEventListener("click", event => {
      const target = triggerFor(event.target);
      if (target) show(target);
      else if (!tooltip.tip.contains(event.target)) tooltip.hide();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && tooltip.anchor) {
        event.preventDefault();
        event.stopPropagation();
        tooltip.hide();
        return;
      }
      if (!event.target.matches?.(inlineTerm) || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const terms = Array.from(content.querySelectorAll(inlineTerm)).filter(visible);
      const index = terms.indexOf(event.target);
      if (index < 0) return;
      const step = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
      let next = (index + step + terms.length) % terms.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = terms.length - 1;
      terms[next].focus();
    }, true);
    window.addEventListener("hashchange", tooltip.hide);
    content.addEventListener("toggle", repairTabStop, true);
    settings?.addEventListener("close", tooltip.hide);
    reader.search.addEventListener("input", () => reader.render(catalog.entries));

    function open(query = "", from = document.activeElement) {
      tooltip.hide();
      reader.open(query, from, catalog.entries);
    }
    function wireOpener(button) {
      if (!button) return;
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-controls", reader.dialog.id);
      button.addEventListener("click", () => open("", button));
    }
    wireOpener(document.getElementById("open-glossary"));
    const header = settings?.querySelector(".dialog-header");
    if (header) {
      const button = element("button", "small-button atlas-settings-glossary", "Glossary");
      button.type = "button";
      header.insertBefore(button, header.querySelector(".close-dialog"));
      wireOpener(button);
    }
    refresh({series: report.series?.[0]});
    return {refresh, open};
  }

  window.PerformanceGlossary = {mount};
})();
