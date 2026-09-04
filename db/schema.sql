-- Altovix Terminal schema (SQLite dialect).
-- Portable to Postgres: see ARCHITECTURE.md "Swapping the database".
-- Money is stored in cents-free REAL for clarity; all P&L math rounds at the presentation layer only.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- reference

CREATE TABLE IF NOT EXISTS symbols (
  symbol        TEXT PRIMARY KEY,
  name          TEXT,
  sector        TEXT,
  asset_class   TEXT NOT NULL DEFAULT 'EQUITY',
  is_benchmark  INTEGER NOT NULL DEFAULT 0,
  added_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prices (
  symbol   TEXT NOT NULL,
  date     TEXT NOT NULL,            -- ISO yyyy-mm-dd, exchange local trading day
  open     REAL, high REAL, low REAL,
  close    REAL NOT NULL,
  volume   REAL,
  source   TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_prices_date ON prices(date);

-- ---------------------------------------------------------------- portfolio

CREATE TABLE IF NOT EXISTS cash_ledger (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  date     TEXT NOT NULL,
  kind     TEXT NOT NULL,            -- DEPOSIT|WITHDRAW|BUY|SELL|FEE|DIVIDEND|INTEREST
  amount   REAL NOT NULL,            -- signed: cash in positive, cash out negative
  ref      TEXT,
  note     TEXT
);
CREATE INDEX IF NOT EXISTS idx_cash_date ON cash_ledger(date);

CREATE TABLE IF NOT EXISTS trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL,     -- BUY|SELL
  shares          REAL NOT NULL,     -- always positive
  price           REAL NOT NULL,
  fees            REAL NOT NULL DEFAULT 0,
  thesis          TEXT,
  exit_rule       TEXT,
  committee_run_id INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (committee_run_id) REFERENCES committee_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol, date);

-- One lot per BUY. Tax-lot accounting lives here, not in positions.
CREATE TABLE IF NOT EXISTS lots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol            TEXT NOT NULL,
  open_trade_id     INTEGER NOT NULL,
  open_date         TEXT NOT NULL,
  shares_opened     REAL NOT NULL,
  shares_remaining  REAL NOT NULL,
  cost_per_share    REAL NOT NULL,   -- includes allocated fees
  basis_adjustment  REAL NOT NULL DEFAULT 0,  -- wash-sale disallowed loss added to basis
  FOREIGN KEY (open_trade_id) REFERENCES trades(id)
);
CREATE INDEX IF NOT EXISTS idx_lots_symbol ON lots(symbol, open_date);

CREATE TABLE IF NOT EXISTS lot_closures (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_id            INTEGER NOT NULL,
  close_trade_id    INTEGER NOT NULL,
  close_date        TEXT NOT NULL,
  shares            REAL NOT NULL,
  proceeds_per_share REAL NOT NULL,
  cost_per_share    REAL NOT NULL,
  realized_pnl      REAL NOT NULL,
  term              TEXT NOT NULL,   -- SHORT|LONG
  holding_days      INTEGER NOT NULL,
  wash_sale         INTEGER NOT NULL DEFAULT 0,
  disallowed_loss   REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (lot_id) REFERENCES lots(id),
  FOREIGN KEY (close_trade_id) REFERENCES trades(id)
);

