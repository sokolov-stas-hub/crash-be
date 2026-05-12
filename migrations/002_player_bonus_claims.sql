CREATE TABLE IF NOT EXISTS player_bonus_claims (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key     TEXT NOT NULL REFERENCES players(api_key),
    amount      NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS player_bonus_claims_api_key_claimed_at_idx
    ON player_bonus_claims (api_key, claimed_at DESC);
