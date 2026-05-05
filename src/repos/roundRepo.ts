import { pool } from '../db.js';
import type { PoolClient } from 'pg';
import type { RecentRound } from '../types.js';
import { publicRoundId } from '../types.js';
import { computeTier } from '../domain/tier.js';

export async function insertRunning(
  startedAt: Date,
  seed: string,
  client?: PoolClient,
): Promise<{ id: number }> {
  const target = client ?? pool;
  const r = await target.query<{ id: string }>(
    `INSERT INTO rounds (status, started_at, seed)
          VALUES ('running', $1, $2)
       RETURNING id`,
    [startedAt, seed],
  );
  return { id: Number(r.rows[0].id) };
}

export async function markCrashed(id: number, crashPoint: number): Promise<void> {
  await pool.query(
    `UPDATE rounds
        SET status = 'crashed', crash_point = $1, crashed_at = now()
      WHERE id = $2`,
    [crashPoint, id],
  );
}

export async function maxId(): Promise<number> {
  const r = await pool.query<{ max: string | null }>('SELECT MAX(id)::text AS max FROM rounds');
  return Number(r.rows[0].max ?? 0);
}

export async function listRecent(limit: number): Promise<RecentRound[]> {
  const r = await pool.query<{ id: string; crash_point: string; crashed_at: Date }>(
    `SELECT id, crash_point, crashed_at
       FROM rounds
      WHERE status = 'crashed'
      ORDER BY crashed_at DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows.map(row => {
    const cp = Number(row.crash_point);
    return {
      roundId: publicRoundId(Number(row.id)),
      crashPoint: cp,
      crashedAt: row.crashed_at.toISOString(),
      tier: computeTier(cp),
    };
  });
}
