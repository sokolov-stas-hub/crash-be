# Live Players + Round Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Live Players panel feed (`PublicPlayer[]` snapshots + `players:bet`/`players:cashout`/`players:lost` diff events), classify recent rounds with a server-computed `tier` (low/mid/high), and remove the unused `/api/history` endpoint.

**Architecture:** Engine gains a parallel `publicPlayers: Map<apiKey, PublicPlayer>` that mirrors `bets` plus retains cashed-out/lost entries until the next round. Phase events (`round:state`/`waiting`/`start`/`crash`) drop `playerCount` and embed `players: PublicPlayer[]` snapshots. New public events (`players:*`) are dual-emitted alongside the existing player-targeted `bet:*` events by the broadcast adapter. `tier` is a pure function applied at read time in `roundRepo.listRecent` and in the engine's `round:crash` payload.

**Tech Stack:** TypeScript · Node 22 · Express 4 · Socket.IO 4 · `pg` · zod · Vitest. Spec at `docs/superpowers/specs/2026-05-05-live-players-and-tier-design.md`.

---

## File Structure

```
NEW:
  src/domain/tier.ts                      # computeTier() pure function
  src/domain/tier.test.ts                 # boundary cases

MODIFIED:
  src/types.ts                            # add RoundTier + PublicPlayer; modify event types; drop history types
  src/repos/roundRepo.ts                  # listRecent populates tier
  src/repos/repos.test.ts                 # update listRecent test, drop listForPlayer test
  src/repos/betRepo.ts                    # drop listForPlayer + BetRow
  src/engine/engine.ts                    # publicPlayers state, emit players:*, modified phase event payloads
  src/engine/engine.test.ts               # new tests for players:* emits and snapshot transitions
  src/socket/server.ts                    # round:state snapshot uses players, drop playerCount
  src/socket/broadcast.ts                 # forward 3 new public events without apiKey stripping
  src/app.ts                              # drop historyRouter wiring
  openapi.yaml                            # drop history paths/schemas, add tier/players/PublicPlayer/RoundTier, document new WS events
  README.md                               # drop /api/history row
  docs/api-reference.html                 # drop history section, add tier, swap playerCount→players, add 3 new events
  scripts/smoke.ts                        # add spectator client verifying live players events

DELETED:
  src/routes/history.ts
```

**Boundary rule reminder:** `engine/` imports only from `repos/`, `domain/`, `types.ts`. The new `tier.ts` lives in `domain/` and is consumed by both engine and repos. `broadcast.ts` is still the only file bridging engine events to `io.emit`.

---

## Task 1: Tier domain module (TDD)

**Files:**
- Create: `src/domain/tier.ts`, `src/domain/tier.test.ts`

- [ ] **Step 1: Write `src/domain/tier.test.ts` first (failing)**

```ts
import { describe, it, expect } from 'vitest';
import { computeTier } from './tier.js';

describe('computeTier', () => {
  it('classifies crashPoint < 1.5 as low', () => {
    expect(computeTier(1.0)).toBe('low');
    expect(computeTier(1.49)).toBe('low');
  });

  it('classifies 1.5 <= crashPoint < 3.0 as mid', () => {
    expect(computeTier(1.5)).toBe('mid');
    expect(computeTier(2.0)).toBe('mid');
    expect(computeTier(2.99)).toBe('mid');
  });

  it('classifies crashPoint >= 3.0 as high', () => {
    expect(computeTier(3.0)).toBe('high');
    expect(computeTier(10.24)).toBe('high');
    expect(computeTier(100.0)).toBe('high');
  });

  it('handles edge of house-edge (instant crash)', () => {
    expect(computeTier(1.0)).toBe('low');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /Users/stas/Desktop/crash-backend
npm test -- src/domain/tier.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/tier.ts`**

```ts
import type { RoundTier } from '../types.js';

export function computeTier(crashPoint: number): RoundTier {
  if (crashPoint < 1.5) return 'low';
  if (crashPoint < 3.0) return 'mid';
  return 'high';
}
```

> Note: `RoundTier` is added to `src/types.ts` in Task 3. For now this import will fail typecheck — that's expected. The next step compensates by relying on type inference temporarily.

Actually, to keep typecheck clean during this task, define `RoundTier` inline in this file for now AND export it. Task 3 will move it to `types.ts` and re-import.

Replace the import with a local export:

```ts
export type RoundTier = 'low' | 'mid' | 'high';

export function computeTier(crashPoint: number): RoundTier {
  if (crashPoint < 1.5) return 'low';
  if (crashPoint < 3.0) return 'mid';
  return 'high';
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
npm test -- src/domain/tier.test.ts
```
Expected: PASS, 4 tests (or however many your test runner counts — there are 4 `it()` blocks).

- [ ] **Step 5: Run full typecheck**

```bash
npm run typecheck
```
Expected: PASS (no other files import from tier yet).

- [ ] **Step 6: Commit**

```bash
git add src/domain/tier.ts src/domain/tier.test.ts
git commit -m "feat(domain): add computeTier classifying crashPoint into low/mid/high"
```

---

## Task 2: Remove `/api/history` endpoint and supporting code

**Files:**
- Delete: `src/routes/history.ts`
- Modify: `src/app.ts`, `src/repos/betRepo.ts`, `src/repos/repos.test.ts`, `src/types.ts`

