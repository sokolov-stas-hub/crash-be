# Crash Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the long-running Node.js backend for the Week 4 Crash homework — REST + Socket.IO server with an authoritative in-memory game engine, Postgres persistence, and Swagger docs.

**Architecture:** Single Node process. Express + Socket.IO share one HTTP listener. An `Engine` (extending `EventEmitter`) holds in-memory phase/multiplier/bets state and drives the game loop via `setTimeout`/`setInterval`. A `broadcast` adapter forwards engine events to `io.emit`. Repos own all SQL. The engine knows nothing about Socket.IO. See spec at `docs/superpowers/specs/2026-05-03-crash-backend-design.md`.

**Tech Stack:** Node 22 · TypeScript (strict, `noEmit`, run via `tsx`) · Express 4 · Socket.IO 4 · `pg` · zod · Vitest · `swagger-ui-express`. Hosted on Fly.io.

---

## File Structure

```
crash-backend/
├── README.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── openapi.yaml
├── Dockerfile
├── .gitignore
├── .env.example
├── migrations/
│   └── 001_init.sql
├── scripts/
│   └── migrate.ts
└── src/
    ├── server.ts                   # entrypoint: HTTP + IO + engine wiring
    ├── app.ts                      # express setup, middleware, routes
    ├── db.ts                       # pg pool + withTransaction
    ├── types.ts                    # Phase, ActiveBet, all payload types
    ├── engine/
    │   ├── engine.ts               # Engine extends EventEmitter
    │   ├── multiplier.ts           # computeMultiplier, generateCrash
    │   ├── multiplier.test.ts
    │   └── engine.test.ts
    ├── socket/
    │   ├── server.ts               # io.use auth + connection handler
    │   ├── handlers.ts             # bet:place / bet:cashout dispatchers
    │   └── broadcast.ts            # engine events → io.emit
    ├── repos/
    │   ├── playerRepo.ts
    │   ├── roundRepo.ts
    │   ├── betRepo.ts
    │   └── repos.test.ts           # integration tests against test DB
    ├── routes/
    │   ├── balance.ts
    │   ├── history.ts
    │   ├── recent.ts
    │   └── docs.ts
    ├── middleware/
    │   ├── apiKey.ts
    │   └── errors.ts
    └── domain/
        └── schemas.ts              # zod request schemas
```

**Boundary rules:**
- `engine/` imports only from `repos/`, `domain/`, `types.ts`. Never from `socket/` or `routes/`.
- `socket/broadcast.ts` is the only place where `io.emit` and engine events meet.
- `repos/*` accept an optional `client?: PoolClient` so they participate in transactions.

---

