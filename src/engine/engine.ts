import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { computeMultiplier, generateCrash } from './multiplier.js';
import { computeTier } from '../domain/tier.js';
import type { ActiveBet, Phase, PublicPlayer } from '../types.js';
import { publicRoundId } from '../types.js';

const WAITING_MS = 10_000;
const CRASHED_PAUSE_MS = 5_000;
const TICK_MS = 200;

interface PlayerRepoLike {
  ensureExists(apiKey: string): Promise<void>;
  getBalance(apiKey: string): Promise<number>;
  debit(client: PoolClient, apiKey: string, amount: number): Promise<number>;
  credit(client: PoolClient, apiKey: string, amount: number): Promise<number>;
}

interface RoundRepoLike {
  insertRunning(startedAt: Date, seed: string, client?: PoolClient): Promise<{ id: number }>;
  markCrashed(id: number, crashPoint: number): Promise<void>;
  maxId(): Promise<number>;
}

interface BetRepoLike {
  insertPlaced(client: PoolClient, roundId: number, apiKey: string, amount: number, auto: number | null, betId: string): Promise<{ id: string }>;
  markCashedOut(client: PoolClient, betId: string, multiplier: number, winAmount: number): Promise<void>;
  settleAllLost(roundId: number): Promise<void>;
  settleAllOrphaned(): Promise<void>;
  deleteById(client: PoolClient, betId: string): Promise<void>;
}

export interface EngineDeps {
  playerRepo: PlayerRepoLike;
  roundRepo: RoundRepoLike;
  betRepo: BetRepoLike;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
}

export interface EngineOptions {
  clock?: () => number;
  autoTimers?: boolean;       // false in tests
}