- [ ] **Step 1: Delete `src/routes/history.ts`**

```bash
rm /Users/stas/Desktop/crash-backend/src/routes/history.ts
```

- [ ] **Step 2: Update `src/app.ts` — remove history router wiring**

Remove the import line and the `app.use('/api', historyRouter)` line. The final file should look like:

```ts
import express from 'express';
import cors from 'cors';
import { errorHandler } from './middleware/errors.js';
import { apiKeyMiddleware } from './middleware/apiKey.js';
import { balanceRouter } from './routes/balance.js';
import { recentRouter } from './routes/recent.js';
import { docsRouter } from './routes/docs.js';

export function createApp() {
  const app = express();
  app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? '*' }));
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Public docs (must be before apiKeyMiddleware)
  app.use('/api', docsRouter);

  // Auth-required routes
  app.use('/api', apiKeyMiddleware);
  app.use('/api', balanceRouter);
  app.use('/api', recentRouter);

  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 3: Update `src/repos/betRepo.ts` — remove `listForPlayer` and `BetRow`**

Open the file. Delete:
- The `interface BetRow { ... }` declaration
- The `export async function listForPlayer(...)` function
- The `import type { HistoryBet } from '../types.js';` line (no longer needed)
- The `import { publicRoundId } from '../types.js';` line (no longer needed if only listForPlayer used it — verify by searching the file for `publicRoundId`)

After cleanup, only these exports should remain in `betRepo.ts`: `insertPlaced`, `markCashedOut`, `settleAllLost`, `settleAllOrphaned`, `deleteById`. The remaining imports should be `import { pool } from '../db.js';` and `import type { PoolClient } from 'pg';`.

- [ ] **Step 4: Update `src/repos/repos.test.ts` — drop the `listForPlayer` test block**

Find and delete the entire test case `it('listForPlayer returns most recent bets first', ...)` inside the `describe('betRepo', ...)` block. Leave all other betRepo tests intact.

- [ ] **Step 5: Update `src/types.ts` — remove `HistoryBet` and `HistoryResponse`**

Delete these two interfaces from `src/types.ts`:

```ts
// DELETE these two interfaces:
export interface HistoryBet { ... }
export interface HistoryResponse { ... }
```

The rest of types.ts is unchanged for this task.

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```
Expected: PASS. If anything still imports `HistoryBet`/`HistoryResponse`, fix that import (should be none if you cleaned up Step 3/4 correctly).

- [ ] **Step 7: Run full test suite**

```bash
npm test
```
Expected: 1 test removed (listForPlayer), all others still pass. So 31 tests instead of 32. Plus 4 new tier tests from Task 1 = 35 total. (Adjust based on actual count.)

If repos integration tests can't connect to DB, ensure Docker Postgres is running:
```bash
docker run -d --name crash-pg -p 5440:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=crash postgres:16-alpine
sleep 3
npm run migrate
```

- [ ] **Step 8: Commit**

```bash
git add -A src/routes/history.ts src/app.ts src/repos/betRepo.ts src/repos/repos.test.ts src/types.ts
git commit -m "feat(rest): remove /api/history endpoint and dead code

- Delete src/routes/history.ts
- Remove historyRouter from app.ts
- Drop betRepo.listForPlayer + BetRow interface
- Drop HistoryBet + HistoryResponse types
- Drop the corresponding repos test"
```

---

## Task 3: Add new shared types (`RoundTier`, `PublicPlayer`)

**Files:**
- Modify: `src/types.ts`, `src/domain/tier.ts`

- [ ] **Step 1: Add new types to `src/types.ts`**

After the `Phase` type and `ActiveBet` interface (in the "Engine domain" section), add:

```ts
// Recent round color/tier classification.
//   low:  crashPoint < 1.5    (red)
//   mid:  1.5 <= crashPoint < 3   (orange)
//   high: crashPoint >= 3   (green)
export type RoundTier = 'low' | 'mid' | 'high';

// Public per-player info safe to broadcast (no balance, betId, or profit).
export interface PublicPlayer {
  username: string;       // === apiKey
  amount: number;
  status: 'placed' | 'cashed_out' | 'lost';
  multiplier: number | null;  // only set when status === 'cashed_out'
}
```

(Place these immediately after the `ActiveBet` interface so the engine domain section stays grouped.)

- [ ] **Step 2: Update `src/domain/tier.ts` to import `RoundTier` from types**

Replace the local definition with the import:

```ts
import type { RoundTier } from '../types.js';

export function computeTier(crashPoint: number): RoundTier {
  if (crashPoint < 1.5) return 'low';
  if (crashPoint < 3.0) return 'mid';
  return 'high';
}
```

- [ ] **Step 3: Run typecheck and tests**

