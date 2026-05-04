import { pool } from '../db.js';
import type { PoolClient } from 'pg';

export async function ensureExists(apiKey: string): Promise<void> {
  await pool.query(
    'INSERT INTO players (api_key) VALUES ($1) ON CONFLICT (api_key) DO NOTHING',
    [apiKey],
  );
}

export async function getBalance(apiKey: string): Promise<number> {
  const r = await pool.query<{ balance: string }>(
    'SELECT balance FROM players WHERE api_key = $1',
    [apiKey],
  );
  if (r.rowCount === 0) throw new Error('PLAYER_NOT_FOUND');
  return Number(r.rows[0].balance);
}

export async function debit(
  client: PoolClient,
  apiKey: string,
  amount: number,
): Promise<number> {
  const lock = await client.query<{ balance: string }>(
    'SELECT balance FROM players WHERE api_key = $1 FOR UPDATE',
    [apiKey],
  );
  if (lock.rowCount === 0) throw new Error('PLAYER_NOT_FOUND');
  const current = Number(lock.rows[0].balance);
  if (current < amount) {
    const err = new Error('INSUFFICIENT');
    (err as Error & { code: string }).code = 'INSUFFICIENT';
    throw err;
  }
  const r = await client.query<{ balance: string }>(
    'UPDATE players SET balance = balance - $1 WHERE api_key = $2 RETURNING balance',
    [amount, apiKey],
  );
  return Number(r.rows[0].balance);
}

export async function credit(
  client: PoolClient,
  apiKey: string,
  amount: number,
): Promise<number> {
  const r = await client.query<{ balance: string }>(
    'UPDATE players SET balance = balance + $1 WHERE api_key = $2 RETURNING balance',
    [amount, apiKey],
  );
  if (r.rowCount === 0) throw new Error('PLAYER_NOT_FOUND');
  return Number(r.rows[0].balance);
}
