# Portfolio capital and contract sizing

This guide answers three questions for a portfolio of futures trading strategies:

1. How much account equity must stand behind one contract of one strategy?
2. When does the contract count rise, and when must it fall?
3. How much capital does the whole portfolio need?

It is written for saved backtests, forward tests and live records alike. The same method sizes a portfolio in a report and in an account, so the report stays an honest preview of the account. Every number below is a documented default with its reasoning. Change a default when you have evidence, and record the change in the report.

The method is conservative by design. It treats survival as the first constraint and capital efficiency as the second. A portfolio that cannot survive its worst expected loss at its worst expected margin requirement does not have a sizing problem to optimize. It has too little capital or too many contracts.

## Margin is not capital

Margin is collateral. It is the amount the broker and exchange require you to deposit so they do not carry your loss. It is not the cost of the position, not a loss budget, and not the capital a strategy needs. Three properties matter:

- Margin is a small fraction of contract notional, often 3% to 10%. Clenow works one example where initial margin is about 7% of notional. Funding a contract at its margin alone is leverage of roughly 10 to 30 times.
- Margin changes. Exchanges raise requirements in volatile markets, sometimes several times within weeks, precisely when open losses are largest. Documented episodes include gold in 1979 to 1980, silver in 2011, and equity indexes in March 2020. A sizing rule that spends the whole margin buffer leaves the account forced to liquidate at the worst time.
- Margin per contract says nothing about what the strategy can lose. Two contracts with the same margin can have very different daily risk.

Vince states the consequence in its sharpest form: at optimal f, the mathematically growth-maximizing fraction, historical drawdown is never less than that fraction, and live drawdowns of 30% to 95% of equity are the expected price of full geometric sizing. Penfold states the constraint from the other side: the statistical risk of ruin must be zero, or you have no business trading. The usable conclusion is not a formula for the most capital-efficient bet. It is a floor below which the account breaks, plus headroom above the floor.

## The capital step for one contract

The unit of futures sizing is the whole contract. You cannot trade 0.4 of a contract, so every sizing rule for futures becomes a stepping rule: how much equity stands behind each contract. Call that amount the **capital step**.

The capital step for one contract of one strategy is the largest of three independent floors:

| Floor | Formula | What it protects |
| --- | --- | --- |
| A. Combined stress floor | `2 x margin + 2 x drawdown` | Surviving the worst expected loss while margin is elevated |
| B. Collateral floor | `3 x margin` | A margin spike on a low-loss strategy |
| C. Volatility ceiling | `64 x sigma` | One contract too hot for its equity, whatever the history shows |

The inputs:

- `margin`: the current overnight initial margin for one contract, from the broker's published schedule. Use the full overnight requirement, not an intraday discount, unless the strategy is flat every session before the cutoff with documented evidence. When a dated historical schedule exists, replace `2 x margin` with the higher of twice the current margin and the largest documented requirement.
- `drawdown`: the strategy's maximum closed-equity drawdown per contract in the longest available backtest, in account currency, after costs. Use the author's or the test's figure only when it is reproducible from records.
- `sigma`: the standard deviation of the strategy's daily net profit and loss per contract, in account currency, measured on every trading day of the backtest including flat days.

### Floor A: combined stress

`2 x margin + 2 x drawdown`

The adverse case that matters is not a margin spike alone or a drawdown alone. It is both at once, because exchanges raise margin in volatile markets and volatile markets are where trend and mean-reversion losses cluster. After losing `2 x drawdown`, the remaining equity is exactly `2 x margin`, which still covers a doubled margin requirement. Both factors use the same reasoning: the future is worse than the backtest. Vince shows drawdowns in live trading exceed tested drawdowns as a matter of course, and published margin schedules show requirements can double within weeks in a crisis.

### Floor B: collateral

`3 x margin`

A strategy with a small historical drawdown still carries gap risk and schedule risk. A strategy rarely in the market can show a tiny drawdown that understates what one bad fill or one suspended exit can cost. The collateral floor binds only for such strategies. At three times margin, a doubled requirement still leaves one third of the step as loss capacity. Treat anything below twice margin as fragile at any drawdown size, because a single schedule increase consumes the entire buffer.

### Floor C: volatility ceiling

`64 x sigma`

The third floor restated as a cap: one contract should not give the strategy, standing alone, an annualized volatility above 25% of its step capital. Daily volatility annualizes with the square root of 256 trading days, a factor of 16. Requiring `16 x sigma / step` at or below 0.25 gives `step` at or above `64 x sigma`. The 25% ceiling follows the volatility-targeting framework: the target is set by tolerance for loss, not by what the market offers. The vault's volatility-targeting technique card covers the supporting literature. For a portfolio member this ceiling is deliberately loose, because diversification lowers portfolio volatility below the sum of standalone volatilities. Its job is to catch the single contract that is simply too big for the account, most often a full-size contract that belongs in its micro.

### Worked examples of one step

The margins below are published TradeStation overnight initial requirements observed on October 31, 2026. They are a dated snapshot, not a quote.

