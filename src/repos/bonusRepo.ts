import { withTransaction } from '../db.js';

const BONUS_AMOUNT = 100;
const COOLDOWN_MS = 10 * 60 * 1000;

export interface BonusClaimResult {
  claimed: boolean;
  amount: number;
  balance: number;
  claimedAt: Date;
  nextClaimAt: Date;
  retryAfterMs: number;
}

export async function claimBonus(apiKey: string, now = new Date()): Promise<BonusClaimResult> {
  return withTransaction(async (client) => {
    const player = await client.query<{ balance: string }>(
      'SELECT balance FROM players WHERE api_key = $1 FOR UPDATE',
      [apiKey],
    );
    if (player.rowCount === 0) throw new Error('PLAYER_NOT_FOUND');

    const currentBalance = Number(player.rows[0].balance);
    const latestClaim = await client.query<{ claimed_at: Date }>(
      `SELECT claimed_at
         FROM player_bonus_claims
        WHERE api_key = $1
        ORDER BY claimed_at DESC
        LIMIT 1`,
      [apiKey],
    );

    const previousClaimAt = latestClaim.rows[0]?.claimed_at;
    if (previousClaimAt) {
      const nextClaimAt = new Date(previousClaimAt.getTime() + COOLDOWN_MS);
      if (now.getTime() < nextClaimAt.getTime()) {
        return {
          claimed: false,
          amount: BONUS_AMOUNT,
          balance: currentBalance,
          claimedAt: previousClaimAt,
          nextClaimAt,
          retryAfterMs: nextClaimAt.getTime() - now.getTime(),
        };
      }
    }

    await client.query(
      `INSERT INTO player_bonus_claims (api_key, amount, claimed_at)
       VALUES ($1, $2, $3)`,
      [apiKey, BONUS_AMOUNT, now],
    );
    const updated = await client.query<{ balance: string }>(
      'UPDATE players SET balance = balance + $1 WHERE api_key = $2 RETURNING balance',
      [BONUS_AMOUNT, apiKey],
    );
    const nextClaimAt = new Date(now.getTime() + COOLDOWN_MS);

    return {
      claimed: true,
      amount: BONUS_AMOUNT,
      balance: Number(updated.rows[0].balance),
      claimedAt: now,
      nextClaimAt,
      retryAfterMs: 0,
    };
  });
}
