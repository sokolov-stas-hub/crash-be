CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
    api_key      TEXT PRIMARY KEY,
    balance      NUMERIC(12, 2) NOT NULL DEFAULT 10000.00,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE round_status AS ENUM ('running', 'crashed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS rounds (
    id           BIGSERIAL PRIMARY KEY,
    status       round_status NOT NULL,
    started_at   TIMESTAMPTZ  NOT NULL,
    crashed_at   TIMESTAMPTZ,
    crash_point  NUMERIC(10, 4),
    seed         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS rounds_crashed_at_idx
    ON rounds (crashed_at DESC) WHERE status = 'crashed';

-- ────────────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE bet_status AS ENUM ('placed', 'cashed_out', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS bets (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    round_id           BIGINT NOT NULL REFERENCES rounds(id),
    api_key            TEXT   NOT NULL REFERENCES players(api_key),
    amount             NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    auto_cashout_at    NUMERIC(10, 4),
    status             bet_status NOT NULL DEFAULT 'placed',
    cashout_multiplier NUMERIC(10, 4),
    win_amount         NUMERIC(12, 2),
    placed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS bets_one_per_round_per_player
    ON bets (round_id, api_key);

CREATE INDEX IF NOT EXISTS bets_player_placed_idx
    ON bets (api_key, placed_at DESC);
