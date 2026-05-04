import { pool } from '../db.js';
import type { PoolClient } from 'pg';
import type { HistoryBet } from '../types.js';
import { publicRoundId } from '../types.js';

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

interface BetRow {
  id: string;
  round_id: string;
  api_key: string;
  amount: string;
  auto_cashout_at: string | null;
  status: 'placed' | 'cashed_out' | 'lost';
  cashout_multiplier: string | null;
  win_amount: string | null;
  placed_at: Date;
  settled_at: Date | null;
}

export async function listForPlayer(
  apiKey: string,
  limit: number,
): Promise<Array<HistoryBet & { apiKey: string }>> {
  const r = await pool.query<BetRow>(
    `SELECT id, round_id, api_key, amount, auto_cashout_at, status,
            cashout_multiplier, win_amount, placed_at, settled_at
       FROM bets
      WHERE api_key = $1
      ORDER BY placed_at DESC
      LIMIT $2`,
    [apiKey, limit],
  );
  return r.rows.map(row => {
    const amount = Number(row.amount);
    const winAmount = row.win_amount === null ? null : Number(row.win_amount);
    return {
      betId: row.id,
      roundId: publicRoundId(Number(row.round_id)),
      apiKey: row.api_key,
      amount,
      autoCashOutAt: row.auto_cashout_at === null ? null : Number(row.auto_cashout_at),
      status: row.status,
      multiplier: row.cashout_multiplier === null ? null : Number(row.cashout_multiplier),
      winAmount,
      profit: winAmount === null ? null : Math.round((winAmount - amount) * 100) / 100,
      placedAt: row.placed_at.toISOString(),
      settledAt: row.settled_at?.toISOString() ?? null,
    };
  });
}
