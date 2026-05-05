import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import * as playerRepo from './playerRepo.js';
import * as roundRepo from './roundRepo.js';
import * as betRepo from './betRepo.js';

beforeAll(async () => {
  // Sanity: ensure the schema exists. Run `npm run migrate` first.
  await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'players'");
});

beforeEach(async () => {
  await pool.query('TRUNCATE bets, rounds, players CASCADE');
});

afterAll(async () => {
  await pool.end();
});

describe('playerRepo', () => {
  it('ensureExists creates a new player with starting balance 10000', async () => {
    await playerRepo.ensureExists('alice');
    const balance = await playerRepo.getBalance('alice');
    expect(balance).toBe(10_000);
  });

  it('ensureExists is idempotent for the same key', async () => {
    await playerRepo.ensureExists('bob');
    await playerRepo.ensureExists('bob');
    expect(await playerRepo.getBalance('bob')).toBe(10_000);
  });

  it('debit reduces balance and returns new balance', async () => {
    await playerRepo.ensureExists('carol');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const balance = await playerRepo.debit(client, 'carol', 250);
      await client.query('COMMIT');
      expect(balance).toBe(9_750);
    } finally {
      client.release();
    }
  });

  it('debit throws INSUFFICIENT when balance is too low', async () => {
    await playerRepo.ensureExists('dave');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(playerRepo.debit(client, 'dave', 100_000)).rejects.toThrow('INSUFFICIENT');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('credit increases balance and returns new balance', async () => {
    await playerRepo.ensureExists('eve');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const balance = await playerRepo.credit(client, 'eve', 500);
      await client.query('COMMIT');
      expect(balance).toBe(10_500);
    } finally {
      client.release();
    }
  });
});

describe('roundRepo', () => {
  it('insertRunning returns a numeric id and stores started_at + seed', async () => {
    const round = await roundRepo.insertRunning(new Date(), 'deadbeef');
    expect(typeof round.id).toBe('number');
    expect(round.id).toBeGreaterThan(0);
  });

  it('markCrashed updates status, crash_point and crashed_at', async () => {
    const round = await roundRepo.insertRunning(new Date(), 'cafe');
    await roundRepo.markCrashed(round.id, 2.31);
    const result = await pool.query(
      'SELECT status, crash_point FROM rounds WHERE id = $1',
      [round.id],
    );
    expect(result.rows[0].status).toBe('crashed');
    expect(Number(result.rows[0].crash_point)).toBe(2.31);
  });

  it('listRecent returns crashed rounds in reverse chronological order', async () => {
    const r1 = await roundRepo.insertRunning(new Date(Date.now() - 2000), 'a');
    const r2 = await roundRepo.insertRunning(new Date(Date.now() - 1000), 'b');
    await roundRepo.markCrashed(r1.id, 1.5);
    await roundRepo.markCrashed(r2.id, 3.0);
    const list = await roundRepo.listRecent(10);
    expect(list).toHaveLength(2);
    expect(list[0].crashPoint).toBe(3.0);
    expect(list[1].crashPoint).toBe(1.5);
  });
});

describe('betRepo', () => {
  it('insertPlaced creates a placed bet and rejects a second bet for same round/player', async () => {
    await playerRepo.ensureExists('frank');
    const round = await roundRepo.insertRunning(new Date(), 'seed');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const frankBetId = randomUUID();
      const bet = await betRepo.insertPlaced(client, round.id, 'frank', 100, null, frankBetId);
      expect(bet.id).toBe(frankBetId);
      await expect(
        betRepo.insertPlaced(client, round.id, 'frank', 50, null, randomUUID()),
      ).rejects.toMatchObject({ code: '23505' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('markCashedOut updates status, multiplier, win_amount, settled_at', async () => {
    await playerRepo.ensureExists('grace');
    const round = await roundRepo.insertRunning(new Date(), 'seed');
    const client = await pool.connect();
    let betId: string;
    try {
      await client.query('BEGIN');
      const bet = await betRepo.insertPlaced(client, round.id, 'grace', 100, 2.0, randomUUID());
      betId = bet.id;
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const client2 = await pool.connect();
    try {
      await client2.query('BEGIN');
      await betRepo.markCashedOut(client2, betId!, 2.0, 200);
      await client2.query('COMMIT');
    } finally {
      client2.release();
    }
    const result = await pool.query('SELECT status, cashout_multiplier, win_amount FROM bets WHERE id = $1', [betId!]);
    expect(result.rows[0].status).toBe('cashed_out');
    expect(Number(result.rows[0].cashout_multiplier)).toBe(2.0);
    expect(Number(result.rows[0].win_amount)).toBe(200);
  });

  it('settleAllLost marks all placed bets in a round as lost', async () => {
    await playerRepo.ensureExists('henry');
    await playerRepo.ensureExists('iris');
    const round = await roundRepo.insertRunning(new Date(), 'seed');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await betRepo.insertPlaced(c, round.id, 'henry', 100, null, randomUUID());
      await betRepo.insertPlaced(c, round.id, 'iris', 200, null, randomUUID());
      await c.query('COMMIT');
    } finally { c.release(); }
    await betRepo.settleAllLost(round.id);
    const r = await pool.query("SELECT status FROM bets WHERE round_id = $1", [round.id]);
    expect(r.rows.every(row => row.status === 'lost')).toBe(true);
  });

  it('deleteById removes the bet row (used for refund)', async () => {
    await playerRepo.ensureExists('jane');
    const round = await roundRepo.insertRunning(new Date(), 'seed');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const bet = await betRepo.insertPlaced(c, round.id, 'jane', 100, null, randomUUID());
      await betRepo.deleteById(c, bet.id);
      await c.query('COMMIT');
    } finally { c.release(); }
    const r = await pool.query("SELECT 1 FROM bets WHERE api_key = 'jane'");
    expect(r.rowCount).toBe(0);
  });

});
