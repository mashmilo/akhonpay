CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  webhook_secret TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS payment_sessions (
  id TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  order_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  redirect_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | paid | expired
  trx_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  webhook_status TEXT NOT NULL DEFAULT 'none', -- none | pending | delivered | failed
  webhook_attempts INTEGER NOT NULL DEFAULT 0,
  next_webhook_at INTEGER
);
-- An order can only ever be paid once
CREATE UNIQUE INDEX IF NOT EXISTS one_paid_per_order
  ON payment_sessions(client_id, order_id) WHERE status = 'paid';
CREATE INDEX IF NOT EXISTS idx_sessions_order ON payment_sessions(client_id, order_id);
CREATE INDEX IF NOT EXISTS idx_sessions_webhook ON payment_sessions(webhook_status, next_webhook_at);

CREATE TABLE IF NOT EXISTS unclaimed_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trx_id TEXT NOT NULL UNIQUE,                 -- replay protection
  provider TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  sender TEXT,
  sms_ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unclaimed',    -- unclaimed | claimed
  claimed_session TEXT,
  claimed_at INTEGER
);

-- v1