```bash
cd /Users/stas/Desktop/crash-backend
npm run typecheck
npm test -- src/domain/tier.test.ts
```
Expected: typecheck clean, all 4 tier tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/domain/tier.ts
git commit -m "feat(types): add RoundTier and PublicPlayer; consolidate tier import"
```

---

## Task 4: `roundRepo.listRecent` populates `tier`

**Files:**
- Modify: `src/repos/roundRepo.ts`, `src/types.ts`, `src/repos/repos.test.ts`

- [ ] **Step 1: Update `RecentRound` interface in `src/types.ts`**

Find the existing `RecentRound` interface and add a `tier` field:

```ts
export interface RecentRound {
  roundId: string;
  crashPoint: number;
  crashedAt: string;
  tier: RoundTier;        // NEW
}
```

- [ ] **Step 2: Update `src/repos/roundRepo.ts` to populate `tier`**

Add `import { computeTier } from '../domain/tier.js';` at the top. In `listRecent`'s `.map()`, populate the tier:

```ts
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
      tier: computeTier(cp),       // NEW
    };
  });
}
```

- [ ] **Step 3: Update `src/repos/repos.test.ts` `listRecent` test**

Find the existing test `it('listRecent returns crashed rounds in reverse chronological order', ...)`. Add tier assertions:

```ts
it('listRecent returns crashed rounds in reverse chronological order with tier', async () => {
  const r1 = await roundRepo.insertRunning(new Date(Date.now() - 2000), 'a');
  const r2 = await roundRepo.insertRunning(new Date(Date.now() - 1000), 'b');
  await roundRepo.markCrashed(r1.id, 1.5);   // mid
  await roundRepo.markCrashed(r2.id, 3.0);   // high
  const list = await roundRepo.listRecent(10);
  expect(list).toHaveLength(2);
  expect(list[0].crashPoint).toBe(3.0);
  expect(list[0].tier).toBe('high');
  expect(list[1].crashPoint).toBe(1.5);
  expect(list[1].tier).toBe('mid');
});
```

(Replace the existing test body with this — same name structure but with tier.)

Add ONE additional test right after to lock in the low boundary:

```ts
it('listRecent classifies crashPoint < 1.5 as low tier', async () => {
  const r = await roundRepo.insertRunning(new Date(), 'seed');
  await roundRepo.markCrashed(r.id, 1.18);
  const list = await roundRepo.listRecent(10);
  expect(list[0].tier).toBe('low');
});
```

- [ ] **Step 4: Run repos tests + typecheck**

```bash
npm test -- src/repos/repos.test.ts
npm run typecheck
```
Expected: tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/repos/roundRepo.ts src/repos/repos.test.ts
git commit -m "feat(rest): add tier field to RecentRound, populated by computeTier"
```

---

## Task 5: Engine — `publicPlayers` state, emit `players:*`, modified phase events

**Files:**
- Modify: `src/types.ts`, `src/engine/engine.ts`, `src/engine/engine.test.ts`, `src/socket/server.ts`, `src/socket/broadcast.ts`

This is the largest task — it touches the engine state machine, socket layer, and event types together. Doing them as one task keeps typecheck green throughout.

- [ ] **Step 1: Modify event types in `src/types.ts`**

Find each of these interfaces and update them as shown.

`RoundStateEvent` — replace `playerCount` with `players`:

```ts
export interface RoundStateEvent {
  phase: Phase;
  roundId: string;
  startedAt: string | null;
  endsAt: string | null;
  currentMultiplier: number;
  crashPoint: number | null;
  yourBet: {
    amount: number;
    autoCashOutAt: number | null;
    status: 'placed' | 'cashedOut' | 'lost';
  } | null;
  players: PublicPlayer[];   // CHANGED: was playerCount: number
}
```

`RoundWaitingEvent`:

```ts
export interface RoundWaitingEvent {
  roundId: string;
  endsAt: string;
  players: PublicPlayer[];   // CHANGED: was playerCount: 0
}
```

`RoundStartEvent`:

```ts
export interface RoundStartEvent {
  roundId: string;
  startedAt: string;
  players: PublicPlayer[];   // CHANGED
}
```

`RoundCrashEvent`:

```ts
export interface RoundCrashEvent {
  roundId: string;
  crashPoint: number;
  tier: RoundTier;           // NEW
  players: PublicPlayer[];   // CHANGED
}
```

Also add 3 new public event interfaces at the end of the public WebSocket section (before the REST response shapes):

```ts
// Public per-player diff events (broadcast to all sockets)
export interface PlayersBetEvent {
  username: string;
  amount: number;
}

export interface PlayersCashoutEvent {
  username: string;
  multiplier: number;
  winAmount: number;
}

export interface PlayersLostEvent {
  username: string;
  amount: number;
}
```

- [ ] **Step 2: Update `src/engine/engine.ts` — add `publicPlayers` state and import `computeTier`**

At the top of the file, add the imports:

```ts
import { computeTier } from '../domain/tier.js';
import type { PublicPlayer } from '../types.js';
```

Find the `EngineState` interface and add the new field:

```ts
interface EngineState {
  phase: Phase;
  roundId: number;
  startedAt: Date | null;
  endsAt: Date | null;
  multiplier: number;
  crashPoint: number | null;
  seed: string;
  bets: Map<string, ActiveBet>;
  publicPlayers: Map<string, PublicPlayer>;   // NEW
}
```

In the constructor's `this.state = { ... }` initialization, add:

```ts
this.state = {
  phase: 'waiting',
  roundId: 0,
  startedAt: null,
  endsAt: null,
  multiplier: 1.0,
  crashPoint: null,
  seed: '',
  bets: new Map(),
  publicPlayers: new Map(),    // NEW
};
```

- [ ] **Step 3: Update `advanceToWaiting` in engine.ts — clear publicPlayers and emit players: []**

