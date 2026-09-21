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
| `npm run kraken -- <command>` | The crypto sleeve on Kraken: scanner, committee, guarded orders - see below |
| `npm test` | 127 tests over the indicators, tax lots, wash sales, the chain, the calibration maths, the market check, Schwab, Kraken and the crypto guard |
| `node --experimental-strip-types scripts/session-committee.ts --stage regime --symbols NVDA,JPM` | Print an agent's exact prompts for a set of symbols, so any model (or a person) can answer them offline |
| `... --commit --symbols NVDA,JPM` | Replay saved answers through the real orchestrator: schema-validated, persisted, claims recorded |

Add `--mock` to any committee run for a free offline dry run. Mock runs are stored like any
other but are excluded from every scorecard.

### The market check (stops, buy triggers, phone alerts)

`rules/book.json` is the plan in machine form: held lots with their stops, conditional adds/entries, re-open
rules and the calendar. `npm run check` (or double-click `altovix-check.cmd`) pulls Schwab daily bars and live
quotes for every ticker in it and evaluates every rule:

- Rules fire on a **completed daily close** only. During the session a live price through a level is a
  *heads-up*, never a signal.
- Every run re-reads the whole history since the fill, so a missed run (PC off, login expired) loses nothing -
  the next run reports what fired while it was away, dated, with the paper exit at the next session's open.