CREATE TABLE IF NOT EXISTS daily_snapshots (
  date             TEXT PRIMARY KEY,
  cash             REAL NOT NULL,
  positions_value  REAL NOT NULL,
  total_value      REAL NOT NULL,
  net_contributions REAL NOT NULL,   -- cumulative deposits - withdrawals
  twr_index        REAL NOT NULL,    -- time-weighted return index, starts at 100
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS snapshot_holdings (
  date    TEXT NOT NULL,
  symbol  TEXT NOT NULL,
  shares  REAL NOT NULL,
  price   REAL NOT NULL,
  value   REAL NOT NULL,
  weight  REAL NOT NULL,
  PRIMARY KEY (date, symbol)
);

CREATE TABLE IF NOT EXISTS benchmark_snapshots (
  date       TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  close      REAL NOT NULL,
  twr_index  REAL NOT NULL,
  PRIMARY KEY (date, symbol)
);

-- ---------------------------------------------------------------- committee

CREATE TABLE IF NOT EXISTS committee_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  as_of_date       TEXT NOT NULL,    -- the trading day the context was built from
  symbol           TEXT NOT NULL,
  mandate          TEXT NOT NULL,    -- NEW_POSITION|REVIEW|EXIT
  status           TEXT NOT NULL,    -- RUNNING|COMPLETE|FAILED
  llm_mode         TEXT NOT NULL,    -- real|mock
  context_json     TEXT NOT NULL,
  context_hash     TEXT NOT NULL,
  final_action     TEXT,             -- BUY|HOLD|AVOID|TRIM|SELL
  final_confidence REAL,
  final_size_pct   REAL,
  elapsed_ms       INTEGER,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_symbol ON committee_runs(symbol, as_of_date);

-- Every agent call, verbatim in and out. Nothing is overwritten or deleted.
CREATE TABLE IF NOT EXISTS agent_outputs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL,
  seq            INTEGER NOT NULL,
  agent          TEXT NOT NULL,
  model          TEXT NOT NULL,
  system_prompt  TEXT NOT NULL,
  user_prompt    TEXT NOT NULL,
  raw_response   TEXT,
  output_json    TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  latency_ms     INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 1,
  error          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES committee_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_run ON agent_outputs(run_id, seq);

-- The calibration substrate: every falsifiable thing an agent said, with a deadline.
CREATE TABLE IF NOT EXISTS agent_claims (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL,
  agent          TEXT NOT NULL,
  claim_kind     TEXT NOT NULL,    -- see src/core/calibration/claims.ts
  subject        TEXT NOT NULL,    -- ticker / sector etf / 'PORTFOLIO'
  statement      TEXT NOT NULL,    -- human-readable, what was asserted
  direction      TEXT,             -- UP|DOWN|FLAT|OUTPERFORM|UNDERPERFORM|TRUE|FALSE
  threshold      REAL,             -- e.g. -0.12 for "drawdown stays above -12%"
  confidence     REAL NOT NULL,    -- 0..1, agent-stated
  made_on        TEXT NOT NULL,    -- as_of_date of the run
  horizon_days   INTEGER NOT NULL,
  resolve_after  TEXT NOT NULL,    -- made_on + horizon_days
  resolver       TEXT NOT NULL,    -- MECHANICAL|JUDGMENT
  status         TEXT NOT NULL DEFAULT 'OPEN',  -- OPEN|RESOLVED|VOID
  outcome        INTEGER,          -- 1 correct, 0 incorrect
  resolved_at    TEXT,
  resolution_note TEXT,
  resolution_data TEXT,
  FOREIGN KEY (run_id) REFERENCES committee_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_claims_open ON agent_claims(status, resolve_after);
CREATE INDEX IF NOT EXISTS idx_claims_agent ON agent_claims(agent, status);

CREATE TABLE IF NOT EXISTS calibration_reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at       TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  agent        TEXT NOT NULL,
  n_claims     INTEGER NOT NULL,
  n_correct    INTEGER NOT NULL,
  hit_rate     REAL NOT NULL,
  brier        REAL NOT NULL,
  brier_skill  REAL NOT NULL,      -- vs a base-rate forecaster; >0 means genuine skill
  avg_confidence REAL NOT NULL,
  overconfidence REAL NOT NULL,    -- avg_confidence - hit_rate
  buckets_json TEXT NOT NULL,
  notes        TEXT
);

CREATE TABLE IF NOT EXISTS research_notes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol           TEXT NOT NULL,
  date             TEXT NOT NULL,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  committee_run_id INTEGER,
  FOREIGN KEY (committee_run_id) REFERENCES committee_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_notes_symbol ON research_notes(symbol, date);