Find `advanceToWaiting()`. Replace the body with:

```ts
advanceToWaiting(): void {
  this.state.phase = 'waiting';
  this.state.bets.clear();
  this.state.publicPlayers.clear();          // NEW
  this.state.startedAt = null;
  this.state.crashPoint = null;
  this.state.multiplier = 1.0;
  const endsAt = new Date(this.clock() + WAITING_MS);
  this.state.endsAt = endsAt;
  const nextRoundIdLabel = publicRoundId(this.state.roundId + 1);
  this.emit('phase:waiting', {
    roundId: nextRoundIdLabel,
    endsAt: endsAt.toISOString(),
    players: [],                              // CHANGED: was playerCount: 0
  });
  if (this.autoTimers) {
    this.phaseTimer = setTimeout(() => { void this.advanceToRunning(); }, WAITING_MS);
  }
}
```

- [ ] **Step 4: Update `advanceToRunning` in engine.ts — emit players snapshot**

Find the `this.emit('phase:running', ...)` call. Replace its payload:

```ts
this.emit('phase:running', {
  roundId: publicRoundId(round.id),
  startedAt: this.state.startedAt.toISOString(),
  players: [...this.state.publicPlayers.values()],   // CHANGED: was playerCount: this.state.bets.size
});
```

- [ ] **Step 5: Update `placeBet` in engine.ts — populate `publicPlayers` and emit `players:bet`**

In `placeBet`, after the line `this.state.bets.set(apiKey, { ... });`, add the publicPlayers update and the new emit:

```ts
this.state.bets.set(apiKey, {
  betId: result.betId, apiKey, amount, autoCashOutAt, placedAt: new Date(this.clock()),
  balanceAtPlacement: result.balance,
});
this.state.publicPlayers.set(apiKey, {              // NEW
  username: apiKey,
  amount,
  status: 'placed',
  multiplier: null,
});
this.emit('bet:placed', {
  apiKey, betId: result.betId, roundId: publicRoundId(this.state.roundId),
  amount, autoCashOutAt, balance: result.balance,
});
this.emit('players:bet', { username: apiKey, amount });   // NEW
```

- [ ] **Step 6: Update `settleCashout` (manual path) in engine.ts**

Find the `settleCashout` private method. After the line `this.emit('bet:cashedOut', { ... })`, add the publicPlayers update and the new emit. The full updated method:

```ts
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
```

- [ ] **Step 7: Update `beginCashout` (sync auto-cashout path) in engine.ts**

Find `beginCashout` (the sync path used by `tick()`). After it emits `bet:cashedOut`, add the publicPlayers update and `players:cashout` emit. The full updated method:

```ts
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
  // Background DB persistence (fire-and-forget)
  void this.persistCashout(bet, atMultiplier, winAmount);
}
```

> The actual `persistCashout` signature in the existing engine is `persistCashout(bet: ActiveBet, atMultiplier: number, winAmount: number): Promise<void>`. Don't change it — just keep the existing call as-is.

- [ ] **Step 8: Update `beginCrash` in engine.ts**

Find `beginCrash` (called from `tick()` when `m >= crashPoint`). It currently emits `phase:crashed` and `bet:lost` for each bet. Add tier to phase:crashed, players snapshot, mark each lost bet in publicPlayers, and emit players:lost. Full updated method:

```ts
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
    tier: computeTier(cp),                               // NEW
    players: [...this.state.publicPlayers.values()],     // CHANGED
  });
  for (const bet of remainingBets) {
    this.emit('bet:lost', {
      apiKey: bet.apiKey,
      betId: bet.betId,
      crashPoint: cp,
      balance: bet.balanceAtPlacement,
    });
    this.emit('players:lost', {                          // NEW
      username: bet.apiKey,
      amount: bet.amount,
    });
  }
  // Background DB persistence
  void this.persistCrash(this.state.roundId, cp, remainingBets);
  if (this.autoTimers) {
    this.phaseTimer = setTimeout(() => this.advanceToWaiting(), CRASHED_PAUSE_MS);
  }
}
```

> The actual `persistCrash` signature is `persistCrash(roundId: number, cp: number, bets: ActiveBet[]): Promise<void>`. Keep that signature unchanged. The key changes in this step are: (1) add `tier` and `players` to `phase:crashed` payload, (2) update `publicPlayers` for each lost bet, (3) emit `players:lost` after each `bet:lost`. Don't restructure anything else.

- [ ] **Step 9: Update `src/socket/server.ts` — round:state snapshot uses `players`**

Find the snapshot construction in the `connection` handler. Replace `playerCount: state.bets.size` with `players: [...state.publicPlayers.values()]`:

```ts
const snapshot: RoundStateEvent = {
  phase: state.phase,
  roundId: publicRoundId(state.roundId),
  startedAt: state.startedAt?.toISOString() ?? null,
  endsAt: state.endsAt?.toISOString() ?? null,
  currentMultiplier: state.multiplier,
  crashPoint: state.phase === 'crashed' ? state.crashPoint : null,
  yourBet: yourBet
    ? { amount: yourBet.amount, autoCashOutAt: yourBet.autoCashOutAt, status: yourBetStatus }
    : null,
  players: [...state.publicPlayers.values()],   // CHANGED
};
```