- Output: a green / yellow / red light and a price-based health score per holding, an **Opportunity score**
  (0-100: how close the book is to a buy), `data/status.json` for the app, and phone alerts through
  [ntfy](https://ntfy.sh) - one per new trade signal (a flood is bundled), one summary per close, and a
  warning before the 7-day Schwab login expires. Alerts already sent are remembered in `data/check-state.json`.
- `altovix-setup.cmd` (once): creates the private ntfy topic (kept in `data/`, never in the repo), sends a test
  alert, and registers three Windows scheduled runs on weekdays - 10:00, 13:00 and 16:15 New York time.

### The phone app's live numbers

The app (`index.html`, GitHub Pages) has four screens fed by the market check: **Home** (book value, Opportunity,
every holding with its logo and the agents' score), **Needs you**, **Search** (every pick) and **Agents**. Tapping a
company anywhere opens its **stock page**: price, a candlestick chart (daily candles for 1W-6M and since you bought,
weekly for 1Y; price scale, volume, crosshair, and the stop / buy levels as tagged lines; a button switches to a line),
the plan, the agents' score and notes, your position, the day's numbers and its history - all from `status.json`
(`stats`, and `charts` = 130 daily + 53 weekly candles per ticker) plus the committee runs stored in the app. After each
check the PC publishes `status.json` to a side branch, **`status`**, through the GitHub API, and the app reads it from
`raw.githubusercontent.com` (falling back to the copy of `status.json` that ships with the site). `main` is never
written by the script. One-time: `altovix-publish-setup.cmd` asks for a GitHub key (classic token, `public_repo`) and
stores it outside the repo (`%LOCALAPPDATA%\Altovix\github-token.txt`). The repo is public, so is `status.json`.
The screens live in `scripts/pulse/` (`pulse.css`, `pulse.html`, `pulse.js`); `python scripts/pulse/patch_pulse.py`
splices them into `index.html` between markers and can be re-run after any edit.

### The crypto sleeve (Kraken, real money, hard caps)

A separate, small sleeve that hunts volatile spot pairs on Kraken and lets the committee buy and sell
them **inside limits the code will not cross**. `rules/crypto.json` is the whole contract:

| Rule | Shipped value | What it does |
|---|---|---|
| `live` | **false** | `false`: every order is *validated* by Kraken (same checks as a real order) and **not sent**; fills are simulated into `data/crypto-paper-state.json`. `true`: orders go out; state in `data/crypto-state.json` |
| `sleeveUsd` / `maxOrderUsd` / `maxPositionUsd` / `maxPositions` | $400 / $100 / $120 / 4 | the ceilings; the guard cuts any size down to them and refuses what is left over |
| `maxDailyLossUsd` | $40 | realised + unrealised loss on the UTC day that halts new buys until the next UTC day |
| `maxDailyBuys`, `cooldownHours` | 4, 12 | no churn: at most four entries a day, never the same pair twice inside 12 hours |
| `minConfidence` | 0.58 | a Decision below this is recorded and ignored |
| `stopPct` / `trailPct` / `takeProfitPct` / `maxHoldDays` | 12% / 15% / +40% / 21 | mechanical exits, checked every cycle at the live price, sold at market |
| `minVolume24hUsd`, `excludeAssets` | $3M, stablecoins/wrapped/fiat | what the scanner may even look at |
| `killSwitchFile` | `data/crypto-KILL` | `npm run kraken -- kill` blocks every new buy on the next cycle; protective exits still run |

One cycle (`npm run kraken -- run --once`, or double-click `altovix-crypto.cmd`):

1. **Mark** open positions at the live ticker; ratchet each high-water mark.
2. **Exits** - stop, trailing stop, take-profit, max hold: a market sell, live or validated, before anything else is considered.
3. **Scan** the USD pairs above the liquidity floor (`src/core/crypto/scan.ts`): ATR%, volume surge vs the 20-day average,
   distance to the 20-day high, RSI, range position, drawdown from the 90-day high. Score 0-100 rewards volatility that is
   *expanding on volume near a fresh high* and penalises what already went vertical (RSI > 85, +25% day). `npm run kraken -- scan` shows it.
4. **Committee** on the top `maxCommitteeRunsPerCycle` names scoring 45+ - the same eight agents, same schemas, same claims and
   calibration, plus a versioned crypto brief per role (`src/core/crypto/committee.ts`) and operator notes carrying the scanner
   read and the sleeve's caps. BTC and ETH stand in for the sector table; SPY stays the scoring benchmark (the honest bar for real money).
5. **Guard** (`src/core/crypto/guard.ts`): a BUY passes only if the kill switch is off, the sleeve is not halted, confidence,
   liquidity, daily-buy and daily-loss limits hold, the pair is out of cooldown, and there is room under the position and sleeve caps.
   Entries are limit-IOC just above the ask (slippage capped at `entrySlippagePct`), never a bare market buy.
6. **Record**: `data/crypto-journal.jsonl` (every event), the state file, `data/crypto-status.json` for the app, and a phone alert
   (ntfy, same topic as the market check) for every fill and every halt.

Commands: `status` · `scan` · `quote SOL BTC` · `balance` · `history SOL --ingest` · `committee SOL [--mock]` ·
`order buy SOL 50 [--live]` / `order sell SOL [--live]` · `run [--once | --loop 3600] [--no-committee] [--mock]` · `positions` · `kill` / `resume`.

Setting up: create a Kraken API key with **Query Funds, Query Orders & Trades, Create & Modify Orders - and nothing else, never
Withdraw**; put it in `.env`; `npm run kraken -- status`; run in validate mode for a while and read the journal; then, and only
then, set `live: true`. The committee runs cost real model calls (about 20-30 cents each with the default models); `--mock` dry-runs
the whole cycle for free with random agents whose runs never enter a scorecard. Claims on crypto pairs resolve against SPY over the
same *calendar* span (crypto has seven bars a week), see `benchmarkWindow` in `src/core/calibration/resolve.ts`.

What it will not do: leverage, margin, shorting, withdrawals (the client has no withdrawal call and the key must not have the
permission), or anything with `live=false`. Kraken's spot forex pairs are not offered to US clients, so there is no forex here.

### Schwab market data (optional)

With a [Schwab Trader API](https://developer.schwab.com) app (callback `https://127.0.0.1:8182`,
products *Accounts and Trading* + *Market Data*), the terminal gets real quotes, full daily
history and a read-only view of the linked account. Put the App Key and Secret in `.env`
(`SCHWAB_APP_KEY`, `SCHWAB_APP_SECRET`) — nowhere else — then:

| Command | What it does |
|---|---|
| `npm run schwab -- login` | Sign-in (or double-click `schwab-login.cmd`): opens its own Edge/Chrome window (separate profile under `%LOCALAPPDATA%\Altovix`, local debug port) and reads the redirect from the tab itself, so there is nothing to copy - just log in and consent. Schwab's code lasts ~30 s; a rejected one re-opens the page. `--manual` (or no Edge/Chrome found, or the window closed early) falls back to your normal browser: copy the "can't reach this page" address (clipboard is watched) or paste it into the terminal. Tokens cache in `data/schwab-tokens.json` (git-ignored); the refresh token lasts 7 days, then log in again |
| `npm run schwab -- status` | Keys present, logged in, time left on the tokens, and a live SPY check |
| `npm run schwab -- quote SPY QQQ ^VIX` | Live quotes |
| `npm run schwab -- history DCO --from 2026-01-01 --ingest` | Daily bars, optionally written straight into `prices` |
| `npm run schwab -- accounts` | Balances and positions of the linked account, numbers masked. Read-only |

Set `ALTOVIX_MARKET_PROVIDER=schwab` to make it the first provider `npm run ingest` tries;
Stooq → Yahoo → CSV remain the fallbacks. Nothing in this repo can place, replace or cancel
an order — the client does not implement those endpoints.

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

- **No automated trading of equities.** The stock Book records what you did; the Schwab client cannot place orders.
  The crypto sleeve is the one exception, and it is fenced: `rules/crypto.json` caps, validate-only by default, a kill switch.
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
src/core/market/         provider interface + Schwab (OAuth, quotes, history, read-only accounts), Kraken (spot data, balances, orders), Stooq, Yahoo and CSV adapters
src/core/crypto/         the crypto sleeve: scanner, guard (caps + state), crypto committee brief, the cycle
rules/crypto.json        the sleeve's caps and the live switch
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
