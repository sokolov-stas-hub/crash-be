# Crash Backend — Design

> Server-side backend for the Week 4 Crash homework. Real-time multiplayer
> game with WebSocket-pushed multiplier ticks, server-controlled round
> phases, and server-side auto-cashout. The companion to the Week 3
> mines-backend, but architected for a long-running stateful process
> instead of serverless.

## 1. Goals & Non-Goals

**Goals:**

- Provide one backend service implementing the full Crash WebSocket and
  REST contract specified by the frontend homework doc
  (`crash-game-docs.html`).
- Run an authoritative in-memory game loop: phase transitions, multiplier
  ticks (~5 Hz), server-side auto-cashout, crash detection.
- Persist players, rounds, and bets in Postgres so history survives
  restarts.
- Reuse the API-Key-as-identity pattern from mines-backend: any non-empty
  string is a valid identifier; first sighting auto-creates a player with
  starting balance 10,000.
- Educational clarity over premature optimization: clean module
  boundaries, typed events, no exotic dependencies.

**Non-Goals:**

- Provably-fair commit-reveal scheme (intentionally skipped to keep the
  WS payloads identical to the frontend doc).
- Horizontal scaling across multiple Node processes (engine is a single
  in-memory singleton).
- Refresh tokens, registration UI, or any auth beyond the static API
  key.
- Rate limiting, replay logs, admin endpoints, player profiles.

## 2. Stack

- **Runtime:** Node.js 22, single long-running process (not serverless)
- **HTTP:** Express 4
- **WebSocket:** Socket.IO 4 (chosen over native `ws` for built-in
  reconnect, broadcast, and typed event helpers)
- **DB:** Postgres via the standard `pg` driver. (Mines used
  `@neondatabase/serverless` because it had to run on Vercel Edge —
  irrelevant here since we run a long-lived Node process.)
- **Validation:** zod
- **Docs:** `swagger-ui-express` + `openapi.yaml`
- **Language:** TypeScript, strict mode, `noEmit` (run via `tsx`)
- **Hosting:** Long-running container on Fly.io (recommended) or Render.
  Vercel serverless is explicitly NOT used — incompatible with the
  persistent WS + game loop requirements.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  HTTP server (Express + Socket.IO on the same port)          │