- [ ] **Step 10: Update `src/socket/broadcast.ts` — handle 3 new public events**

Find the `playerEvents` array. Add a separate constant for the new public-only events that don't carry `apiKey`:

```ts
const broadcastEvents = ['round:waiting', 'round:start', 'round:tick', 'round:crash'] as const;
const playerEvents = ['bet:placed', 'bet:cashedOut', 'bet:lost', 'bet:rejected'] as const;
const publicEvents = ['players:bet', 'players:cashout', 'players:lost'] as const;   // NEW

const engineEventMap: Record<string, string> = {
  'phase:waiting': 'round:waiting',
  'phase:running': 'round:start',
  'phase:crashed': 'round:crash',
  'tick': 'round:tick',
};

export function wireBroadcast(engine: Engine, io: Server): void {
  // Phase / tick events → broadcast (existing)
  for (const engineName of Object.keys(engineEventMap)) {
    engine.on(engineName, (payload) => {
      io.emit(engineEventMap[engineName], payload);
    });
  }

  // Player-targeted events: payload has `apiKey` → strip and emit only to those sockets (existing)
  for (const name of playerEvents) {
    engine.on(name, (payload: { apiKey: string } & Record<string, unknown>) => {
      const { apiKey, ...publicPayload } = payload;
      const sids = sockets.get(apiKey);
      if (!sids) return;
      for (const sid of sids) {
        io.to(sid).emit(name, publicPayload);
      }
    });
  }

  // Public events: broadcast to ALL sockets, payload already public (no apiKey to strip) (NEW)
  for (const name of publicEvents) {
    engine.on(name, (payload) => {
      io.emit(name, payload);
    });
  }
}

export { broadcastEvents, playerEvents, publicEvents };
```

- [ ] **Step 11: Update `src/engine/engine.test.ts` — fix existing tests + add new ones**

The existing fakes in engine.test.ts don't reference `playerCount` directly in payloads, but the test loop registers events. Add the new event names to the registration:

Find the `for (const name of [...])` block and add 3 new event names:

```ts
for (const name of [
  'phase:waiting', 'phase:running', 'phase:crashed', 'tick',
  'bet:placed', 'bet:cashedOut', 'bet:lost', 'bet:rejected',
  'players:bet', 'players:cashout', 'players:lost',           // NEW
]) {
  engine.on(name, payload => events.push({ name, payload }));
}
```

The existing test `'placeBet during waiting succeeds and debits balance'` already asserts shape on `bet:placed`. Add an assertion that `players:bet` was also emitted, after the existing `expect(placed!.payload).toMatchObject(...)`:

```ts
const playersBet = events.find(e => e.name === 'players:bet');
expect(playersBet).toBeDefined();
expect(playersBet!.payload).toEqual({ username: 'alice', amount: 100 });
```

The existing test `'manual cashout returns winAmount = bet × current multiplier'` should also assert `players:cashout` was emitted. After the existing `expect(p.winAmount).toBeCloseTo(...)` line:

```ts
const playersCash = events.find(e => e.name === 'players:cashout');
expect(playersCash).toBeDefined();
expect((playersCash!.payload as { username: string }).username).toBe('alice');
```

The existing test `'auto cashout settles on TARGET, not on current tick value'` should add:

```ts
const playersCash = events.find(e => e.name === 'players:cashout');
expect(playersCash).toBeDefined();
expect(playersCash!.payload).toEqual({ username: 'alice', multiplier: 1.5, winAmount: 150 });
```

The existing test `'crash transitions phase, marks bets lost, broadcasts crashPoint'` should also assert `tier`, `players` snapshot, and `players:lost` emit:

```ts
// After the existing expect(crash...) lines:
const crashPayload = crash!.payload as { tier: string; players: Array<{ status: string }> };
expect(crashPayload.tier).toBe('low');                  // 1.5 → mid? recompute. 1.5 falls in mid, NOT low.
// Actually: crashPoint=1.5 → mid per computeTier. Adjust expectation:
expect(crashPayload.tier).toBe('mid');
expect(crashPayload.players).toHaveLength(1);
expect(crashPayload.players[0].status).toBe('lost');

const playersLost = events.find(e => e.name === 'players:lost');
expect(playersLost).toBeDefined();
expect(playersLost!.payload).toEqual({ username: 'alice', amount: 100 });
```

> If the existing test uses crashPoint=1.5, the tier is 'mid' (1.5 boundary). Verify against the test's actual `__setCrashPointForTest` value and adjust the tier expectation accordingly.

Add ONE entirely new test at the bottom of the `describe('Engine', ...)` block:

```ts
it('publicPlayers is cleared on advanceToWaiting', async () => {
  await engine.placeBet('alice', 100, null);
  // alice is in publicPlayers
  const stateBefore = engine.getState();
  expect(stateBefore.publicPlayers.size).toBe(1);
  // Trigger transition through running → crashed → waiting
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
```

- [ ] **Step 12: Run typecheck + tests**

```bash
cd /Users/stas/Desktop/crash-backend
npm run typecheck
npm test
```
Expected: typecheck clean. Tests: 11+ engine tests pass (was 11, now 12 with the new publicPlayers test); 13+ repos tests pass; 4 tier tests pass; total ~36+ tests.