## Task 1: Project bootstrap

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`

- [ ] **Step 1: Initialize git and create `package.json`**

```bash
cd /Users/stas/Desktop/crash-backend
git init
```

Create `package.json`:

```json
{
  "name": "crash-backend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --env-file=.env.local --import tsx --watch src/server.ts",
    "start": "node --import tsx src/server.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "migrate": "node --env-file=.env.local --import tsx scripts/migrate.ts"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.21.0",
    "pg": "^8.13.0",
    "socket.io": "^4.8.0",
    "swagger-ui-express": "^5.0.1",
    "yaml": "^2.6.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.10",
    "@types/swagger-ui-express": "^4.1.6",
    "socket.io-client": "^4.8.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*", "scripts/**/*"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules
.env
.env.local
*.log
.DS_Store
dist
coverage
```

- [ ] **Step 5: Create `.env.example`**

```
PORT=3000
DATABASE_URL=postgres://user:pass@localhost:5432/crash
ALLOWED_ORIGIN=*
```

- [ ] **Step 6: Install and verify**

```bash
npm install
npm run typecheck
```
Expected: `typecheck` passes (no source files yet → no errors).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example
git commit -m "chore: bootstrap project (package.json, tsconfig, vitest, gitignore)"
```

---

## Task 2: Database migration + migrate script

**Files:**
- Create: `migrations/001_init.sql`, `scripts/migrate.ts`

- [ ] **Step 1: Create `migrations/001_init.sql`**

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
    api_key      TEXT PRIMARY KEY,
    balance      NUMERIC(12, 2) NOT NULL DEFAULT 10000.00,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE round_status AS ENUM ('running', 'crashed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS rounds (
    id           BIGSERIAL PRIMARY KEY,
    status       round_status NOT NULL,
    started_at   TIMESTAMPTZ  NOT NULL,
    crashed_at   TIMESTAMPTZ,
    crash_point  NUMERIC(10, 4),
    seed         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS rounds_crashed_at_idx
    ON rounds (crashed_at DESC) WHERE status = 'crashed';

-- ────────────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE bet_status AS ENUM ('placed', 'cashed_out', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS bets (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    round_id           BIGINT NOT NULL REFERENCES rounds(id),
    api_key            TEXT   NOT NULL REFERENCES players(api_key),
    amount             NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    auto_cashout_at    NUMERIC(10, 4),
    status             bet_status NOT NULL DEFAULT 'placed',
    cashout_multiplier NUMERIC(10, 4),
    win_amount         NUMERIC(12, 2),
    placed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS bets_one_per_round_per_player
    ON bets (round_id, api_key);

CREATE INDEX IF NOT EXISTS bets_player_placed_idx
    ON bets (api_key, placed_at DESC);
```

- [ ] **Step 2: Create `scripts/migrate.ts`**

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

const dir = join(process.cwd(), 'migrations');
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8');
  console.log(`Running ${file}...`);
  await pool.query(sql);
}

console.log('Migrations done.');
await pool.end();
```

- [ ] **Step 3: Manually run against a local Postgres to verify**

```bash
# Assumes a local Postgres reachable per .env.local
cp .env.example .env.local
# (edit DATABASE_URL to point at your dev DB)
npm run migrate
```
Expected: `Running 001_init.sql...` then `Migrations done.` Verify tables exist with `psql $DATABASE_URL -c '\dt'`.

- [ ] **Step 4: Commit**

```bash
git add migrations/ scripts/
git commit -m "feat(db): add initial schema (players, rounds, bets) + migrate script"
```

---

## Task 3: DB pool + transaction helper

**Files:**
- Create: `src/db.ts`

- [ ] **Step 1: Create `src/db.ts`**

```ts
import pg, { type PoolClient } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/db.ts
git commit -m "feat(db): add pg pool and withTransaction helper"
```

---

## Task 4: Shared types + zod schemas

**Files:**
- Create: `src/types.ts`, `src/domain/schemas.ts`

- [ ] **Step 1: Create `src/types.ts`**

```ts
// ── Engine domain ──────────────────────────────────────────
export type Phase = 'waiting' | 'running' | 'crashed';

export interface ActiveBet {
  betId: string;
  apiKey: string;
  amount: number;
  autoCashOutAt: number | null;
  placedAt: Date;
}

// ── Public WebSocket payloads (client-facing, no apiKey) ──
export type RejectReason =
  | 'betting_closed'
  | 'already_has_bet'
  | 'no_active_bet'
  | 'not_running'
  | 'insufficient_balance'
  | 'invalid_auto_cashout'
  | 'invalid_payload';

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
  playerCount: number;
}

export interface RoundWaitingEvent {
  roundId: string;
  endsAt: string;
  playerCount: 0;
}

export interface RoundStartEvent {
  roundId: string;
  startedAt: string;
  playerCount: number;
}

export interface RoundTickEvent {
  roundId: string;
  multiplier: number;
  elapsedMs: number;
}

export interface RoundCrashEvent {
  roundId: string;
  crashPoint: number;
  playerCount: number;
}

export interface BetPlacedEvent {
  betId: string;
  roundId: string;
  amount: number;
  autoCashOutAt: number | null;
  balance: number;
}

export interface BetCashedOutEvent {
  betId: string;
  multiplier: number;
  winAmount: number;
  profit: number;
  balance: number;
}

export interface BetLostEvent {
  betId: string;
  crashPoint: number;
  balance: number;
}

export interface BetRejectedEvent {
  reason: RejectReason;
  message: string;
}

// ── REST response shapes ─────────────────────────────────
export interface BalanceResponse {
  balance: number;
}

export interface HistoryBet {
  betId: string;
  roundId: string;
  amount: number;
  autoCashOutAt: number | null;
  status: 'placed' | 'cashed_out' | 'lost';
  multiplier: number | null;
  winAmount: number | null;
  profit: number | null;
  placedAt: string;
  settledAt: string | null;
}

export interface HistoryResponse {
  bets: HistoryBet[];
}

export interface RecentRound {
  roundId: string;
  crashPoint: number;
  crashedAt: string;
}

export interface RecentRoundsResponse {
  rounds: RecentRound[];
}

// Helper: convert internal numeric round id → public string
export const publicRoundId = (id: number): string => `round_${id}`;
```

- [ ] **Step 2: Create `src/domain/schemas.ts`**

```ts
import { z } from 'zod';

export const betPlaceSchema = z.object({
  amount: z.number().positive().max(10_000),
  autoCashOutAt: z.number().min(1.01).nullable().optional(),
});

export const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type BetPlaceInput = z.infer<typeof betPlaceSchema>;
```

- [ ] **Step 3: Verify typecheck**

```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/domain/
git commit -m "feat(types): add shared types and zod schemas"
```

---

## Task 5: Multiplier module (TDD)

**Files:**
- Create: `src/engine/multiplier.ts`, `src/engine/multiplier.test.ts`

- [ ] **Step 1: Write `src/engine/multiplier.test.ts` first (failing)**

```ts
import { describe, it, expect } from 'vitest';
import { computeMultiplier, generateCrash } from './multiplier.js';

describe('computeMultiplier', () => {
  it('returns 1.00 at t=0', () => {
    expect(computeMultiplier(0)).toBe(1.0);
  });

  it('grows monotonically', () => {
    expect(computeMultiplier(1000)).toBeGreaterThan(computeMultiplier(0));
    expect(computeMultiplier(5000)).toBeGreaterThan(computeMultiplier(1000));
    expect(computeMultiplier(30_000)).toBeGreaterThan(computeMultiplier(5000));
  });

  it('matches expected values for the Conservative preset', () => {
    expect(computeMultiplier(5000)).toBeCloseTo(1.35, 1);
    expect(computeMultiplier(10_000)).toBeCloseTo(1.82, 1);
    expect(computeMultiplier(30_000)).toBeCloseTo(6.05, 0);
  });

  it('rounds down to 2 decimals', () => {
    const m = computeMultiplier(1234);
    expect(Number.isInteger(m * 100)).toBe(true);
  });
});

describe('generateCrash', () => {
  it('is deterministic for a given seed', () => {
    const seed = 'a'.repeat(64);
    expect(generateCrash(seed)).toBe(generateCrash(seed));
  });

  it('returns 1.00 for the bottom 1% of the seed space (house edge)', () => {
    // u < 0.01 ⇒ instant crash. Construct seed where first 13 hex digits give a tiny u.
    const seed = '0000000000000' + 'f'.repeat(64 - 13);
    expect(generateCrash(seed)).toBe(1.0);
  });

  it('returns >= 1.00 for any seed', () => {
    for (let i = 0; i < 100; i++) {
      const seed = i.toString(16).padStart(64, '0');
      expect(generateCrash(seed)).toBeGreaterThanOrEqual(1.0);
    }
  });

  it('produces a heavy-tail distribution (sanity check)', () => {
    let high = 0;
    for (let i = 0; i < 1000; i++) {
      // pseudo-random seed per iteration
      const seed = (i * 99991).toString(16).padStart(64, '0');
      if (generateCrash(seed) >= 3.0) high++;
    }
    // Roughly ~1/3 should be >= 3.0 with our distribution; allow loose bounds.
    expect(high).toBeGreaterThan(150);
    expect(high).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm test -- src/engine/multiplier.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/engine/multiplier.ts`**

```ts
export function computeMultiplier(elapsedMs: number): number {
  const t = elapsedMs / 1000;
  const m = Math.exp(0.06 * t);
  // Round DOWN to 2 decimals so the displayed value never exceeds the true value.
  return Math.floor(m * 100) / 100;
}

export function generateCrash(seed: string): number {
  // Take the first 13 hex characters → 52 bits → uniform in [0, 1)
  const u = parseInt(seed.slice(0, 13), 16) / Math.pow(2, 52);
  if (u < 0.01) return 1.0;          // 1% house edge: instant crash
  const crash = 0.99 / (1 - u);
  return Math.floor(crash * 100) / 100;
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
npm test -- src/engine/multiplier.test.ts
```
Expected: PASS, all 7 cases.

- [ ] **Step 5: Commit**

```bash
git add src/engine/multiplier.ts src/engine/multiplier.test.ts
git commit -m "feat(engine): add multiplier formula and crash distribution"
```

---

## Task 6: Repos (TDD against test DB)

**Files:**
- Create: `src/repos/playerRepo.ts`, `src/repos/roundRepo.ts`, `src/repos/betRepo.ts`, `src/repos/repos.test.ts`

> **Test DB requirement:** these tests run against the real Postgres pointed at by `DATABASE_URL`. The test suite truncates relevant tables in `beforeEach`. Do NOT point this at a production DB. Use `.env.local` with a dev/local DB.

- [ ] **Step 1: Write `src/repos/repos.test.ts` first (failing)**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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
      const bet = await betRepo.insertPlaced(client, round.id, 'frank', 100, null);
      expect(bet.id).toMatch(/^[0-9a-f-]{36}$/);
      await expect(
        betRepo.insertPlaced(client, round.id, 'frank', 50, null),
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
      const bet = await betRepo.insertPlaced(client, round.id, 'grace', 100, 2.0);
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
      await betRepo.insertPlaced(c, round.id, 'henry', 100, null);
      await betRepo.insertPlaced(c, round.id, 'iris', 200, null);
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
      const bet = await betRepo.insertPlaced(c, round.id, 'jane', 100, null);
      await betRepo.deleteById(c, bet.id);
      await c.query('COMMIT');
    } finally { c.release(); }
    const r = await pool.query("SELECT 1 FROM bets WHERE api_key = 'jane'");
    expect(r.rowCount).toBe(0);
  });

  it('listForPlayer returns most recent bets first', async () => {
    await playerRepo.ensureExists('kim');
    const round = await roundRepo.insertRunning(new Date(), 'seed');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await betRepo.insertPlaced(c, round.id, 'kim', 100, null);
      await c.query('COMMIT');
    } finally { c.release(); }
    const list = await betRepo.listForPlayer('kim', 10);
    expect(list).toHaveLength(1);
    expect(list[0].apiKey).toBe('kim');
    expect(list[0].amount).toBe(100);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npm test -- src/repos/repos.test.ts
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/repos/playerRepo.ts`**

```ts
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
```

- [ ] **Step 4: Implement `src/repos/roundRepo.ts`**

```ts
import { pool } from '../db.js';
import type { RecentRound } from '../types.js';
import { publicRoundId } from '../types.js';

export async function insertRunning(
  startedAt: Date,
  seed: string,
): Promise<{ id: number }> {
  const r = await pool.query<{ id: string }>(
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
  return r.rows.map(row => ({
    roundId: publicRoundId(Number(row.id)),
    crashPoint: Number(row.crash_point),
    crashedAt: row.crashed_at.toISOString(),
  }));
}
```

- [ ] **Step 5: Implement `src/repos/betRepo.ts`**

```ts
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
): Promise<{ id: string }> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO bets (round_id, api_key, amount, auto_cashout_at)
          VALUES ($1, $2, $3, $4)
       RETURNING id`,
    [roundId, apiKey, amount, autoCashOutAt],
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
```

- [ ] **Step 6: Run tests to confirm pass**

```bash
npm test -- src/repos/repos.test.ts
```
Expected: all repo tests PASS. If a test fails because the DB isn't migrated, run `npm run migrate` and retry.

- [ ] **Step 7: Commit**

```bash
git add src/repos/
git commit -m "feat(repos): add player, round, and bet repositories with integration tests"
```

---

## Task 7: Engine (TDD with mocked repos + injected clock)

**Files:**
- Create: `src/engine/engine.ts`, `src/engine/engine.test.ts`

> **Note:** Tests inject a fake clock and call state-machine methods directly (`advanceToWaiting`, `advanceToRunning`, `tick`, `advanceToCrashed`). The production engine wires these into `setTimeout` and `setInterval`, but tests never fire real timers — that's how we avoid flakiness.

- [ ] **Step 1: Write `src/engine/engine.test.ts` first (failing)**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
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
    insertRunning: async () => ({ id: ++roundCounter }),
    markCrashed: async () => {},
    maxId: async () => 0,
  };

  const betRepo = {
    insertPlaced: async (_c: unknown, roundId: number, apiKey: string, amount: number, auto: number | null) => {
      const id = `bet-${insertedBets.length + 1}`;
      insertedBets.push({ id, roundId, apiKey, amount, auto });
      return { id };
    },
    markCashedOut: async (_c: unknown, betId: string, multiplier: number, winAmount: number) => {
      cashedOut.push({ betId, multiplier, winAmount });
    },
    settleAllLost: async (roundId: number) => { settledLost.push(roundId); },
    settleAllOrphaned: async () => {},
    deleteById: async () => {},
  };

  // Mock withTransaction to just call the callback with a fake client
  const withTransaction = async <T,>(fn: (c: unknown) => Promise<T>) => fn({});

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
  });

  it('auto cashout settles on TARGET, not on current tick value', async () => {
    await engine.placeBet('alice', 100, 1.5);
    engine.__setCrashPointForTest(99.0);
    await engine.advanceToRunning();
    clock.advance(8000);  // multiplier ≈ 1.61, well past 1.5 target
    engine.tick();
    const cashed = events.find(e => e.name === 'bet:cashedOut');
    expect(cashed).toBeDefined();
    const p = cashed!.payload as { multiplier: number; winAmount: number };
    expect(p.multiplier).toBe(1.5);          // target, not 1.61
    expect(p.winAmount).toBe(150);
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
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npm test -- src/engine/engine.test.ts
```
Expected: FAIL — Engine module not found.

- [ ] **Step 3: Implement `src/engine/engine.ts`**

```ts
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { computeMultiplier, generateCrash } from './multiplier.js';
import type { ActiveBet, Phase } from '../types.js';
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
  insertRunning(startedAt: Date, seed: string): Promise<{ id: number }>;
  markCrashed(id: number, crashPoint: number): Promise<void>;
  maxId(): Promise<number>;
}

interface BetRepoLike {
  insertPlaced(client: PoolClient, roundId: number, apiKey: string, amount: number, auto: number | null): Promise<{ id: string }>;
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
    let result: { balance: number; betId: string };
    try {
      result = await this.deps.withTransaction(async (c) => {
        const balance = await this.deps.playerRepo.debit(c, apiKey, amount);
        const bet = await this.deps.betRepo.insertPlaced(c, this.state.roundId, apiKey, amount, autoCashOutAt);
        return { balance, betId: bet.id };
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'INSUFFICIENT') {
        this.emit('bet:rejected', { apiKey, reason: 'insufficient_balance', message: 'Not enough balance' });
        return;
      }
      if (code === '23505') {
        this.emit('bet:rejected', { apiKey, reason: 'already_has_bet', message: 'You already have a bet in this round' });
        return;
      }
      throw err;
    }
    if (this.state.phase !== 'waiting') {
      // window closed during the transaction — refund
      await this.deps.withTransaction(async (c) => {
        await this.deps.betRepo.deleteById(c, result.betId);
        await this.deps.playerRepo.credit(c, apiKey, amount);
      });
      this.emit('bet:rejected', { apiKey, reason: 'betting_closed', message: 'Betting window closed during placement' });
      return;
    }
    this.state.bets.set(apiKey, {
      betId: result.betId, apiKey, amount, autoCashOutAt, placedAt: new Date(this.clock()),
    });
    this.emit('bet:placed', {
      apiKey, betId: result.betId, roundId: publicRoundId(this.state.roundId),
      amount, autoCashOutAt, balance: result.balance,
    });
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
    this.state.startedAt = null;
    this.state.crashPoint = null;
    this.state.multiplier = 1.0;
    const endsAt = new Date(this.clock() + WAITING_MS);
    this.state.endsAt = endsAt;
    const nextRoundIdLabel = publicRoundId(this.state.roundId + 1);  // tentative
    this.emit('phase:waiting', { roundId: nextRoundIdLabel, endsAt: endsAt.toISOString(), playerCount: 0 });
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
    const round = await this.deps.roundRepo.insertRunning(this.state.startedAt, this.state.seed);
    this.state.roundId = round.id;
    this.state.phase = 'running';
    this.state.multiplier = 1.0;
    this.state.endsAt = null;
    this.emit('phase:running', {
      roundId: publicRoundId(round.id),
      startedAt: this.state.startedAt.toISOString(),
      playerCount: this.state.bets.size,
    });
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
      void this.advanceToCrashed();
      return;
    }
    // Process auto-cashouts (settle on target, not on current m)
    for (const bet of [...this.state.bets.values()]) {
      if (bet.autoCashOutAt !== null && m >= bet.autoCashOutAt) {
        void this.settleCashout(bet, bet.autoCashOutAt);
      }
    }
    this.emit('tick', {
      roundId: publicRoundId(this.state.roundId),
      multiplier: m,
      elapsedMs: elapsed,
    });
  }

  async advanceToCrashed(): Promise<void> {
    if (this.state.phase === 'crashed') return;
    this.clearTickInterval();
    const cp = this.state.crashPoint!;
    this.state.multiplier = cp;
    this.state.phase = 'crashed';
    await this.deps.betRepo.settleAllLost(this.state.roundId);
    await this.deps.roundRepo.markCrashed(this.state.roundId, cp);
    this.emit('phase:crashed', {
      roundId: publicRoundId(this.state.roundId),
      crashPoint: cp,
      playerCount: this.state.bets.size,
    });
    for (const bet of this.state.bets.values()) {
      const balance = await this.deps.playerRepo.getBalance(bet.apiKey);
      this.emit('bet:lost', {
        apiKey: bet.apiKey, betId: bet.betId, crashPoint: cp, balance,
      });
    }
    if (this.autoTimers) {
      this.phaseTimer = setTimeout(() => this.advanceToWaiting(), CRASHED_PAUSE_MS);
    }
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
    this.emit('bet:cashedOut', {
      apiKey: bet.apiKey, betId: bet.betId, multiplier: atMultiplier, winAmount, profit, balance,
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
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
npm test -- src/engine/engine.test.ts
```
Expected: all 10 engine tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts src/engine/engine.test.ts
git commit -m "feat(engine): add Engine state machine with phase loop, bets, and cashouts"
```

---

## Task 8: Express app shell, error handler, apiKey middleware

**Files:**
- Create: `src/middleware/errors.ts`, `src/middleware/apiKey.ts`, `src/app.ts`

- [ ] **Step 1: Create `src/middleware/errors.ts`**

```ts
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const path = issue.path.join('.');
    return res.status(400).json({ error: path ? `${path}: ${issue.message}` : issue.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
}
```

- [ ] **Step 2: Create `src/middleware/apiKey.ts`**

```ts
import type { Request, Response, NextFunction } from 'express';
import * as playerRepo from '../repos/playerRepo.js';
import { AppError } from './errors.js';

declare global {
  namespace Express {
    interface Request {
      apiKey: string;
    }
  }
}

export async function apiKeyMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const key = req.header('X-API-Key');
    if (!key || key.trim().length === 0) {
      throw new AppError(401, 'X-API-Key header is required');
    }
    await playerRepo.ensureExists(key);
    req.apiKey = key;
    next();
  } catch (err) {
    next(err);
  }
}
```

- [ ] **Step 3: Create `src/app.ts` (routes will be added in later tasks)**

```ts
import express from 'express';
import cors from 'cors';
import { errorHandler } from './middleware/errors.js';

export function createApp() {
  const app = express();
  app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? '*' }));
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // (routes registered by registerRoutes in a later task)

  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 4: Verify typecheck**

```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/ src/app.ts
git commit -m "feat(http): add express app shell, error handler, X-API-Key middleware"
```

---

## Task 9: REST routes (balance, history, recent)

**Files:**
- Create: `src/routes/balance.ts`, `src/routes/history.ts`, `src/routes/recent.ts`
- Modify: `src/app.ts`

- [ ] **Step 1: Create `src/routes/balance.ts`**

```ts
import { Router } from 'express';
import * as playerRepo from '../repos/playerRepo.js';
import type { BalanceResponse } from '../types.js';

export const balanceRouter = Router();

balanceRouter.get('/balance', async (req, res, next) => {
  try {
    const balance = await playerRepo.getBalance(req.apiKey);
    const response: BalanceResponse = { balance };
    res.json(response);
  } catch (err) { next(err); }
});
```

- [ ] **Step 2: Create `src/routes/history.ts`**

```ts
import { Router } from 'express';
import * as betRepo from '../repos/betRepo.js';
import { limitQuerySchema } from '../domain/schemas.js';
import type { HistoryResponse } from '../types.js';

export const historyRouter = Router();

historyRouter.get('/history', async (req, res, next) => {
  try {
    const { limit } = limitQuerySchema.parse(req.query);
    const rows = await betRepo.listForPlayer(req.apiKey, limit);
    // Strip apiKey from the response — the client knows its own key.
    const bets = rows.map(({ apiKey, ...rest }) => rest);
    const response: HistoryResponse = { bets };
    res.json(response);
  } catch (err) { next(err); }
});
```

- [ ] **Step 3: Create `src/routes/recent.ts`**

```ts
import { Router } from 'express';
import * as roundRepo from '../repos/roundRepo.js';
import { limitQuerySchema } from '../domain/schemas.js';
import type { RecentRoundsResponse } from '../types.js';

export const recentRouter = Router();

recentRouter.get('/rounds/recent', async (req, res, next) => {
  try {
    const { limit } = limitQuerySchema.parse(req.query);
    const rounds = await roundRepo.listRecent(limit);
    const response: RecentRoundsResponse = { rounds };
    res.json(response);
  } catch (err) { next(err); }
});
```

- [ ] **Step 4: Wire routes in `src/app.ts`**

Replace the body of `src/app.ts` with:

```ts
import express from 'express';
import cors from 'cors';
import { errorHandler } from './middleware/errors.js';
import { apiKeyMiddleware } from './middleware/apiKey.js';
import { balanceRouter } from './routes/balance.js';
import { historyRouter } from './routes/history.js';
import { recentRouter } from './routes/recent.js';

export function createApp() {
  const app = express();
  app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? '*' }));
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Auth-required routes
  app.use('/api', apiKeyMiddleware);
  app.use('/api', balanceRouter);
  app.use('/api', historyRouter);
  app.use('/api', recentRouter);

  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 5: Verify typecheck**

```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 6: Manual smoke test (optional, requires DB)**

```bash
# In one terminal — minimal entry to test routes:
node --env-file=.env.local --import tsx -e "import('./src/app.ts').then(m => m.createApp().listen(3000))"
# In another:
curl -s http://localhost:3000/api/health
curl -s -H 'X-API-Key: alice' http://localhost:3000/api/balance
```
Expected: `{"ok":true}` and `{"balance":10000}`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/balance.ts src/routes/history.ts src/routes/recent.ts src/app.ts
git commit -m "feat(rest): add /api/balance, /api/history, /api/rounds/recent"
```

---

## Task 10: Socket layer (server, handlers, broadcast)

**Files:**
- Create: `src/socket/server.ts`, `src/socket/handlers.ts`, `src/socket/broadcast.ts`

- [ ] **Step 1: Create `src/socket/server.ts`**

```ts
import type { Server } from 'socket.io';
import * as playerRepo from '../repos/playerRepo.js';
import { Engine } from '../engine/engine.js';
import { registerHandlers } from './handlers.js';
import { publicRoundId } from '../types.js';
import type { RoundStateEvent } from '../types.js';

// apiKey → set of socket ids (one player can have many tabs)
export const sockets = new Map<string, Set<string>>();

export function registerSocketHandlers(io: Server, engine: Engine): void {
  io.use(async (socket, next) => {
    const key = socket.handshake.auth?.apiKey;
    if (typeof key !== 'string' || key.trim().length === 0) {
      return next(new Error('UNAUTHORIZED'));
    }
    await playerRepo.ensureExists(key);
    socket.data.apiKey = key;
    next();
  });

  io.on('connection', (socket) => {
    const apiKey = socket.data.apiKey as string;

    // Track socket
    let set = sockets.get(apiKey);
    if (!set) { set = new Set(); sockets.set(apiKey, set); }
    set.add(socket.id);

    // Send round:state snapshot
    const state = engine.getState();
    const yourBet = state.bets.get(apiKey);
    const snapshot: RoundStateEvent = {
      phase: state.phase,
      roundId: publicRoundId(state.roundId),
      startedAt: state.startedAt?.toISOString() ?? null,
      endsAt: state.endsAt?.toISOString() ?? null,
      currentMultiplier: state.multiplier,
      crashPoint: state.phase === 'crashed' ? state.crashPoint : null,
      yourBet: yourBet
        ? { amount: yourBet.amount, autoCashOutAt: yourBet.autoCashOutAt, status: 'placed' }
        : null,
      playerCount: state.bets.size,
    };
    socket.emit('round:state', snapshot);

    registerHandlers(socket, engine);

    socket.on('disconnect', () => {
      const s = sockets.get(apiKey);
      if (s) {
        s.delete(socket.id);
        if (s.size === 0) sockets.delete(apiKey);
      }
    });
  });
}
```

- [ ] **Step 2: Create `src/socket/handlers.ts`**

```ts
import type { Socket } from 'socket.io';
import { Engine } from '../engine/engine.js';
import { betPlaceSchema } from '../domain/schemas.js';

export function registerHandlers(socket: Socket, engine: Engine): void {
  const apiKey = socket.data.apiKey as string;

  socket.on('bet:place', async (raw, ack?: (res: unknown) => void) => {
    const parsed = betPlaceSchema.safeParse(raw);
    if (!parsed.success) {
      socket.emit('bet:rejected', {
        reason: 'invalid_payload',
        message: parsed.error.issues[0]?.message ?? 'Invalid payload',
      });
      ack?.({ ok: false });
      return;
    }
    const { amount, autoCashOutAt } = parsed.data;
    await engine.placeBet(apiKey, amount, autoCashOutAt ?? null);
    ack?.({ ok: true });
  });

  socket.on('bet:cashout', async (_raw, ack?: (res: unknown) => void) => {
    await engine.cashout(apiKey);
    ack?.({ ok: true });
  });
}
```

- [ ] **Step 3: Create `src/socket/broadcast.ts`**

```ts
import type { Server } from 'socket.io';
import { Engine } from '../engine/engine.js';
import { sockets } from './server.js';

const broadcastEvents = ['round:waiting', 'round:start', 'round:tick', 'round:crash'] as const;
const playerEvents = ['bet:placed', 'bet:cashedOut', 'bet:lost', 'bet:rejected'] as const;

const engineEventMap: Record<string, string> = {
  'phase:waiting': 'round:waiting',
  'phase:running': 'round:start',
  'phase:crashed': 'round:crash',
  'tick': 'round:tick',
};

export function wireBroadcast(engine: Engine, io: Server): void {
  // Phase / tick events → broadcast
  for (const engineName of Object.keys(engineEventMap)) {
    engine.on(engineName, (payload) => {
      io.emit(engineEventMap[engineName], payload);
    });
  }

  // Player-targeted events: payload has `apiKey` → strip and emit only to those sockets
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
}

// re-exported for consumers that want to know the broadcast names
export { broadcastEvents, playerEvents };
```

- [ ] **Step 4: Verify typecheck**

```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/socket/
git commit -m "feat(socket): add Socket.IO server, handlers, and broadcast adapter"
```

---

## Task 11: OpenAPI spec + docs route

**Files:**
- Create: `openapi.yaml`, `src/routes/docs.ts`
- Modify: `src/app.ts`

- [ ] **Step 1: Create `openapi.yaml`**

```yaml
openapi: 3.0.3

info:
  title: Crash Backend API
  version: 0.1.0
  description: |
    Real-time Crash game backend.
    Multi-tenant via the `X-API-Key` request header — auto-creates a new
    player on first request with starting balance 10,000.

    ## WebSocket events

    Connect via Socket.IO with `auth: { apiKey: '<your-key>' }`. The
    server sends `round:state` immediately on connection and again on
    every reconnect.

    ### Server → Client

    | Event | Payload |
    |---|---|
    | `round:state` | `{ phase, roundId, startedAt, endsAt, currentMultiplier, crashPoint, yourBet, playerCount }` |
    | `round:waiting` | `{ roundId, endsAt, playerCount: 0 }` |
    | `round:start` | `{ roundId, startedAt, playerCount }` |
    | `round:tick` | `{ roundId, multiplier, elapsedMs }` |
    | `round:crash` | `{ roundId, crashPoint, playerCount }` |
    | `bet:placed` | `{ betId, roundId, amount, autoCashOutAt, balance }` |
    | `bet:cashedOut` | `{ betId, multiplier, winAmount, profit, balance }` |
    | `bet:lost` | `{ betId, crashPoint, balance }` |
    | `bet:rejected` | `{ reason, message }` |

    ### Client → Server

    | Event | Payload |
    |---|---|
    | `bet:place` | `{ amount: number, autoCashOutAt?: number \| null }` |
    | `bet:cashout` | `{}` |

    Reject reasons: `betting_closed`, `already_has_bet`, `no_active_bet`,
    `not_running`, `insufficient_balance`, `invalid_auto_cashout`,
    `invalid_payload`.

servers:
  - url: http://localhost:3000
    description: Local development

tags:
  - name: System
  - name: Player
  - name: Round

components:
  securitySchemes:
    ApiKey:
      type: apiKey
      in: header
      name: X-API-Key

  schemas:
    Error:
      type: object
      required: [error]
      properties:
        error: { type: string }

    Balance:
      type: object
      required: [balance]
      properties:
        balance: { type: number }

    HistoryBet:
      type: object
      properties:
        betId: { type: string }
        roundId: { type: string }
        amount: { type: number }
        autoCashOutAt: { type: number, nullable: true }
        status: { type: string, enum: [placed, cashed_out, lost] }
        multiplier: { type: number, nullable: true }
        winAmount: { type: number, nullable: true }
        profit: { type: number, nullable: true }
        placedAt: { type: string, format: date-time }
        settledAt: { type: string, format: date-time, nullable: true }

    History:
      type: object
      properties:
        bets:
          type: array
          items: { $ref: '#/components/schemas/HistoryBet' }

    RecentRound:
      type: object
      properties:
        roundId: { type: string }
        crashPoint: { type: number }
        crashedAt: { type: string, format: date-time }

    RecentRounds:
      type: object
      properties:
        rounds:
          type: array
          items: { $ref: '#/components/schemas/RecentRound' }

paths:
  /api/health:
    get:
      tags: [System]
      summary: Liveness probe
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { type: object, properties: { ok: { type: boolean } } }

  /api/balance:
    get:
      tags: [Player]
      summary: Current balance
      security: [{ ApiKey: [] }]
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Balance' }

  /api/history:
    get:
      tags: [Player]
      summary: Bet history
      security: [{ ApiKey: [] }]
      parameters:
        - in: query
          name: limit
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/History' }

  /api/rounds/recent:
    get:
      tags: [Round]
      summary: Recent crashed rounds
      parameters:
        - in: query
          name: limit
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RecentRounds' }
```

- [ ] **Step 2: Create `src/routes/docs.ts`**

```ts
import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import swaggerUi from 'swagger-ui-express';

const spec = parse(readFileSync(join(process.cwd(), 'openapi.yaml'), 'utf8'));

export const docsRouter = Router();
docsRouter.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
docsRouter.get('/openapi.json', (_req, res) => res.json(spec));
```

- [ ] **Step 3: Wire docs route in `src/app.ts`** (must be BEFORE the apiKey middleware so docs are public)

```ts
import express from 'express';
import cors from 'cors';
import { errorHandler } from './middleware/errors.js';
import { apiKeyMiddleware } from './middleware/apiKey.js';
import { balanceRouter } from './routes/balance.js';
import { historyRouter } from './routes/history.js';
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
  app.use('/api', historyRouter);
  app.use('/api', recentRouter);

  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 4: Verify typecheck**

```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add openapi.yaml src/routes/docs.ts src/app.ts
git commit -m "feat(docs): add OpenAPI spec and Swagger UI at /api/docs"
```

---

## Task 12: Entrypoint, Dockerfile, README

**Files:**
- Create: `src/server.ts`, `Dockerfile`, `README.md`

- [ ] **Step 1: Create `src/server.ts`**

```ts
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import { createApp } from './app.js';
import { Engine } from './engine/engine.js';
import { registerSocketHandlers } from './socket/server.js';
import { wireBroadcast } from './socket/broadcast.js';
import * as playerRepo from './repos/playerRepo.js';
import * as roundRepo from './repos/roundRepo.js';
import * as betRepo from './repos/betRepo.js';
import { withTransaction } from './db.js';

const app = createApp();
const httpServer = http.createServer(app);
const io = new IOServer(httpServer, {
  cors: { origin: process.env.ALLOWED_ORIGIN ?? '*' },
});

const engine = new Engine(
  { playerRepo, roundRepo, betRepo, withTransaction },
);

wireBroadcast(engine, io);
registerSocketHandlers(io, engine);
await engine.start();

const port = Number(process.env.PORT ?? 3000);
httpServer.listen(port, () => {
  console.log(`Crash backend listening on http://localhost:${port}`);
  console.log(`Docs at http://localhost:${port}/api/docs`);
});
```

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run typecheck
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start"]
```

- [ ] **Step 3: Create `README.md`**

```markdown
# Crash Backend

Real-time Crash game backend for the Week 4 frontend homework.
Multi-tenant via the `X-API-Key` header (any non-empty string is a
valid identifier; first sighting auto-creates a player with starting
balance 10,000). Server is the source of truth for phase, multiplier,
and bet outcomes.

## Stack

TypeScript · Express · Socket.IO · Postgres (`pg`) · zod · Vitest ·
`swagger-ui-express`. Single long-running Node process — not serverless.

## Endpoints

| | Path | Notes |
|---|---|---|
| GET | `/api/health` | Liveness (no auth) |
| GET | `/api/docs` | Swagger UI (no auth) |
| GET | `/api/balance` | Current balance |
| GET | `/api/history?limit=20` | Player's bet history |
| GET | `/api/rounds/recent?limit=20` | Last N crash points |

WebSocket: `socket.io-client` with `auth: { apiKey: '<your-key>' }`.
Full event reference at `/api/docs` → "WebSocket events" section.

## Local development

```bash
npm install
cp .env.example .env.local
# edit DATABASE_URL to point at a local Postgres
npm run migrate
npm run dev
# → http://localhost:3000
# → http://localhost:3000/api/docs
```

## Tests

```bash
npm test
```

Repo tests run against the database at `DATABASE_URL` and TRUNCATE
between cases — do NOT point this at production.

## Deployment

```bash
fly launch          # follow prompts; uses the included Dockerfile
fly postgres create # provision a managed Postgres
fly ssh console -C "npm run migrate"
fly deploy
```

## Spec & plan

- `docs/superpowers/specs/2026-05-03-crash-backend-design.md`
- `docs/superpowers/plans/2026-05-03-crash-backend.md`
```

- [ ] **Step 4: Verify typecheck and that the server boots**

```bash
npm run typecheck
# In a terminal with .env.local set up:
npm run dev
# Expected output:
#   Crash backend listening on http://localhost:3000
#   Docs at http://localhost:3000/api/docs
# Hit ^C to stop.
```

- [ ] **Step 5: Commit**

```bash
git add src/server.ts Dockerfile README.md
git commit -m "feat: add entrypoint, Dockerfile, and README"
```

---

## Task 13: End-to-end smoke test

**Files:**
- Create: `scripts/smoke.ts`

> A throwaway script that spins up an in-process server, connects two
> Socket.IO clients with different API keys, places bets, cashes one
> out, asserts the events. Run manually after deploys.

- [ ] **Step 1: Create `scripts/smoke.ts`**

```ts
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { Engine } from '../src/engine/engine.js';
import { registerSocketHandlers } from '../src/socket/server.js';
import { wireBroadcast } from '../src/socket/broadcast.js';
import * as playerRepo from '../src/repos/playerRepo.js';
import * as roundRepo from '../src/repos/roundRepo.js';
import * as betRepo from '../src/repos/betRepo.js';
import { pool, withTransaction } from '../src/db.js';

const app = createApp();
const server = http.createServer(app);
const io = new IOServer(server);

const engine = new Engine({ playerRepo, roundRepo, betRepo, withTransaction });
wireBroadcast(engine, io);
registerSocketHandlers(io, engine);
await engine.start();

await new Promise<void>(resolve => server.listen(0, resolve));
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const url = `http://localhost:${port}`;
console.log(`smoke server on ${url}`);

function connect(apiKey: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(url, { auth: { apiKey } });
    s.once('round:state', () => resolve(s));
    s.once('connect_error', reject);
  });
}

