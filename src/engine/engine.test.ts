import { describe, it, expect, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { Engine, type EngineDeps } from './engine.js';

// ── Hand-rolled fakes (clearer than vi.mock for this kind of test) ──
function makeFakes() {
  const balances = new Map<string, number>([['alice', 1000], ['bob', 1000]]);
  let roundCounter = 0;
  const insertedBets: Array<{ id: string; roundId: number; apiKey: string; amount: number; auto: number | null }> = [];
  const settledLost: number[] = [];
  const cashedOut: Array<{ betId: string; multiplier: number; winAmount: number }> = [];

  const playerRepo = {
    ensureExists: async () => {},
    getBalance: async (apiKey: string) => balances.get(apiKey) ?? 0,
    debit: async (_c: unknown, apiKey: string, amount: number) => {
      const cur = balances.get(apiKey) ?? 0;
      if (cur < amount) {
        const e = new Error('INSUFFICIENT');
        (e as Error & { code: string }).code = 'INSUFFICIENT';
        throw e;
      }
      balances.set(apiKey, cur - amount);
      return cur - amount;
    },
    credit: async (_c: unknown, apiKey: string, amount: number) => {
      const cur = balances.get(apiKey) ?? 0;
      balances.set(apiKey, cur + amount);
      return cur + amount;
    },
  };

  const roundRepo = {
    insertRunning: async (_startedAt: Date, _seed: string, _client?: unknown) => ({ id: ++roundCounter }),
    markCrashed: async () => {},
    maxId: async () => 0,
  };

  const betRepo = {
    insertPlaced: async (_c: unknown, roundId: number, apiKey: string, amount: number, auto: number | null, betId: string) => {
      insertedBets.push({ id: betId, roundId, apiKey, amount, auto });
      return { id: betId };
    },
    markCashedOut: async (_c: unknown, betId: string, multiplier: number, winAmount: number) => {
      cashedOut.push({ betId, multiplier, winAmount });
    },
    settleAllLost: async (roundId: number) => { settledLost.push(roundId); },
    settleAllOrphaned: async () => {},
    deleteById: async () => {},
  };

  // Mock withTransaction to just call the callback with a fake client
  const withTransaction = async <T,>(fn: (c: PoolClient) => Promise<T>) => fn({} as PoolClient);

  const deps: EngineDeps = { playerRepo, roundRepo, betRepo, withTransaction };
  return { deps, balances, insertedBets, settledLost, cashedOut };
}

function makeClock(start = 0) {
  let now = start;
  return {
    fn: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

describe('Engine', () => {
  let fakes: ReturnType<typeof makeFakes>;
  let clock: ReturnType<typeof makeClock>;
  let engine: Engine;
  let events: Array<{ name: string; payload: unknown }>;

  beforeEach(async () => {
    fakes = makeFakes();
    clock = makeClock(1_700_000_000_000);
    engine = new Engine(fakes.deps, { clock: clock.fn, autoTimers: false });
    events = [];
    for (const name of [
      'phase:waiting', 'phase:running', 'phase:crashed', 'tick',
      'bet:placed', 'bet:cashedOut', 'bet:lost', 'bet:rejected',
      'players:bet', 'players:cashout', 'players:lost',
    ]) {
      engine.on(name, payload => events.push({ name, payload }));
    }
    await engine.start();
  });

  it('starts in waiting phase and emits phase:waiting', () => {
    expect(engine.getPhase()).toBe('waiting');
    expect(events.find(e => e.name === 'phase:waiting')).toBeDefined();
  });

  it('placeBet during waiting succeeds and debits balance', async () => {
    await engine.placeBet('alice', 100, null);
    expect(fakes.balances.get('alice')).toBe(900);
    const placed = events.find(e => e.name === 'bet:placed');
    expect(placed).toBeDefined();
    expect(placed!.payload).toMatchObject({ apiKey: 'alice', amount: 100, balance: 900 });
    expect(placed!.payload).toMatchObject({ roundId: 'round_1' });
    const playersBet = events.find(e => e.name === 'players:bet');
    expect(playersBet).toBeDefined();
    expect(playersBet!.payload).toEqual({ username: 'alice', amount: 100 });
  });

  it('placeBet rejects a second bet from the same player', async () => {
    await engine.placeBet('alice', 100, null);
    await engine.placeBet('alice', 50, null);
    const rejected = events.filter(e => e.name === 'bet:rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0].payload as { reason: string }).reason).toBe('already_has_bet');
  });

  it('placeBet rejects on insufficient balance', async () => {
    await engine.placeBet('alice', 99_999, null);
    const rejected = events.find(e => e.name === 'bet:rejected');
    expect((rejected!.payload as { reason: string }).reason).toBe('insufficient_balance');
  });

  it('placeBet during running is rejected', async () => {
    await engine.advanceToRunning();
    await engine.placeBet('alice', 100, null);
    const rejected = events.find(e => e.name === 'bet:rejected');
    expect((rejected!.payload as { reason: string }).reason).toBe('betting_closed');
  });

  it('manual cashout returns winAmount = bet × current multiplier', async () => {
    await engine.placeBet('alice', 100, null);
    // Force a known crash point so we don't crash mid-test.
    engine.__setCrashPointForTest(99.0);
    await engine.advanceToRunning();
    clock.advance(5000);  // multiplier ≈ 1.34
    engine.tick();
    await engine.cashout('alice');
    const cashed = events.find(e => e.name === 'bet:cashedOut');
    expect(cashed).toBeDefined();
    const p = cashed!.payload as { multiplier: number; winAmount: number };
    expect(p.multiplier).toBeGreaterThan(1.3);
    expect(p.multiplier).toBeLessThan(1.4);
    expect(p.winAmount).toBeCloseTo(100 * p.multiplier, 2);
    const playersCash = events.find(e => e.name === 'players:cashout');
    expect(playersCash).toBeDefined();
    expect((playersCash!.payload as { username: string }).username).toBe('alice');
  });

  it('auto cashout settles on TARGET, not on current tick value', async () => {
    await engine.placeBet('alice', 100, 1.5);
    engine.__setCrashPointForTest(99.0);
    await engine.advanceToRunning();
    clock.advance(8000);  // multiplier ≈ 1.61, well past 1.5 target
    engine.tick();
    const cashed = events.find(e => e.name === 'bet:cashedOut');
    expect(cashed).toBeDefined();
    const p = cashed!.payload as { multiplier: number; winAmount: number; balance: number };
    expect(p.multiplier).toBe(1.5);          // target, not 1.61
    expect(p.winAmount).toBe(150);
    // alice: 1000 starting → 100 bet → 900 placement balance → +150 win = 1050
    expect(p.balance).toBe(1050);
    const playersCash = events.find(e => e.name === 'players:cashout');
    expect(playersCash).toBeDefined();
    expect(playersCash!.payload).toEqual({ username: 'alice', multiplier: 1.5, winAmount: 150 });
  });

  it('crash check fires before auto-cashout when both would trigger', async () => {
    await engine.placeBet('alice', 100, 1.10);
    engine.__setCrashPointForTest(1.05);
    await engine.advanceToRunning();
    clock.advance(2000);  // multiplier ≈ 1.12, both conditions met
    engine.tick();
    expect(events.find(e => e.name === 'bet:cashedOut')).toBeUndefined();
    expect(events.find(e => e.name === 'phase:crashed')).toBeDefined();
    expect(events.find(e => e.name === 'bet:lost')).toBeDefined();
  });

  it('crash transitions phase, marks bets lost, broadcasts crashPoint', async () => {
    await engine.placeBet('alice', 100, null);
    engine.__setCrashPointForTest(1.5);
    await engine.advanceToRunning();
    clock.advance(8000);
    engine.tick();
    expect(engine.getPhase()).toBe('crashed');
    const crash = events.find(e => e.name === 'phase:crashed');
    expect(crash).toBeDefined();
    expect((crash!.payload as { crashPoint: number }).crashPoint).toBe(1.5);
    const lost = events.find(e => e.name === 'bet:lost');
    expect(lost).toBeDefined();
    const lostPayload = lost!.payload as { balance: number; betId: string };
    expect(lostPayload.balance).toBe(900);   // 1000 starting - 100 bet

    const crashPayload = crash!.payload as { tier: string; players: Array<{ status: string }> };
    // crashPoint is 1.5 → mid per computeTier (1.5 boundary)
    expect(crashPayload.tier).toBe('mid');
    expect(crashPayload.players).toHaveLength(1);
    expect(crashPayload.players[0].status).toBe('lost');

    const playersLost = events.find(e => e.name === 'players:lost');
    expect(playersLost).toBeDefined();
    expect(playersLost!.payload).toEqual({ username: 'alice', amount: 100 });
  });

  it('cashout after crash returns bet:rejected reason not_running', async () => {
    await engine.placeBet('alice', 100, null);
    engine.__setCrashPointForTest(1.5);
    await engine.advanceToRunning();
    clock.advance(8000);
    engine.tick();
    await engine.cashout('alice');
    const rejected = events.find(e => e.name === 'bet:rejected');
    expect((rejected!.payload as { reason: string }).reason).toBe('not_running');
  });

  it('emits tick events during running with monotonic multiplier', async () => {
    engine.__setCrashPointForTest(99.0);
    await engine.advanceToRunning();
    clock.advance(1000); engine.tick();
    clock.advance(1000); engine.tick();
    const ticks = events.filter(e => e.name === 'tick');
    expect(ticks.length).toBe(2);
    const m1 = (ticks[0].payload as { multiplier: number }).multiplier;
    const m2 = (ticks[1].payload as { multiplier: number }).multiplier;
    expect(m2).toBeGreaterThan(m1);
  });

  it('engine publicPlayers only tracks current-round bet participants', async () => {
    await engine.placeBet('alice', 100, null);

    expect(engine.getState().publicPlayers.has('alice')).toBe(true);
    expect(engine.getState().publicPlayers.has('bob')).toBe(false);
    expect([...engine.getState().publicPlayers.values()]).toEqual([
      { username: 'alice', amount: 100, status: 'placed', multiplier: null },
    ]);
  });

  it('publicPlayers is cleared on advanceToWaiting', async () => {
    await engine.placeBet('alice', 100, null);
    expect(engine.getState().publicPlayers.size).toBe(1);
    // Trigger transition through running → crashed
    engine.__setCrashPointForTest(1.5);
    await engine.advanceToRunning();
    clock.advance(8000);
    engine.tick();   // crashes
    // After crash, publicPlayers still has alice marked 'lost'
    expect(engine.getState().publicPlayers.size).toBe(1);
    expect(engine.getState().publicPlayers.get('alice')?.status).toBe('lost');
    // Now go back to waiting
    engine.advanceToWaiting();
    expect(engine.getState().publicPlayers.size).toBe(0);
  });
});