If a test fails because the existing `'crash transitions phase'` test expected `playerCount` somewhere, update that assertion to use `players.length` instead.

- [ ] **Step 13: Run end-to-end smoke locally**

```bash
node --env-file=.env.local --import tsx scripts/smoke.ts
```
Expected: existing smoke still completes (it doesn't subscribe to the new events yet — we add that in Task 8). No errors during run.

- [ ] **Step 14: Commit**

```bash
git add src/types.ts src/engine/engine.ts src/engine/engine.test.ts src/socket/server.ts src/socket/broadcast.ts
git commit -m "feat(engine,socket): add publicPlayers feed and players:* public events

- Engine maintains publicPlayers Map mirroring bets + cashed_out + lost
- placeBet/settleCashout/beginCashout/beginCrash emit players:bet/cashout/lost
- Phase events (round:state/waiting/start/crash) embed players snapshot, drop playerCount
- round:crash adds tier field via computeTier
- broadcast.ts handles 3 new public events without apiKey stripping"
```

---

## Task 6: Documentation update

**Files:**
- Modify: `openapi.yaml`, `README.md`, `docs/api-reference.html`

- [ ] **Step 1: Update `openapi.yaml`**

Open `openapi.yaml`. Make these changes:

(a) Delete the entire `/api/history` path block.

(b) Delete the `History` and `HistoryBet` schemas from `components.schemas`.

(c) Add new schemas in `components.schemas`:

```yaml
RoundTier:
  type: string
  enum: [low, mid, high]
  description: |
    Color/severity classification of crashPoint:
    low (red, < 1.5×), mid (orange, 1.5–3×), high (green, ≥ 3×)

PublicPlayer:
  type: object
  properties:
    username: { type: string, description: 'Same as the player apiKey' }
    amount: { type: number }
    status: { type: string, enum: [placed, cashed_out, lost] }
    multiplier: { type: number, nullable: true, description: 'Set only when status=cashed_out' }
```

(d) Update the `RecentRound` schema — add `tier`:

```yaml
RecentRound:
  type: object
  properties:
    roundId: { type: string }
    crashPoint: { type: number }
    crashedAt: { type: string, format: date-time }
    tier: { $ref: '#/components/schemas/RoundTier' }
```

(e) Update the WebSocket section in `info.description`:

Find the `## WebSocket events` block. Replace the Server → Client table with:

```markdown
### Server → Client

| Event | Payload |
|---|---|
| `round:state` | `{ phase, roundId, startedAt, endsAt, currentMultiplier, crashPoint, yourBet, players }` |
| `round:waiting` | `{ roundId, endsAt, players: [] }` |
| `round:start` | `{ roundId, startedAt, players }` |
| `round:tick` | `{ roundId, multiplier, elapsedMs }` |
| `round:crash` | `{ roundId, crashPoint, tier, players }` |
| `bet:placed` | `{ betId, roundId, amount, autoCashOutAt, balance }` (player-targeted) |
| `bet:cashedOut` | `{ betId, multiplier, winAmount, profit, balance }` (player-targeted) |
| `bet:lost` | `{ betId, crashPoint, balance }` (player-targeted) |
| `bet:rejected` | `{ reason, message }` (player-targeted) |
| `players:bet` | `{ username, amount }` (broadcast) |
| `players:cashout` | `{ username, multiplier, winAmount }` (broadcast) |
| `players:lost` | `{ username, amount }` (broadcast) |
```

`players` arrays use the `PublicPlayer` schema. Add a one-liner after the table: `players arrays contain PublicPlayer objects (see schemas).`

- [ ] **Step 2: Update `README.md`**

Find the endpoints table. Delete the `/api/history` row. The remaining table:

```markdown
| | Path | Notes |
|---|---|---|
| GET | `/api/health` | Liveness (no auth) |
| GET | `/api/docs` | Swagger UI (no auth) |
| GET | `/api/balance` | Current balance |
| GET | `/api/rounds/recent?limit=20` | Last N crash points (with `tier`) |
```

- [ ] **Step 3: Update `docs/api-reference.html`**

This is a substantial edit. Open the file:

(a) **Remove section 1.3** — the entire `<div class="endpoint">` block for `GET /api/history`. Also remove its TOC reference if any.

(b) **Update section 1.4** (`/api/rounds/recent`) — show the `tier` field in the response example. Replace the response `<pre>` content with:

```html
<pre>{
  <span class="k">"rounds"</span>: [
    { <span class="k">"roundId"</span>: <span class="s">"round_24"</span>, <span class="k">"crashPoint"</span>: <span class="n">1.20</span>, <span class="k">"crashedAt"</span>: <span class="s">"2026-05-04T07:35:22Z"</span>, <span class="k">"tier"</span>: <span class="s">"low"</span> },
    { <span class="k">"roundId"</span>: <span class="s">"round_23"</span>, <span class="k">"crashPoint"</span>: <span class="n">10.24</span>, <span class="k">"crashedAt"</span>: <span class="s">"2026-05-04T07:35:04Z"</span>, <span class="k">"tier"</span>: <span class="s">"high"</span> }
  ]
}</pre>
```

Add a sentence right after that explains tier: `<p><code>tier</code>: <code>'low'</code> (red, &lt; 1.5×) | <code>'mid'</code> (orange, 1.5–3×) | <code>'high'</code> (green, ≥ 3×). Класифікація на сервері — фронт не реіменує.</p>`

(c) **In the Server→Client section**, replace `playerCount` with `players` in 4 events. For each of `round:state`, `round:waiting`, `round:start`, `round:crash` event blocks, change the payload type definition. Examples:

For `round:state`:
```html
<pre><span class="kw">interface</span> <span class="t">RoundStateEvent</span> {
  <span class="k">phase</span>: <span class="str">'waiting'</span> | <span class="str">'running'</span> | <span class="str">'crashed'</span>;
  <span class="k">roundId</span>: <span class="t">string</span>;
  <span class="k">startedAt</span>: <span class="t">string</span> | <span class="kw">null</span>;
  <span class="k">endsAt</span>: <span class="t">string</span> | <span class="kw">null</span>;
  <span class="k">currentMultiplier</span>: <span class="t">number</span>;
  <span class="k">crashPoint</span>: <span class="t">number</span> | <span class="kw">null</span>;
  <span class="k">yourBet</span>: { ... } | <span class="kw">null</span>;
  <span class="k">players</span>: <span class="t">PublicPlayer</span>[];      <span class="c">// CHANGED: replaces playerCount</span>
}</pre>
```

For `round:waiting`:
```html
<pre><span class="kw">interface</span> <span class="t">RoundWaitingEvent</span> {
  <span class="k">roundId</span>: <span class="t">string</span>;
  <span class="k">endsAt</span>: <span class="t">string</span>;
  <span class="k">players</span>: [];                         <span class="c">// always empty (новий раунд, лист скинуто)</span>
}</pre>
```

For `round:start`:
```html
<pre><span class="kw">interface</span> <span class="t">RoundStartEvent</span> {
  <span class="k">roundId</span>: <span class="t">string</span>;
  <span class="k">startedAt</span>: <span class="t">string</span>;
  <span class="k">players</span>: <span class="t">PublicPlayer</span>[];
}</pre>
```

For `round:crash`:
```html
<pre><span class="kw">interface</span> <span class="t">RoundCrashEvent</span> {
  <span class="k">roundId</span>: <span class="t">string</span>;
  <span class="k">crashPoint</span>: <span class="t">number</span>;
  <span class="k">tier</span>: <span class="str">'low'</span> | <span class="str">'mid'</span> | <span class="str">'high'</span>;     <span class="c">// NEW</span>
  <span class="k">players</span>: <span class="t">PublicPlayer</span>[];
}</pre>
```

(d) **Add a new section right before the cheat sheet** — `PublicPlayer` type reference and 3 new event blocks:

Insert after the `bet:rejected` event block:

```html
  <h3>📡 Live Players (3 нові public events)</h3>
  <p>Ці events broadcast'яться УСІМ підключеним клієнтам (на відміну від <code>bet:*</code> які приходять тільки гравцю). Нічого приватного — тільки <code>username</code> (=apiKey), сума, multiplier коли cashed_out.</p>

  <h4>PublicPlayer тип</h4>
  <pre><span class="kw">interface</span> <span class="t">PublicPlayer</span> {
  <span class="k">username</span>: <span class="t">string</span>;            <span class="c">// === apiKey</span>
  <span class="k">amount</span>: <span class="t">number</span>;
  <span class="k">status</span>: <span class="str">'placed'</span> | <span class="str">'cashed_out'</span> | <span class="str">'lost'</span>;
  <span class="k">multiplier</span>: <span class="t">number</span> | <span class="kw">null</span>;   <span class="c">// тільки при cashed_out</span>
}</pre>

  <!-- players:bet -->
  <div class="endpoint">
    <div class="endpoint-head">
      <span class="ep-method ws-s2c">SERVER → CLIENT</span>
      <span class="ep-url">players:bet</span>
    </div>
    <p class="ep-when">⏰ Коли: будь-який гравець ставить ставку (під час waiting). Broadcast усім.</p>
    <h4>Payload:</h4>
    <pre>{ <span class="k">username</span>: <span class="t">string</span>, <span class="k">amount</span>: <span class="t">number</span> }</pre>
    <h4>Приклад:</h4>
    <pre>s.on(<span class="str">'players:bet'</span>, (e) =&gt; {
  useLivePlayersStore.getState().addPlayer({
    <span class="k">username</span>: e.username,
    <span class="k">amount</span>: e.amount,
    <span class="k">status</span>: <span class="str">'placed'</span>,
    <span class="k">multiplier</span>: <span class="kw">null</span>,
  });
});</pre>
  </div>

  <!-- players:cashout -->
  <div class="endpoint">
    <div class="endpoint-head">
      <span class="ep-method ws-s2c">SERVER → CLIENT</span>
      <span class="ep-url">players:cashout</span>
    </div>
    <p class="ep-when">⏰ Коли: будь-який гравець кешає (manual або auto). Broadcast усім.</p>
    <h4>Payload:</h4>
    <pre>{ <span class="k">username</span>: <span class="t">string</span>, <span class="k">multiplier</span>: <span class="t">number</span>, <span class="k">winAmount</span>: <span class="t">number</span> }</pre>
    <h4>Приклад:</h4>
    <pre>s.on(<span class="str">'players:cashout'</span>, (e) =&gt; {
  useLivePlayersStore.getState().updatePlayer(e.username, {
    <span class="k">status</span>: <span class="str">'cashed_out'</span>,
    <span class="k">multiplier</span>: e.multiplier,
  });
});</pre>
  </div>

  <!-- players:lost -->
  <div class="endpoint">
    <div class="endpoint-head">
      <span class="ep-method ws-s2c">SERVER → CLIENT</span>
      <span class="ep-url">players:lost</span>
    </div>
    <p class="ep-when">⏰ Коли: будь-який гравець не встиг кешаут до crash. Broadcast усім, по одному event на кожного програвшого.</p>
    <h4>Payload:</h4>
    <pre>{ <span class="k">username</span>: <span class="t">string</span>, <span class="k">amount</span>: <span class="t">number</span> }</pre>
    <h4>Приклад:</h4>
    <pre>s.on(<span class="str">'players:lost'</span>, (e) =&gt; {
  useLivePlayersStore.getState().updatePlayer(e.username, { <span class="k">status</span>: <span class="str">'lost'</span> });
});</pre>
  </div>
```

(e) **Update the cheat sheet** at the bottom — replace the Server→Client lines with the new contract. Remove the `/api/history` line from the REST section.

- [ ] **Step 4: Verify HTML is valid (open it in a browser to spot-check)**

```bash
open /Users/stas/Desktop/crash-backend/docs/api-reference.html
```

Eyeball check that:
- TOC is correct
- History section is gone
- Recent rounds shows tier
- 4 phase events show players
- 3 new player events appear
- Cheat sheet matches

- [ ] **Step 5: Commit**

```bash
git add openapi.yaml README.md docs/api-reference.html
git commit -m "docs: update OpenAPI, README, and api-reference for live players + tier

- Drop /api/history from openapi.yaml + README + api-reference
- Add tier to RecentRound schema
- Add PublicPlayer + RoundTier schemas
- Document 3 new WS events (players:bet/cashout/lost)
- Replace playerCount with players in 4 phase events
- Add tier to round:crash payload"
```

---

## Task 7: Smoke test extension — spectator client

**Files:**
- Modify: `scripts/smoke.ts`

- [ ] **Step 1: Update `scripts/smoke.ts` — add a third client that watches public events**

Find the existing `connect()` helper. After the `const bob = await connect('smoke-bob');` line, add a spectator and verify it receives broadcast events. Insert this block AFTER both bets are placed and BEFORE the cashout race section:

```ts
// Spectator: connects but doesn't bet — should still see public players:* events
const spectator = await connect('smoke-spectator-' + Date.now());
console.log('spectator connected');

const spectatorEvents: Array<{ name: string; payload: unknown }> = [];
for (const evt of ['players:bet', 'players:cashout', 'players:lost', 'round:crash']) {
  spectator.on(evt, (p) => spectatorEvents.push({ name: evt, payload: p }));
}
```

After the existing `console.log('bob result:', bobResult);` line, add a verification:

```ts
// Wait briefly for the spectator to capture events
await new Promise(r => setTimeout(r, 500));
console.log('spectator captured events:');
for (const e of spectatorEvents) {
  console.log(`  ${e.name}:`, e.payload);
}
const sawCashoutOrLost = spectatorEvents.some(e => e.name === 'players:cashout' || e.name === 'players:lost');
if (!sawCashoutOrLost) {
  console.error('SMOKE FAIL: spectator did not see any players:cashout or players:lost event');
  process.exit(1);
}
console.log('spectator saw public events ✓');
spectator.close();
```

(The existing close/exit logic at the end is left unchanged.)

- [ ] **Step 2: Ensure DB is fresh (optional but recommended)**

```bash
PGPASSWORD=test psql -h localhost -p 5440 -U postgres -d crash -c 'TRUNCATE bets, rounds, players CASCADE'
```

- [ ] **Step 3: Run the smoke**

```bash
cd /Users/stas/Desktop/crash-backend
node --env-file=.env.local --import tsx scripts/smoke.ts
```

Expected output: existing connect/bet/cashout flow PLUS:
- `spectator connected`
- `spectator captured events:` followed by at least one `players:cashout` or `players:lost`
- `spectator saw public events ✓`
- `smoke complete`

If it hangs or fails at the spectator check, that means broadcast.ts isn't forwarding `players:*` correctly — investigate before proceeding.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke.ts
git commit -m "test: extend smoke with spectator client verifying public players:* events"
```

---

## Verification checklist (after all tasks)

Run from `/Users/stas/Desktop/crash-backend`:

- `npm run typecheck` → clean
- `npm test` → all tests pass (~36+ counting tier + new engine assertions)
- `node --env-file=.env.local --import tsx scripts/smoke.ts` → completes with spectator verification
- `curl -H 'X-API-Key: t' http://localhost:3000/api/rounds/recent?limit=5 | jq` → each round has `tier`
- `curl http://localhost:3000/api/history` should return 404 (route gone)
- WS connection should receive `players:bet/cashout/lost` events when ANY client bets
- WS connection should NOT receive `playerCount` field anywhere — replaced by `players: PublicPlayer[]`

## Production deploy (after merge)

```bash
fly deploy
```
The release_command runs `npm run migrate:prod` (no schema changes here, but harmless to re-run).