const alice = await connect('smoke-alice');
const bob = await connect('smoke-bob');
console.log('connected: alice + bob');

// Wait for a fresh waiting phase
await new Promise<void>(resolve => alice.once('round:waiting', () => resolve()));
console.log('round:waiting received');

alice.emit('bet:place', { amount: 100, autoCashOutAt: null });
bob.emit('bet:place',   { amount: 200, autoCashOutAt: 1.5 });

const alicePlaced = await new Promise<unknown>(r => alice.once('bet:placed', r));
const bobPlaced = await new Promise<unknown>(r => bob.once('bet:placed', r));
console.log('bet:placed alice =', alicePlaced);
console.log('bet:placed bob =', bobPlaced);

await new Promise<void>(r => alice.once('round:start', () => r()));
console.log('round:start received');

// Alice cashes out manually after 1 second of running
setTimeout(() => alice.emit('bet:cashout', {}), 1000);

const aliceResult = await Promise.race([
  new Promise(r => alice.once('bet:cashedOut', e => r({ kind: 'cashed', e }))),
  new Promise(r => alice.once('bet:lost',      e => r({ kind: 'lost',   e }))),
]);
console.log('alice result:', aliceResult);

const bobResult = await Promise.race([
  new Promise(r => bob.once('bet:cashedOut', e => r({ kind: 'cashed', e }))),
  new Promise(r => bob.once('bet:lost',      e => r({ kind: 'lost',   e }))),
]);
console.log('bob result:', bobResult);