| Contract | Margin | Example drawdown per contract | Floor A | Floor B | Step |
| --- | ---: | ---: | ---: | ---: | ---: |
| MES (micro S&P) | $2,856 | $4,000 | $13,712 | $8,568 | **$13,712** |
| MBT (micro bitcoin) | $1,871 | $3,000 | $9,742 | $5,613 | **$9,742** |
| LH (lean hogs) | $1,650 | $5,000 | $13,300 | $4,950 | **$13,300** |
| RB (gasoline) | $10,399 | $8,000 | $36,798 | $31,197 | **$36,798** |
| ES (S&P) | $28,558 | $15,000 | $87,116 | $85,674 | **$87,116** |

Reading the first row: one MES contract in a strategy with a $4,000 tested maximum drawdown needs about $13,700 of equity behind it, not the $2,856 margin and not a round $5,000 or $8,000. A fixed tier such as $8,000 per micro contract survives the normal drawdown but not the drawdown arriving together with a margin spike. That is a legitimate choice for a risk-tolerant account, but it must be a recorded choice, not an accident.

## Stepping quantity up and down

Divide the strategy's allocated equity by its capital step. The integer part is the contract quantity:

`quantity = floor(allocated equity / step)`

Three rules keep the stepping honest:

1. **Step down with a band.** Increase quantity as soon as equity reaches the next multiple of the step. Decrease it only when equity falls 10% below the multiple that granted the current quantity. The band stops the contract count from oscillating when equity hovers at a threshold. Reduction after losses is therefore automatic: losses lower the allocation, and the allocation cuts the quantity. No separate loss rule is needed.
2. **Quantity may reach zero.** When the allocation cannot fund one step, the strategy does not trade. A zero quantity is information: the strategy is undercapitalized, or the account is. Never round up to a contract the allocation cannot support.
3. **Compound per strategy, not per portfolio average.** Compute each strategy's quantity from its own allocation, defined as its funding share plus its own retained net profit and loss. Strategies that profit expand; strategies that lose contract. Do not let one strategy's profit silently fund another's growth, or the portfolio's risk migrates to its weakest member.

Two classical alternatives are worth knowing and rejecting for this use. Fixed-fractional sizing, the Turtle unit, risks a fixed fraction of equity per unit of volatility and produced the famous 4/6/10 unit caps; it assumes you can measure and adjust continuously, which whole contracts in a small account cannot do. Fixed-ratio sizing adds a contract per fixed profit delta per contract; it handles the stepping smoothly but ties quantity to trade count rather than to risk, and it is unstable across strategies with different trade frequencies. The step rule above is the discrete, implementable form of volatility-targeted fixed-fractional sizing, with margin added because futures demand it.

## Portfolio capital

Two funding models are legitimate. State which one the portfolio uses.

### Siloed funding

Each strategy receives its own allocation of `quantity x step`, and the portfolio capital is the sum of the allocations. This model is simple, auditable and very conservative: every strategy carries its full stress buffer whether or not the stresses coincide. Use it when members share no margin offsets, when the account is divided across brokers or entities, or when the owner wants each strategy to stand alone.

### Pooled funding

Strategies share one cash and collateral pool. The pool must cover three additive parts:

`pool >= stress concurrent margin + stress drawdown reserve + operating buffer`

- **Stress concurrent margin**: `2 x` the peak concurrent margin requirement of the portfolio, measured on the replayed history. Concurrent margin is the sum of overnight requirements of all positions open at the same time. Measure it day by day from the replay; never sum the per-strategy peak margins, because peaks rarely coincide, and never assume offsets beyond what the measurement shows. When a documented schedule exists, use it as the basis and label it; the reporting layer distinguishes broker measurements, schedule estimates and later-rate scenarios.
- **Stress drawdown reserve**: `2 x` the portfolio's own maximum drawdown in the replay, in account currency. The portfolio drawdown is measured on the combined equity stream, so diversification inside the portfolio already reduces it. The factor of two covers the future being worse than the test, nothing more.
- **Operating buffer**: 5% of the total, for costs, data gaps, rolled positions and the losses that no model lists.

Then apply the utilization ceiling: the replayed peak concurrent margin must not exceed 40% of the pool, measured on the same dates, and the margin utilization time series must appear in the report. A utilization above 40% means the pool leans on collateral headroom that the drawdown reserve may already have spent. A ceiling breach is resolved by more capital or fewer contracts, not by hope about correlations.

Pooled capital is smaller than siloed capital precisely because stresses do not coincide. That saving is the reward for measuring the combined stream honestly. It is also the danger: the measurement is only as good as the replay, so every input gap weakens it.

### Admission of new strategies

Portfolios gain members over time. Three rules keep admissions honest:

1. A new strategy enters at one contract only when the pool funds its full capital step. Add the step amount to the pool requirement at admission.
2. Apply a seasoning window when the strategy's evidence is thin: a default of three months of clean forward data, or an explicit documented override. Do not backdate compounding into the admission.
3. Record every admission as a dated funding event. The report's equity history must show when capital and members entered, so a reader never mistakes a growing membership for organic compounding.

## Concentration checks

Sizing by strategy is not enough when strategies share risk. Apply three checks to the portfolio and report any breach:

