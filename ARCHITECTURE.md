# Architecture

## The problem this is shaped around

It is easy to build something that asks an LLM what to buy. It is hard to build something
that can tell you, six months later, whether the LLM was any good — and harder still to make
that claim credible to someone who did not watch you build it.

So the system is organised around a single constraint: **every opinion must be recorded in a
form that can later be proved wrong, and nothing may be deleted once recorded.** Almost every
design decision below follows from that.

---

## 1. Layers

```
                 ┌───────────────────────────────────────────────┐
   CLI / web ──► │  committee/run.ts        calibration/index.ts  │
                 └──────────┬─────────────────────┬──────────────┘
                            │                     │
                 ┌──────────▼───────┐   ┌─────────▼─────────────┐
                 │ agents/*.ts      │   │ calibration/resolve.ts│
                 │ prompt + schema  │   │ score.ts (Brier)      │
                 │ + claims()       │   └─────────┬─────────────┘
                 └──────────┬───────┘             │
                            │                     │
                 ┌──────────▼─────────────────────▼─────────────┐
                 │ llm/  (Anthropic | mock)   indicators/  math │
                 │ market/ (Stooq|Yahoo|CSV)  portfolio/  lots  │
                 └──────────────────┬───────────────────────────┘
                                    │
                            ┌───────▼────────┐
                            │ SQLite (WAL)   │
                            └────────────────┘
```

Dependencies point downward only. `indicators/` and `calibration/score.ts` are pure functions
with no database or network access, which is why they are the most heavily tested.

## 2. Why zero dependencies

Node 22 ships everything this needs: native TypeScript type-stripping (`--experimental-strip-types`),
`node:sqlite`, `node:test`, and global `fetch`. The Anthropic Messages API is one HTTP POST,
so the SDK earns nothing here.

The result is a repo that clones and runs — no install step, no lockfile drift, no supply-chain
surface around an audit trail whose whole value is that it has not been tampered with. The
trade-off is a deliberately plain HTTP layer instead of a framework, and the code is written
in erasable-syntax-only TypeScript (no `enum`, no parameter properties) so `node` can run the
files directly.

## 3. The committee chain

Eight roles run in sequence. Each sees the full output of every role before it, in JSON, and
is told it may disagree with them explicitly.

| # | Agent | Job | Temp | What it is scored on |
|---|---|---|---|---|
| 1 | Regime | Risk-on / neutral / risk-off from the macro tape | 0.2 | SPY direction and realised vol over its horizon |
| 2 | Sector | Leadership ranking vs SPY | 0.2 | Each named leader/laggard against SPY |
| 3 | Quant | Interprets computed indicators | 0.15 | Direction, and separately, relative to SPY |
| 4 | Research | The thesis, catalyst and exit trigger | 0.35 | Thesis (judgement) + relative to SPY (mechanical) |
| 5 | Risk | Sizing, stop, and a veto | 0.15 | Whether the drawdown it predicted held |
| 6 | Bear | The case against, with mechanisms | 0.55 | Direction, plus each named risk (judgement) |
| 7 | Decision | One action, and the disagreement it resolved | 0.1 | Whether the action beat holding SPY |
| 8 | Journal | The durable record | 0.2 | Nothing — it records, it does not forecast |

Temperature is per-role and deliberate: the bear case runs hot because its job is to generate
candidate failure modes; the decision runs cold because its job is synthesis, not invention.

**Structured output.** Each agent defines a JSON schema, and the Anthropic client obtains
conforming output by forcing a single tool call whose `input_schema` is that schema — rather
than asking for JSON in prose and parsing hopefully. Anything that still fails validation is
retried with the specific validation errors fed back. Nothing unvalidated reaches the database.

**Failure handling.** If an agent fails, the run is marked `FAILED`, the failing prompt and
error are still written to `agent_outputs`, and the chain stops — later agents depend on
earlier ones, so continuing would produce a decision made on a hole. The partial transcript
survives.

## 4. Claims: the calibration substrate

`agents/*.ts` each export a `claims(output, ctx)` function that converts free-form judgement
into rows in `agent_claims`:

```
agent · kind · subject · statement · direction · threshold ·
confidence · made_on · horizon_days · resolve_after · resolver
```

Nine claim kinds cover the committee. Seven resolve **mechanically** from stored prices —
no model, no cost, no judgement:

- `REGIME_DIRECTION` — risk-on ⇒ SPY up; risk-off ⇒ SPY down; neutral ⇒ inside ±3%
- `SECTOR_RELATIVE`, `RELATIVE_TO_BENCH` — excess return vs SPY, so a stock that rose 4%
  while SPY rose 10% **fails** an outperformance claim