alice.close();
bob.close();
io.close();
server.close();
await pool.end();
console.log('smoke complete');
process.exit(0);
```

- [ ] **Step 2: Run the smoke test**

```bash
node --env-file=.env.local --import tsx scripts/smoke.ts
```
Expected output: connect logs, `round:waiting`, `bet:placed` for both players, `round:start`, then a result object for each player. The exact result depends on the random crash point — Alice may cash out, Bob may auto-cash at 1.5×, or one/both may lose if crash happens early.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.ts
git commit -m "test: add end-to-end smoke script"
```

---

## Verification checklist

After all tasks, run:

- `npm run typecheck` → PASS
- `npm test` → all unit + repo tests PASS
- `npm run dev` → server boots, logs the docs URL
- `curl http://localhost:3000/api/health` → `{"ok":true}`
- `curl -H 'X-API-Key: x' http://localhost:3000/api/balance` → `{"balance":10000}`
- Open `http://localhost:3000/api/docs` → Swagger UI renders, "WebSocket events" section visible
- `node --env-file=.env.local --import tsx scripts/smoke.ts` → completes with bet results

## Out of scope (per spec)

- Provably-fair commit-reveal
- Rate limiting
- JWT, refresh tokens, registration UI
- Multi-process horizontal scaling
- Admin endpoints, player profiles