- **Sector share**: no sector or strongly correlated cluster supplies more than 50% of peak concurrent margin. The Turtle unit limits enforced the same idea with caps of 4 units per market, 6 per correlated group and 10 to 12 per direction; those caps, not the entries, are what survived the crash of October 1987.
- **Same instrument overlap**: two strategies trading the same contract count as one position for overlap analysis. Their margins and drawdowns are not independent, whatever their backtest correlation in flat periods.
- **Hidden beta**: equity-index strategies correlate in a crisis even across regions and styles. Clenow's warning applies: a portfolio of equity-index futures strategies can be one large equity bet wearing several costumes.

A breach does not force a rejection. It forces a label, an explicit acceptance in the report, and usually a larger pool.

## Deleveraging in drawdown

Write the ladder before it is needed:

| Portfolio event | Action |
| --- | --- |
| Drawdown reaches the design reserve (`2 x` replayed maximum drawdown) | Halve every quantity, rounding down |
| Drawdown reaches twice the design reserve | Cut to one contract per strategy, or halt new entries entirely |
| Margin utilization above 40% for five consecutive sessions | Reduce quantities until utilization is below the ceiling |
| Recovery to within 10% of the prior equity high | Restore quantities one step at a time |

The ladder is not a claim that cutting risk in a drawdown improves returns. The evidence on that is mixed. The ladder exists because an account cannot compound what it no longer has, and because margin calls do not wait for the recovery.

## Small accounts and micro contracts

Micro contracts exist precisely because whole-contract granularity otherwise excludes small accounts. Apply the micro-first rule:

1. When the full contract's step exceeds the strategy allocation and a micro exists, use the micro. Most micros scale at one tenth, so granularity improves by ten while the method is unchanged.
2. If even one micro contract's step exceeds the allocation, the strategy is ineligible at this capital. Say so in the report. A strategy silently dropped is better than a strategy silently oversized.
3. When substituting a micro for a full contract in a reconstruction, label it. A micro execution proxy is a modeling choice with its own cost and liquidity reality, not a perfect tenth of the full contract.

## What a report must show

A Performance Atlas report that applies this method must display or attach:

1. The capital step of every strategy with its three floors, the binding floor, and every input: margin with its date and source, drawdown, sigma.
2. The funding model: siloed or pooled, the pool calculation, and each admission or funding event with its date.
3. Construction weights through the `holdings` mechanism, with `holdingsBasis` stating the date and meaning of the snapshot.
4. The margin time series through the activity input, with `marginBasis` distinguishing broker measurements, schedule estimates and scenarios. The utilization ratio, peak concurrent margin and its contributors at the peak.
5. The stress scenario: margin at twice the replayed requirement, or at a documented historical schedule, shown as a scenario line and never merged into the historical record.
6. The deleveraging ladder chosen for the portfolio, stated before any results.
7. Every deviation from this guide, recorded as a choice with its reason.

A report that cannot produce these items is not evidence of safety or of danger. It is evidence of missing records, and the report must say which inputs are missing and which results that affects.

## What this method does not do

- It does not maximize growth. Kelly-type sizing and optimal f answer a different question at a price in drawdown that Vince documents and few accounts can pay. If a growth-optimal fraction is ever used, use a small fraction of it and treat this guide's floors as still binding.
- It does not forecast returns. The sizing reacts to equity; it does not predict.
- It does not remove tail risk. It funds the measured risks and doubles two of them. Worse exists.
- It does not fix whole-contract distortion at small capital. Below one step, the honest answers are micro contracts or not trading the strategy.
- It does not validate the strategies. Sizing multiplies whatever the strategy is, including its errors.

## Sources

The defaults above rest on published practice and literature, paraphrased rather than quoted:

- Robert Carver, *Systematic Trading* (2015): the volatility-target framework, risk set by tolerance rather than opportunity, diversification multipliers, and the leverage death spiral in crisis markets.
- Andreas Clenow, *Following the Trend* (2013, revised 2023): ATR-based contract sizing at small risk factors per unit, worked futures margin examples, sector correlation warnings, and position rounding in small accounts.
- Curtis Faith, *Way of the Turtle* (2007): the unit system sizing one ATR of movement to 1% of equity, and the 4/6/10 exposure caps across markets, correlated groups and direction.
- Ralph Vince, *The Mathematics of Money Management* (1992): optimal f, the identity between the growth-optimal fraction and minimum historical drawdown, and the expectation of 30% to 95% equity retracements at full geometric sizing.
- Brent Penfold, *The Universal Principles of Successful Trading* (2010): the zero risk-of-ruin requirement and the asymmetry of losses, where a 34% drawdown needs a 52% gain to recover.
- Van Tharp, *The Definitive Guide to Position Sizing* (second edition, 2013): position sizing as the dominant determinant of meeting objectives, distinct from what and when to trade.
- Moreira and Muir (2017) and the volatility-managed portfolio literature summarized in the vault's volatility-targeting technique card: scaling exposure inversely to measured volatility improves risk-adjusted performance across asset classes.

When any of these sources and this guide disagree in detail, the guide's floors still apply: they encode the overlap of the sources, not any one author's full system.