│                                                              │
│  ┌─── REST routes ───┐    ┌─── Socket handlers ──────────┐   │
│  │ /api/balance      │    │ connection (handshake auth)  │   │
│  │ /api/history      │    │ disconnect                   │   │
│  │ /api/rounds/recent│    │ bet:place / bet:cashout      │   │
│  │ /api/health       │    └──────────┬───────────────────┘   │
│  │ /api/docs         │               │                       │
│  └─────────┬─────────┘               │                       │
│            │                         │                       │
│            ▼                         ▼                       │
│       ┌────────┐              ┌──────────────┐               │
│       │ repos/ │              │ engine.ts    │               │
│       │ (SQL)  │◀────────────▶│ (EventEmitter│               │
│       └────┬───┘              │  + setInterval)              │
│            │                  └──────┬───────┘               │
│            │                         │                       │
│            │                         │ emits: phase, tick,   │
│            │                         │        bet events     │
│            │                         ▼                       │
│            │                  ┌──────────────┐               │
│            │                  │ broadcast.ts │ ─io.emit─▶ WS │
│            │                  │ (engine→io)  │               │
│            │                  └──────────────┘               │
│            ▼                                                 │
│        Postgres ◀────────────────── engine writes rounds/bets│
└──────────────────────────────────────────────────────────────┘
```

### 3.1 Module responsibilities

- **`engine/engine.ts`** — Single `Engine extends EventEmitter` instance.
  Holds in-memory `EngineState`. Drives the game loop via `setTimeout`
  (phase transitions) and `setInterval` (tick loop). Emits structured
  events. Knows nothing about Socket.IO or Express. Depends only on
  `repos/` and `engine/multiplier.ts`.
- **`engine/multiplier.ts`** — Pure functions: `computeMultiplier(elapsedMs)`
  and `generateCrash(seed)`. No state, no I/O.
- **`socket/broadcast.ts`** — Subscribes to engine events and forwards
  them to `io.emit(...)`. The only file that bridges engine ↔ Socket.IO.
  Player-targeted events (`bet:placed`, `bet:cashedOut`, `bet:lost`,
  `bet:rejected`) carry an `apiKey` field on the engine event; the
  adapter uses it to find the player's sockets via the
  `apiKey → Set<socket.id>` map and **strips it** before emitting (the
  client doesn't need to know its own apiKey, and frontend doc payloads
  don't include it).
- **`socket/server.ts`** — `io.use()` auth middleware (handshake), the
  `connection` handler that registers the socket in the apiKey map,
  sends `round:state` snapshot, and wires per-socket handlers.
- **`socket/handlers.ts`** — `bet:place` and `bet:cashout` handlers:
  zod-validate payload, call `engine.placeBet(...)` / `engine.cashout(...)`.
- **`repos/`** — Three repositories: `playerRepo`, `roundRepo`, `betRepo`.
  Each accepts an optional `client` argument so they can participate in
  a transaction passed by the engine. SQL is hand-written (mirrors mines).
- **`routes/`** — Three thin REST handlers (balance, history, recent
  rounds), plus health and docs.
- **`middleware/apiKey.ts`** — Reads `X-API-Key`, calls
  `playerRepo.ensureExists`, attaches `req.apiKey`. 401 on missing/empty.
- **`middleware/errors.ts`** — `AppError` class + Express error handler
  (mirrors mines).

### 3.2 Single source of truth for balance

Balance is mutated only inside `repos/playerRepo` (`debit` and `credit`),
always within a `withTransaction(...)` block that also writes the
corresponding bet row. The engine never touches balance arithmetic
directly. Engine events that include `balance` (`bet:placed`,
`bet:cashedOut`, `bet:lost`) carry the value returned by the repo at the
moment of the transaction commit. This guarantees there is no balance
drift between memory and DB.

### 3.3 Recovery after restart

When the process boots:

1. Connect to Postgres, query `MAX(rounds.id)` to continue the round
   counter.
2. Mark any orphaned bets — `UPDATE bets SET status='lost', settled_at=now()
   WHERE status='placed'` — to ensure no `placed` rows leak across restarts.
   This is honest: the round was interrupted, neither winnings nor refunds
   are owed.
3. Wire broadcast adapter and socket handlers.
4. Call `engine.start()` which immediately enters `waiting`.

Frontends that were mid-round receive a fresh `round:state` on reconnect
with a new `roundId` and `yourBet: null`.

## 4. Data Model

```sql
-- migrations/001_init.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS players (
    api_key      TEXT PRIMARY KEY,
    balance      NUMERIC(12, 2) NOT NULL DEFAULT 10000.00,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

**Notes:**

- Public `roundId` is `'round_' + rounds.id` to match the doc's example
  format.
- `rounds.seed` is stored for internal audit (one can verify
  `crashPoint` is deterministic from `seed`); never returned in any
  payload.
- Money columns are `NUMERIC`, never `FLOAT`.
- The unique index `bets_one_per_round_per_player` is the database-level
  enforcement of "one bet per player per round". A `23505` from this
  index becomes `bet:rejected` with `reason: 'already_has_bet'`.
- `CHECK (amount > 0)` is a cheap defense-in-depth guard.

## 5. Game Engine

### 5.1 In-memory state

```ts
type Phase = 'waiting' | 'running' | 'crashed';

interface ActiveBet {
  betId: string;             // UUID
  apiKey: string;
  amount: number;
  autoCashOutAt: number | null;
  placedAt: Date;
}

interface EngineState {
  phase: Phase;
  roundId: number;            // BIGSERIAL from rounds.id
  startedAt: Date | null;     // running start
  endsAt: Date | null;        // waiting deadline
  multiplier: number;
  crashPoint: number | null;  // set on round start, never broadcast until crash
  seed: string;               // hex
  bets: Map<string /* apiKey */, ActiveBet>;
}
```

The `Map<apiKey, ActiveBet>` keyed by apiKey makes "one bet per player
per round" structurally impossible to violate at the engine level. The DB
unique index is the second guard.

### 5.2 Multiplier formula (Conservative preset)

```ts
function computeMultiplier(elapsedMs: number): number {
  const t = elapsedMs / 1000;
  const m = Math.exp(0.06 * t);
  // Floor (not round) so the displayed value never exceeds the true value —
  // a player must never cash out at a multiplier the server hasn't reached.
  return Math.floor(m * 100) / 100;
}
```

Growth factor `0.06` produces: 1.00× at 0s, 1.35× at 5s, 1.82× at 10s,
6.05× at 30s. Mean round duration ~16s with mean crashPoint ~2.7×.

### 5.3 Crash distribution

```ts
import { randomBytes } from 'node:crypto';

function generateCrash(seed: string): number {
  const u = parseInt(seed.slice(0, 13), 16) / Math.pow(2, 52);
  if (u < 0.01) return 1.00;                 // 1% house edge: instant crash
  const crash = 0.99 / (1 - u);
  return Math.floor(crash * 100) / 100;
}

const seed = randomBytes(32).toString('hex');
```

Classic Bustabit-style heavy-tail distribution. Roughly 1/3 of rounds
crash below 1.5×, 1/3 between 1.5–3×, 1/3 above 3×, with rare 10×+
outliers. EV for the player = `1 - 0.01 = 0.99`.

### 5.4 Phase loop

```ts
class Engine extends EventEmitter {
  // toWaiting → setTimeout(10_000) → toRunning
  //   - clear bets, set endsAt = now + 10s
  //   - emit 'phase:waiting' { roundId: nextId, endsAt, playerCount: 0 }
  //
  // toRunning →
  //   - generate seed + crashPoint, KEEP IN MEMORY (do NOT broadcast)
  //   - INSERT INTO rounds (status='running', started_at, seed) → assign roundId
  //   - emit 'phase:running' { roundId, startedAt, playerCount }
  //   - setInterval(200ms, tick)
  //
  // tick →
  //   - elapsed = now - startedAt
  //   - m = computeMultiplier(elapsed)
  //   - state.multiplier = m
  //   - if (m >= crashPoint) → toCrashed()  ← crash check FIRST
  //   - else for each bet with autoCashOutAt && m >= autoCashOutAt:
  //       settleCashout(bet, bet.autoCashOutAt)  ← settle on TARGET, not actual m
  //   - emit 'tick' { roundId, multiplier: m, elapsedMs: elapsed }
  //
  // toCrashed →
  //   - clearInterval(tickInterval)
  //   - state.multiplier = crashPoint
  //   - betRepo.settleAllLost(roundId)        ← inside transaction
  //   - roundRepo.markCrashed(roundId, cp)
  //   - emit 'phase:crashed' { roundId, crashPoint, playerCount }
  //   - for each remaining bet: emit 'bet:lost' { apiKey, betId, crashPoint, balance }
  //   - setTimeout(5_000) → toWaiting()
}
```

### 5.5 Place bet

```ts
async placeBet(apiKey, amount, autoCashOutAt) {
  // sync guards (no DB)
  if (state.phase !== 'waiting')   return emit('bet:rejected', { apiKey, reason: 'betting_closed' });
  if (state.bets.has(apiKey))      return emit('bet:rejected', { apiKey, reason: 'already_has_bet' });
  if (autoCashOutAt && autoCashOutAt < 1.01)
                                   return emit('bet:rejected', { apiKey, reason: 'invalid_auto_cashout' });

  // DB transaction: SELECT FOR UPDATE balance → debit → INSERT bet
  try {
    const { balance, betId } = await withTransaction(async (c) => {
      const bal = await playerRepo.debit(c, apiKey, amount);   // throws on insufficient
      const bet = await betRepo.insertPlaced(c, state.roundId, apiKey, amount, autoCashOutAt);
      return { balance: bal, betId: bet.id };
    });
    // re-check phase: waiting may have closed during the transaction
    if (state.phase !== 'waiting') {
      // compensating transaction: refund balance and delete the bet row
      await withTransaction(async (c) => {
        await betRepo.deleteById(c, betId);
        await playerRepo.credit(c, apiKey, amount);
      });
      return emit('bet:rejected', { apiKey, reason: 'betting_closed' });
    }
    state.bets.set(apiKey, { betId, apiKey, amount, autoCashOutAt, placedAt: new Date() });
    emit('bet:placed', { apiKey, betId, roundId, amount, autoCashOutAt, balance });
  } catch (err) {
    if (err.code === 'INSUFFICIENT') return emit('bet:rejected', { apiKey, reason: 'insufficient_balance' });
    throw err;
  }
}
```

### 5.6 Cashout

```ts
async cashout(apiKey) {
  const bet = state.bets.get(apiKey);
  if (!bet)                         return emit('bet:rejected', { apiKey, reason: 'no_active_bet' });
  if (state.phase !== 'running')    return emit('bet:rejected', { apiKey, reason: 'not_running' });
  await settleCashout(bet, state.multiplier);   // current snapshot
}

async settleCashout(bet, atMultiplier) {
  state.bets.delete(bet.apiKey);    // remove FIRST so the next tick doesn't re-process
  const winAmount = round2(bet.amount * atMultiplier);
  const profit    = round2(winAmount - bet.amount);
  const balance   = await withTransaction(async (c) => {
    await betRepo.markCashedOut(c, bet.betId, atMultiplier, winAmount);
    return playerRepo.credit(c, bet.apiKey, winAmount);
  });
  emit('bet:cashedOut', { apiKey: bet.apiKey, betId: bet.betId, multiplier: atMultiplier, winAmount, profit, balance });
}
```

### 5.7 Race-condition rules

| Scenario | Behavior |
|---|---|
| Player taps Cash Out at the moment of crash | `tick()` checks `m >= crashPoint` first and transitions sync. If `cashout()` runs before the tick, it settles. If after, `phase === 'crashed'` and the player gets `bet:rejected reason: 'not_running'`; the `bet:lost` event has already been broadcast. |
| Auto-cashout vs crash on the same tick | Crash wins. Auto-cashout target was hit, but so was crashPoint — house priority. |
| Auto-cashout settles on `target`, not on tick's actual `m` | `settleCashout(bet, bet.autoCashOutAt)` — guarantees the player gets exactly what they ordered. |
| Place bet during `[waiting closes ... toRunning starts]` micro-window | Re-check `state.phase` after the transaction; if not `waiting`, refund and emit `bet:rejected reason: 'betting_closed'`. |
| Disconnect during running with active bet | Engine doesn't know about sockets. Bet remains in `state.bets`, continues to participate in auto-cashout/crash. On reconnect, frontend gets fresh `round:state`. |
| Invalid `amount` (NaN, negative, > max) | Caught by zod at the socket handler before reaching engine. Engine trusts `amount > 0`. |

## 6. API Contract

### 6.1 Authentication

All access requires `X-API-Key` (REST) or `socket.handshake.auth.apiKey`
(WS). Any non-empty string is valid; first sighting auto-creates a
player with starting balance 10,000. Empty/missing → 401 (REST) or
`connect_error('UNAUTHORIZED')` (WS).

### 6.2 WebSocket — Server → Client

| Event | When | Audience | Payload |
|---|---|---|---|
| `round:state` | On `connection` (incl. reconnect) | This socket only | `{ phase, roundId, startedAt?, endsAt?, currentMultiplier, crashPoint?, yourBet?, playerCount }` |
| `round:waiting` | Transition into waiting | Broadcast | `{ roundId, endsAt, playerCount: 0 }` |
| `round:start` | Transition into running | Broadcast | `{ roundId, startedAt, playerCount }` |
| `round:tick` | Every 200ms during running | Broadcast | `{ roundId, multiplier, elapsedMs }` |
| `round:crash` | Transition into crashed | Broadcast | `{ roundId, crashPoint, playerCount }` |
| `bet:placed` | After successful `placeBet` | Player only | `{ betId, roundId, amount, autoCashOutAt, balance }` |
| `bet:cashedOut` | Manual or auto cashout settled | Player only | `{ betId, multiplier, winAmount, profit, balance }` |
| `bet:lost` | Player did not exit before crash | Player only | `{ betId, crashPoint, balance }` |
| `bet:rejected` | Invalid `bet:place` / `bet:cashout` | Player only | `{ reason, message }` |

`playerCount` is included in waiting/start/crash but not in tick (would
be noise at 5 Hz).

### 6.3 WebSocket — Client → Server

| Event | Payload | Validation |
|---|---|---|
| `bet:place` | `{ amount: number, autoCashOutAt?: number \| null }` | `z.object({ amount: z.number().positive().max(10_000), autoCashOutAt: z.number().min(1.01).nullable().optional() })` |
| `bet:cashout` | `{}` | none |

Schema fail → `socket.emit('bet:rejected', { reason: 'invalid_payload', message })`.

### 6.4 REST endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | Liveness (no auth) |
| `GET` | `/api/docs` | Swagger UI (no auth) |
| `GET` | `/api/balance` | `{ balance: number }` |
| `GET` | `/api/history?limit=20` | `{ bets: [{ betId, roundId, amount, autoCashOutAt, status, multiplier, winAmount, profit, placedAt, settledAt }] }` |
| `GET` | `/api/rounds/recent?limit=20` | `{ rounds: [{ roundId, crashPoint, crashedAt }] }` |

`/api/balance` is for initial app load only; subsequent updates flow
from WS events. `/api/history` and `/api/rounds/recent` are React-Query
sources invalidated by the frontend on relevant WS events.

### 6.5 Documentation (Swagger)

- `openapi.yaml` at the repo root describes all REST endpoints and
  shared schemas (Bet, Round, Player, Error, plus all WS event payload
  schemas under `components.schemas` for cross-reference).
- A `## WebSocket events` section in `info.description` lists all events
  with payload examples — not interactive, but rendered cleanly by
  Swagger UI as the single canonical contract reference.
- `/api/docs` serves Swagger UI via `swagger-ui-express` (mirrors
  mines-backend setup).

## 7. Project Layout

```
crash-backend/
├── README.md
├── package.json
├── tsconfig.json
├── openapi.yaml
├── Dockerfile
├── .env.example                  # PORT, DATABASE_URL, ALLOWED_ORIGIN
├── migrations/
│   └── 001_init.sql
├── scripts/
│   └── migrate.ts
└── src/
    ├── server.ts                 # entrypoint
    ├── app.ts                    # express setup, middleware, routes
    ├── db.ts                     # pg pool + withTransaction
    ├── types.ts                  # Phase, ActiveBet, all payload types
    ├── engine/
    │   ├── engine.ts
    │   ├── multiplier.ts
    │   └── engine.test.ts
    ├── socket/
    │   ├── server.ts
    │   ├── handlers.ts
    │   └── broadcast.ts
    ├── repos/
    │   ├── playerRepo.ts
    │   ├── roundRepo.ts
    │   └── betRepo.ts
    ├── routes/
    │   ├── balance.ts
    │   ├── history.ts
    │   ├── recent.ts
    │   └── docs.ts
    ├── middleware/
    │   ├── apiKey.ts
    │   └── errors.ts
    └── domain/
        └── schemas.ts
```

**Boundary rule:** `engine/` may import from `repos/`, `domain/`, and
`types.ts` only. It must not import from `socket/` or `routes/`.
`broadcast.ts` is the single bridge between engine events and `io.emit`.

## 8. Entrypoint & Wiring

```ts
// src/server.ts
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import { createApp } from './app.js';
import { Engine } from './engine/engine.js';
import { registerSocketHandlers } from './socket/server.js';
import { wireBroadcast } from './socket/broadcast.js';

const app = createApp();
const httpServer = http.createServer(app);
const io = new IOServer(httpServer, {
  cors: { origin: process.env.ALLOWED_ORIGIN ?? '*' },
});

const engine = new Engine();
wireBroadcast(engine, io);          // engine emits → io.emit
registerSocketHandlers(io, engine); // socket → engine.placeBet/cashout
await engine.start();               // start LAST, after listeners are wired

httpServer.listen(Number(process.env.PORT ?? 3000));
```

Engine starts last to guarantee no early emitted event is dropped before
the broadcast adapter is subscribed.

## 9. Deployment

**Recommended target: Fly.io.** Free tier sustains one always-on
machine, native WebSocket support without extra config, `fly launch`
deploys directly from the Dockerfile, and `fly postgres` provides a
managed Postgres. Render is an equivalent fallback.

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
CMD ["node", "--import", "tsx", "src/server.ts"]
```

Migrations run as a release step (`fly ssh console -C "npm run migrate"`
or a Fly release_command).

## 10. Testing Strategy

| Layer | Type | What we verify |
|---|---|---|
| `engine/multiplier.ts` | Pure unit | `computeMultiplier` is monotonic and matches expected values; `generateCrash(seed)` is deterministic; 1% near-instant edge case fires. |
| `engine/engine.ts` | Unit with mocked repo + injected fake clock | Sequence of emitted events for a full `waiting → running → crashed` cycle; `placeBet` during running rejected; auto-cashout settles on target; tick at `m≥crashPoint` transitions to crashed; transaction failure rolls back state. |
| `repos/*` | Integration with test DB | Unique index enforces one bet per round; `debit` throws on insufficient. |
| `socket/handlers.ts` | Unit with mocked engine | Zod validation; payload mapping. |
| End-to-end smoke | `socket.io-client` script | Connect two clients, both place bets, one cashes out, verify event sequence. |

Engine accepts a `clock?: () => number` constructor argument defaulting
to `Date.now`. Tests inject a fake clock and call `tick()` directly,
avoiding `setTimeout`/`setInterval` flakiness.

## 11. Out of Scope

- Provably-fair commit-reveal scheme.
- Rate limiting, request quotas.
- JWT, refresh tokens, registration.
- Multi-instance horizontal scaling (would require Redis pub/sub for
  shared state — separate project).
- Replay logs beyond `rounds.seed`.
- Admin endpoints, player profiles, avatars.
