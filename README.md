# Altovix Terminal

A personal, real-money portfolio managed by a multi-agent LLM investment committee — where
every agent's call is recorded as a dated, falsifiable claim and scored against what actually
happened.

The interesting part is not that an LLM picks stocks. It is that this system can tell you
**how often each of its agents is right, and whether its stated confidence means anything.**

```
Regime → Sector → Quant → Research → Risk → Bear Case → Decision → Journal
                                                              ↓
                                            every falsifiable claim, with a deadline
                                                              ↓
                                     Calibration: hit rate, Brier score, Brier skill
```

## Quick start

Requires **Node 22.6+** and nothing else. There are no dependencies to install.

```bash
git clone <this repo> && cd altovix
cp .env.example .env          # add ANTHROPIC_API_KEY when you want real runs

npm run init -- NVDA AAPL --fund 25000
npm run ingest                # daily prices for your tickers + benchmarks + sectors
npm run committee -- NVDA     # convene the committee
npm run trade -- BUY NVDA 10 118.50 --run 1
npm run snapshot
npm run calibrate             # once horizons start closing
npm run report                # the terminal view
```

Want to see it work before wiring anything up:

```bash
./scripts/demo.sh
```

That builds a complete demo — synthetic prices, a fabricated book, fifteen offline committee
runs and a calibration scorecard — with **no network and no API key**. Everything it produces
is random walks graded by a random forecaster, and it says so. It exists to show the
machinery, not to say anything about markets.

## Commands

| Command | What it does |
|---|---|
| `npm run init -- [TICKERS] --fund 25000` | Create the database, track the universe, fund the account |
| `npm run ingest [-- SYMBOLS] [--from 2024-01-01]` | Pull daily bars (Stooq → Yahoo → CSV fallback chain) |
| `npm run trade -- BUY NVDA 10 118.50` | Record a trade; opens a tax lot, checks cash, runs the wash-sale pass |
| `npm run trade -- DEPOSIT 5000` | Cash in or out |
| `npm run committee -- NVDA [--mock]` | Run the eight-agent chain and store the full transcript |
| `npm run calibrate [-- --mechanical-only]` | Settle claims that have come due and rebuild the scorecard |
| `npm run snapshot [-- --rebuild]` | Daily portfolio snapshot / rebuild the whole equity curve |
| `npm run report [-- --run 12]` | Terminal dashboard, or one committee run's full transcript |
| `npm test` | 59 tests over the indicators, tax lots, wash sales, the chain, and the calibration maths |
| `node --experimental-strip-types scripts/session-committee.ts --stage regime --symbols NVDA,JPM` | Print an agent's exact prompts for a set of symbols, so any model (or a person) can answer them offline |
| `... --commit --symbols NVDA,JPM` | Replay saved answers through the real orchestrator: schema-validated, persisted, claims recorded |

Add `--mock` to any committee run for a free offline dry run. Mock runs are stored like any
other but are excluded from every scorecard.

**Operator notes.** Anything not in the price tables - a macro snapshot, a dated headline, an
earnings date - goes in `data/session/notes/market.md` (all symbols) or `notes/<SYMBOL>.md`, and
is rendered into every agent's prompt as operator-supplied context the agents may use but not
extend. Market-wide claims (regime, sector) made by several same-day runs are recorded once.

## Three design decisions worth defending

**1. The model never computes a number.** Every return, moving average, RSI, volatility,
drawdown and correlation is calculated in `src/core/indicators/`, unit-tested against known
values, and handed to the agents as fact. Agents interpret; they do not do arithmetic. This
removes an entire class of silent error and makes the numbers auditable.

**2. Every claim has a deadline before the outcome is known.** An agent that says "tech may
face headwinds" cannot be graded and has told you nothing. So each agent emits structured,
falsifiable claims — *XLK underperforms SPY over 21 trading days*, *max drawdown stays
shallower than -15%* — with a stated probability and a resolution date. Most resolve
mechanically against stored prices with no model involved. Only genuinely judgemental
claims (did the thesis play out, did the named risk materialise) cost a model call.

**3. Nothing is ever deleted.** Failed runs, bad calls and embarrassing transcripts all stay
in the database. A calibration record only means something if nothing was removed after the
fact, so the integrity boundary is at *scoring* time, not at write time.

## What it deliberately does not do

- **No automated trading.** It records what you did; it does not touch a broker.
- **No news, filings or fundamentals.** Agents get price and volume only, and are instructed
  to name the gap rather than invent a figure. `knowledgeLimits` is a required field.
- **Wash-sale detection is same-ticker, same-account.** It does not model substantially
  identical securities under different tickers, options, or purchases in an IRA or a
  spouse's account. Those stay a human check.
- **It is not investment advice**, and the calibration record exists precisely so that the
  system's own confidence can be checked rather than trusted.

## Layout

```
db/schema.sql            the whole data model, commented
src/core/indicators/     pure maths - the only place numbers are computed
src/core/market/         provider interface + Stooq, Yahoo and CSV adapters
src/core/portfolio/      tax lots, wash sales, snapshots, performance metrics
src/core/llm/            fetch-based Anthropic client, JSON-schema validator, offline mock
src/core/agents/         one file per committee role: prompt, schema, claims
src/core/committee/      context builder and the chain orchestrator
src/core/calibration/    claims, mechanical resolvers, Brier scoring
src/cli/                 the commands above
index.html, sw.js, manifest.webmanifest, icons/
                         the Altovix app: a standalone page (on-device data, your own API key,
                         installs from Safari), served by GitHub Pages from the repo root — see app/README.md
app/ios/                 the native iOS shell (Expo) that wraps it for TestFlight
web/                     the hosted Altovix Terminal page (phone-first; runs on claude.ai artifacts)
web/altovix-widget.scriptable.js   iOS home-screen widget (Scriptable); built by `npm run build:widget`
web/widget/              widget template + plan data + build step; embed/ holds the logo PNGs it inlines
web/brand/               Altovix Capital logo: full lockup, mark and wordmark (navy on transparent, and white)
test/                    59 tests
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit and why.