interface EngineState {
  phase: Phase;
  roundId: number;
  startedAt: Date | null;
  endsAt: Date | null;
  multiplier: number;
  crashPoint: number | null;
  seed: string;
  bets: Map<string, ActiveBet>;
  publicPlayers: Map<string, PublicPlayer>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export class Engine extends EventEmitter {
  private state: EngineState;
  private tickInterval: NodeJS.Timeout | null = null;
  private phaseTimer: NodeJS.Timeout | null = null;
  private readonly clock: () => number;
  private readonly autoTimers: boolean;

  constructor(private deps: EngineDeps, opts: EngineOptions = {}) {
    super();
    this.clock = opts.clock ?? Date.now;
    this.autoTimers = opts.autoTimers ?? true;
    this.state = {
      phase: 'waiting',
      roundId: 0,
      startedAt: null,
      endsAt: null,
      multiplier: 1.0,
      crashPoint: null,
      seed: '',
      bets: new Map(),
      publicPlayers: new Map(),
    };
  }

  // ── Public surface ─────────────────────────────────────
  async start(): Promise<void> {
    await this.deps.betRepo.settleAllOrphaned();
    // Seed the in-memory counter so the next 'phase:waiting' event labels
    // the upcoming round correctly after a process restart.
    this.state.roundId = await this.deps.roundRepo.maxId();
    this.advanceToWaiting();
  }

  getPhase(): Phase { return this.state.phase; }
  getState(): Readonly<EngineState> { return this.state; }

  async placeBet(apiKey: string, amount: number, autoCashOutAt: number | null): Promise<void> {
    if (this.state.phase !== 'waiting') {
      this.emit('bet:rejected', { apiKey, reason: 'betting_closed', message: 'Betting window is closed' });
      return;
    }
    if (this.state.bets.has(apiKey)) {
      this.emit('bet:rejected', { apiKey, reason: 'already_has_bet', message: 'You already have a bet in this round' });
      return;
    }
    if (autoCashOutAt !== null && autoCashOutAt < 1.01) {
      this.emit('bet:rejected', { apiKey, reason: 'invalid_auto_cashout', message: 'Auto cashout target must be ≥ 1.01' });
      return;
    }
    const betId = randomUUID();
    let balance: number;
    try {
      balance = await this.deps.withTransaction(async (c) => {
        return this.deps.playerRepo.debit(c, apiKey, amount);
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'INSUFFICIENT') {
        this.emit('bet:rejected', { apiKey, reason: 'insufficient_balance', message: 'Not enough balance' });
        return;
      }
      throw err;
    }
    if (this.state.phase !== 'waiting') {
      // window closed during the transaction — refund (no bet row was inserted)
      await this.deps.withTransaction(async (c) => {
        await this.deps.playerRepo.credit(c, apiKey, amount);
      });
      this.emit('bet:rejected', { apiKey, reason: 'betting_closed', message: 'Betting window closed during placement' });
      return;
    }
    this.state.bets.set(apiKey, {
      betId, apiKey, amount, autoCashOutAt, placedAt: new Date(this.clock()),
      balanceAtPlacement: balance,
    });
    this.state.publicPlayers.set(apiKey, {
      username: apiKey,
      amount,
      status: 'placed',
      multiplier: null,
    });
    this.emit('bet:placed', {
      apiKey, betId, roundId: publicRoundId(this.state.roundId + 1),
      amount, autoCashOutAt, balance,
    });
    this.emit('players:bet', { username: apiKey, amount });
  }

  async cashout(apiKey: string): Promise<void> {
    const bet = this.state.bets.get(apiKey);
    if (!bet) {
      this.emit('bet:rejected', { apiKey, reason: 'no_active_bet', message: 'You have no active bet' });
      return;
    }
    if (this.state.phase !== 'running') {
      this.emit('bet:rejected', { apiKey, reason: 'not_running', message: 'Round is not running' });
      return;
    }
    await this.settleCashout(bet, this.state.multiplier);
  }

  // ── State machine (called both by timers in production and by tests directly) ──
  advanceToWaiting(): void {
    this.state.phase = 'waiting';
    this.state.bets.clear();
    this.state.publicPlayers.clear();
    this.state.startedAt = null;
    this.state.crashPoint = null;
    this.state.multiplier = 1.0;
    const endsAt = new Date(this.clock() + WAITING_MS);
    this.state.endsAt = endsAt;
    const nextRoundIdLabel = publicRoundId(this.state.roundId + 1);  // tentative
    this.emit('phase:waiting', { roundId: nextRoundIdLabel, endsAt: endsAt.toISOString(), players: [] });
    if (this.autoTimers) {
      this.phaseTimer = setTimeout(() => { void this.advanceToRunning(); }, WAITING_MS);
    }
  }

  async advanceToRunning(): Promise<void> {
    this.clearPhaseTimer();
    if (this.state.crashPoint === null) {
      this.state.seed = randomBytes(32).toString('hex');
      this.state.crashPoint = generateCrash(this.state.seed);
    }
    this.state.startedAt = new Date(this.clock());
    await this.deps.withTransaction(async (c) => {
      const round = await this.deps.roundRepo.insertRunning(this.state.startedAt!, this.state.seed, c);
      this.state.roundId = round.id;
      for (const bet of this.state.bets.values()) {
        await this.deps.betRepo.insertPlaced(c, round.id, bet.apiKey, bet.amount, bet.autoCashOutAt, bet.betId);
      }
    });
    this.state.phase = 'running';
    this.state.multiplier = 1.0;
    this.state.endsAt = null;
    this.emit('phase:running', {
      roundId: publicRoundId(this.state.roundId),
      startedAt: this.state.startedAt.toISOString(),
      players: [...this.state.publicPlayers.values()],
    });
    if (this.state.multiplier >= this.state.crashPoint) {
      this.beginCrash();
      return;
    }
    if (this.autoTimers) {
      this.tickInterval = setInterval(() => this.tick(), TICK_MS);
    }
  }

  tick(): void {
    if (this.state.phase !== 'running' || this.state.startedAt === null || this.state.crashPoint === null) {
      return;
    }
    const elapsed = this.clock() - this.state.startedAt.getTime();
    const m = computeMultiplier(elapsed);
    this.state.multiplier = m;
    if (m >= this.state.crashPoint) {
      this.beginCrash();
      return;
    }
    // Process auto-cashouts (settle on target, not on current m)
    for (const bet of [...this.state.bets.values()]) {
      if (bet.autoCashOutAt !== null && m >= bet.autoCashOutAt) {
        this.beginCashout(bet, bet.autoCashOutAt);
      }
    }
    this.emit('tick', {
      roundId: publicRoundId(this.state.roundId),
      multiplier: m,
      elapsedMs: elapsed,
    });
  }

  /**
   * Synchronously transitions to crashed phase and emits all related events.
   * Fires DB writes in the background (fire-and-forget in production;
   * tests use instant-resolve fakes so the writes finish on next microtask).
   */
  private beginCrash(): void {
    if (this.state.phase === 'crashed') return;
    this.clearTickInterval();
    const cp = this.state.crashPoint!;
    this.state.multiplier = cp;
    this.state.phase = 'crashed';
    // Snapshot the bets BEFORE we mutate publicPlayers (we still need to iterate them for bet:lost emits)
    const remainingBets = [...this.state.bets.values()];
    // Mark each remaining bet as lost in publicPlayers
    for (const bet of remainingBets) {
      const existing = this.state.publicPlayers.get(bet.apiKey);
      if (existing) {
        this.state.publicPlayers.set(bet.apiKey, { ...existing, status: 'lost' });
      }
    }
    this.emit('phase:crashed', {
      roundId: publicRoundId(this.state.roundId),
      crashPoint: cp,
      tier: computeTier(cp),
      players: [...this.state.publicPlayers.values()],
    });
    for (const bet of remainingBets) {
      this.emit('bet:lost', {
        apiKey: bet.apiKey, betId: bet.betId, crashPoint: cp, balance: bet.balanceAtPlacement,
      });
      this.emit('players:lost', {
        username: bet.apiKey,
        amount: bet.amount,
      });
    }
    // Persist to DB asynchronously (fire and forget in production).
    void this.persistCrash(this.state.roundId, cp, remainingBets);
    if (this.autoTimers) {
      this.phaseTimer = setTimeout(() => this.advanceToWaiting(), CRASHED_PAUSE_MS);
    }
  }

  private async persistCrash(roundId: number, cp: number, bets: ActiveBet[]): Promise<void> {
    await this.deps.betRepo.settleAllLost(roundId);
    await this.deps.roundRepo.markCrashed(roundId, cp);
    // bets are no longer needed for persistence; emit events already
    // happened in beginCrash with balanceAtPlacement (correct value).
    void bets;
  }

  /**
   * Synchronously removes the bet from active bets and emits bet:cashedOut.
   * Persists to DB in the background.
   */
  private beginCashout(bet: ActiveBet, atMultiplier: number): void {
    this.state.bets.delete(bet.apiKey);
    const winAmount = round2(bet.amount * atMultiplier);
    const profit = round2(winAmount - bet.amount);
    const newBalance = bet.balanceAtPlacement + winAmount;
    // Update public snapshot
    const existing = this.state.publicPlayers.get(bet.apiKey);
    if (existing) {
      this.state.publicPlayers.set(bet.apiKey, {
        ...existing,
        status: 'cashed_out',
        multiplier: atMultiplier,
      });
    }
    // Emit synchronously — balance is computed from in-memory state (exact: balanceAtPlacement + winAmount).
    this.emit('bet:cashedOut', {
      apiKey: bet.apiKey,
      betId: bet.betId,
      multiplier: atMultiplier,
      winAmount,
      profit,
      balance: newBalance,
    });
    this.emit('players:cashout', {
      username: bet.apiKey,
      multiplier: atMultiplier,
      winAmount,
    });
    // Persist to DB asynchronously.
    void this.persistCashout(bet, atMultiplier, winAmount);
  }

  // ── Internals ──────────────────────────────────────────
  private async settleCashout(bet: ActiveBet, atMultiplier: number): Promise<void> {
    this.state.bets.delete(bet.apiKey);
    const winAmount = round2(bet.amount * atMultiplier);
    const profit = round2(winAmount - bet.amount);
    const balance = await this.deps.withTransaction(async (c) => {
      await this.deps.betRepo.markCashedOut(c, bet.betId, atMultiplier, winAmount);
      return this.deps.playerRepo.credit(c, bet.apiKey, winAmount);
    });
    // Update public snapshot
    const existing = this.state.publicPlayers.get(bet.apiKey);
    if (existing) {
      this.state.publicPlayers.set(bet.apiKey, {
        ...existing,
        status: 'cashed_out',
        multiplier: atMultiplier,
      });
    }
    this.emit('bet:cashedOut', {
      apiKey: bet.apiKey, betId: bet.betId, multiplier: atMultiplier, winAmount, profit, balance,
    });
    this.emit('players:cashout', {
      username: bet.apiKey,
      multiplier: atMultiplier,
      winAmount,
    });
  }

  private async persistCashout(bet: ActiveBet, atMultiplier: number, winAmount: number): Promise<void> {
    await this.deps.withTransaction(async (c) => {
      await this.deps.betRepo.markCashedOut(c, bet.betId, atMultiplier, winAmount);
      await this.deps.playerRepo.credit(c, bet.apiKey, winAmount);
    });
  }

  private clearTickInterval() {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
  }
  private clearPhaseTimer() {
    if (this.phaseTimer) { clearTimeout(this.phaseTimer); this.phaseTimer = null; }
  }

  /** TEST-ONLY: pin the next crashPoint to a known value. */
  __setCrashPointForTest(cp: number): void {
    this.state.crashPoint = cp;
    this.state.seed = '__test__';
  }
}