- `PRICE_DIRECTION` — outright direction
- `DRAWDOWN_LIMIT` — realised worst peak-to-trough vs the stated limit
- `VOL_BAND` — realised vol vs the stated ceiling
- `DECISION_VALUE` — did the action beat SPY; a `HOLD` is graded inside a 2% band

Two are genuinely judgemental — `THESIS_PLAYS_OUT` and `BEAR_RISK_MATERIALIZES` — and only
these reach the Calibration Agent, which is given the price path over exactly the claimed
horizon and told to grade the claim **as stated**, not a more reasonable version of it, and to
separate *right about direction* from *right about mechanism*.

A claim is never resolved early: `forwardWindow()` returns `null` until the market has
actually produced the required number of bars, and the claim stays open.

## 5. Scoring

For each agent, over its resolved claims:

- **Hit rate** — how often it was right
- **Average stated confidence**, and **overconfidence** = confidence − hit rate
- **Brier score** — mean squared error of the probability, `mean((p − outcome)²)`
- **Brier skill** — `1 − BS / BS_ref` against a forecaster that always predicts that agent's
  own base rate. This is the load-bearing number: it asks whether the agent's *confidence*
  carries information, not just whether its calls happen to land. Below zero means you would
  do better ignoring the confidence entirely.
- **Reliability buckets** — observed frequency within each confidence decile, which is what
  actually shows you *where* the miscalibration lives

An agent that is right 70% of the time by always saying 0.7 has a hit rate of 70% and a Brier
skill of 0. That is the distinction the whole design exists to make visible.

## 6. Integrity boundaries

- Claims are written for **every** run, including offline mock ones. Nothing is deleted.
- `scoreAll()` joins to `committee_runs` and filters `llm_mode = 'real'` by default, so a dry
  run can never masquerade as a track record. `includeMock: true` is opt-in and demo-only.
- The full context handed to the committee is stored as JSON with a `context_hash`, so any
  run can be replayed against exactly the inputs it saw.
- Prompts are stored verbatim per agent call, so a later change to a prompt cannot silently
  rewrite what a past agent was asked.

## 7. Portfolio and tax layer

Lot-level accounting, because it is the only representation that makes holding periods and
harvesting decisions correct:

- Every buy opens a lot; sells consume lots FIFO, HIFO or LIFO.
- Long-term requires a holding period **exceeding** one year (366+ days).
- The wash-sale pass recomputes from scratch: a loss is disallowed to the extent that
  substantially identical shares were bought within ±30 days, and the disallowed amount is
  added to the replacement lot's basis. Shares disposed of by the same sale cannot serve as
  their own replacement, and one replacement purchase cannot absorb two different losses.

**A bug worth recording.** The first version of `positions(asOf)` read `lots.shares_remaining`
— a present-day figure. That made every historical snapshot forget positions that had since
been sold, which inflated portfolio volatility from 6.9% to 20.4% and dropped the SPY
correlation from 0.53 to 0.09. Positions are now reconstructed as
`shares_opened − Σ(closures on or before that date)`. Three regression tests hold it in place.
Performance figures are only as honest as the reconstruction underneath them.

Returns are **time-weighted** and chain-linked daily with external cash flows neutralised, so
the equity curve measures decisions rather than the timing of deposits.

## 8. Market data

A `PriceProvider` interface with three implementations and an automatic fallback chain:
Stooq (free daily CSV, no key) → Yahoo (free JSON, unofficial) → CSV (a directory of files,
for when the network is blocked or all you have is a broker export). Adding a paid provider
means implementing one method.

## 9. Swapping the database

The schema is deliberately plain SQL. For Postgres: `INTEGER PRIMARY KEY AUTOINCREMENT` →
`GENERATED ALWAYS AS IDENTITY`, `TEXT` dates → `DATE`, `datetime('now')` → `now()`, and
replace the thin `src/core/db.ts` helpers (`all`/`one`/`run`/`tx`) with a `pg` client. Nothing
above that layer touches SQLite directly.

## 10. Where this goes next

1. Accumulate real runs — the calibration record is worthless until horizons actually close.
2. Per-agent model routing, then A/B a role against a different model and compare Brier skill.
   The scoring infrastructure to do that comparison already exists.
3. Ablation: does the Bear Case agent actually improve decision quality? Run the chain with
   and without it and compare `DECISION_VALUE` outcomes. This is the experiment the whole
   design makes possible, and it is the one worth walking an interviewer through.
