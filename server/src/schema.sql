CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  base_symbol TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  base_mint TEXT,
  quote_mint TEXT,
  quote_decimals INT NOT NULL,
  status TEXT NOT NULL,
  crop TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS epochs (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  epoch_id BIGINT NOT NULL,
  status TEXT NOT NULL,
  total_raw TEXT NOT NULL,
  total_weight TEXT NOT NULL,
  draw_slot BIGINT NOT NULL,
  depositor_count INT NOT NULL DEFAULT 0,
  winner TEXT,
  prize_raw TEXT,
  reserve_cut_raw TEXT,
  treasury_cut_raw TEXT,
  seed_hex TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, epoch_id)
);

CREATE TABLE IF NOT EXISTS depositors (
  vault_id TEXT NOT NULL,
  epoch_id BIGINT NOT NULL,
  wallet TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  weight TEXT NOT NULL,
  refunded BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (vault_id, epoch_id, wallet)
);

CREATE TABLE IF NOT EXISTS sweeps (
  id BIGSERIAL PRIMARY KEY,
  vault_id TEXT NOT NULL,
  epoch_id BIGINT NOT NULL,
  wallet TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  signature TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  slot BIGINT,
  weight TEXT
);

ALTER TABLE sweeps ADD COLUMN IF NOT EXISTS slot BIGINT;
ALTER TABLE sweeps ADD COLUMN IF NOT EXISTS weight TEXT;

CREATE TABLE IF NOT EXISTS distributions (
  signature TEXT PRIMARY KEY,
  vault_id TEXT,
  quote_mint TEXT,
  occurred_at TIMESTAMPTZ,
  raw_amount TEXT,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watch_wallets (
  wallet TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oracle_requests (
  vault_id TEXT NOT NULL,
  epoch_id BIGINT NOT NULL,
  seed_hex TEXT NOT NULL,
  request_pda TEXT,
  status TEXT NOT NULL,
  randomness_hex TEXT,
  settle_seed_hex TEXT,
  error TEXT,
  rng_secret TEXT,
  requested_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ,
  PRIMARY KEY (vault_id, epoch_id)
);

CREATE TABLE IF NOT EXISTS yield_sleeves (
  id BIGSERIAL PRIMARY KEY,
  vault_id TEXT NOT NULL,
  source TEXT NOT NULL,
  epoch_id BIGINT,
  sleeve TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, source, epoch_id, sleeve)
);

CREATE TABLE IF NOT EXISTS clash_state (
  id INT PRIMARY KEY DEFAULT 1,
  clash_pot_usd NUMERIC NOT NULL DEFAULT 0,
  jackpot_pot_usd NUMERIC NOT NULL DEFAULT 0,
  jackpot_chance_bps INT NOT NULL DEFAULT 500,
  week_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('week', now())
);

INSERT INTO clash_state (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE oracle_requests ADD COLUMN IF NOT EXISTS rng_secret TEXT;

DELETE FROM yield_sleeves WHERE source = 'settle_reserve';

CREATE TABLE IF NOT EXISTS productive_wallet (
  id INT PRIMARY KEY DEFAULT 1,
  wallet TEXT,
  watermark_raw TEXT NOT NULL DEFAULT '0',
  lp_quote_raw TEXT NOT NULL DEFAULT '0',
  lp_pool TEXT
);
INSERT INTO productive_wallet (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS prices (
  mint TEXT PRIMARY KEY,
  usd NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS keeper_heartbeats (
  id TEXT PRIMARY KEY,
  last_run TIMESTAMPTZ,
  last_ok BOOLEAN,
  last_error TEXT,
  detail TEXT
);

ALTER TABLE distributions ADD COLUMN IF NOT EXISTS base_mint TEXT;

CREATE TABLE IF NOT EXISTS sweep_origins (
  vault_id TEXT NOT NULL,
  epoch_id BIGINT NOT NULL,
  origin_id TEXT NOT NULL,
  amount_raw TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (vault_id, epoch_id, origin_id)
);

CREATE TABLE IF NOT EXISTS used_payouts (
  signature TEXT NOT NULL,
  wallet TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  used_raw TEXT NOT NULL,
  PRIMARY KEY (signature, wallet, vault_id)
);
