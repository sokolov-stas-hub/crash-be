import { pool } from '../db.js';
import type { PoolClient } from 'pg';

export async function insertPlaced(
  client: PoolClient,
  roundId: number,
  apiKey: string,
  amount: number,
  autoCashOutAt: number | null,
  betId: string,
): Promise<{ id: string }> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO bets (id, round_id, api_key, amount, auto_cashout_at)
          VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
    [betId, roundId, apiKey, amount, autoCashOutAt],
  );
  return { id: r.rows[0].id };
}

export async function markCashedOut(
  client: PoolClient,
  betId: string,
  multiplier: number,
  winAmount: number,
): Promise<void> {
  await client.query(
    `UPDATE bets
        SET status = 'cashed_out',
            cashout_multiplier = $1,
            win_amount = $2,
            settled_at = now()
      WHERE id = $3`,
    [multiplier, winAmount, betId],
  );
}

export async function settleAllLost(roundId: number): Promise<void> {
  await pool.query(
    `UPDATE bets
        SET status = 'lost', settled_at = now()
      WHERE round_id = $1 AND status = 'placed'`,
    [roundId],
  );
}

export async function settleAllOrphaned(): Promise<void> {
  // Run on engine boot: any 'placed' bet from a previous (interrupted) process
  await pool.query(
    `UPDATE bets
        SET status = 'lost', settled_at = now()
      WHERE status = 'placed'`,
  );
}

export async function deleteById(client: PoolClient, betId: string): Promise<void> {
  await client.query('DELETE FROM bets WHERE id = $1', [betId]);
}
