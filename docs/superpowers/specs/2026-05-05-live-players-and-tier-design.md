# Live Players + Round Tier — Design

> Adds a Live Players panel feed to the WebSocket contract, classifies
> recent rounds into a color-coded `tier`, and removes `/api/history`.
> Builds on the spec at
> `docs/superpowers/specs/2026-05-03-crash-backend-design.md`.

## 1. Goals & Non-Goals

**Goals:**

- Frontend can render a Live Players panel showing every participant in
  the current round with their bet, status (placed / cashed_out / lost),
  and cashout multiplier when applicable.
- Recent crashed rounds carry a server-computed `tier` so frontends do
  not reinvent the color classification rules.
- Drop the unused `/api/history` endpoint and all its supporting code.

**Non-Goals:**

- Display names separate from the API key (the key is the public
  username — students pick something readable).
- Per-player avatars, profile pictures, scoring, leaderboards.
- Persisting `tier` in the database (it is derived at read time).
- Any DB schema migration.

## 2. Public Types

Add to `src/types.ts`:

```ts
// Recent round color/tier classification.
//   low:  crashPoint < 1.5    (red)
//   mid:  1.5 <= crashPoint < 3   (orange)
//   high: crashPoint >= 3   (green)
export type RoundTier = 'low' | 'mid' | 'high';

// Public per-player info safe to broadcast.
// NO balance, NO betId, NO profit (private fields stay in player-targeted events).
export interface PublicPlayer {
  username: string;       // === apiKey
  amount: number;
  status: 'placed' | 'cashed_out' | 'lost';
  multiplier: number | null;  // only set when status === 'cashed_out'
}
```

Existing `RecentRound` type gains a `tier` field. `RoundStateEvent`,
`RoundStartEvent`, `RoundWaitingEvent`, `RoundCrashEvent` each lose
`playerCount` and gain `players: PublicPlayer[]`. `RoundCrashEvent` also
gains `tier: RoundTier`. `HistoryBet` and `HistoryResponse` are removed.

## 3. WebSocket Contract Changes

### 3.1 Existing events (modified)

```ts
// round:state — sent on connect/reconnect to ONE socket
{
  phase, roundId, startedAt, endsAt, currentMultiplier, crashPoint,
  yourBet,                              // unchanged
  players: PublicPlayer[]               // NEW (replaces playerCount)
}

// round:waiting — broadcast at waiting start
{
  roundId, endsAt,
  players: []                           // NEW: always empty (new round, list reset)
}

// round:start — broadcast at running start
{
  roundId, startedAt,
  players: PublicPlayer[]               // NEW: snapshot of bets at round start
}

// round:tick — UNCHANGED (no players field — too noisy at 5 Hz)

// round:crash — broadcast at crash
{
  roundId, crashPoint,
  tier: RoundTier,                      // NEW
  players: PublicPlayer[]               // NEW: final snapshot (cashed_out + lost mix)
}
```

### 3.2 Player-targeted events (unchanged)

`bet:placed`, `bet:cashedOut`, `bet:lost`, `bet:rejected` keep their
existing payloads with `balance` and `betId`. These remain private,
delivered only to the bet owner's sockets.

### 3.3 New public events (broadcast to all)

```ts
// players:bet — broadcast when ANY player places bet (during waiting)
{ username: string, amount: number }

// players:cashout — broadcast when ANY player cashes out (manual or auto)
{ username: string, multiplier: number, winAmount: number }

// players:lost — broadcast when ANY player loses (at crash)
{ username: string, amount: number }
```

These are emitted IN ADDITION to the corresponding private events. The
broadcast adapter (`socket/broadcast.ts`) is responsible for the
dual-emit; the engine emits a single internal event per business action
and the adapter routes it to one or both audiences.

**What's intentionally excluded from public payloads:**
- `autoCashOutAt` — a player's strategy is private. Other players
  shouldn't see what target they pre-set.
- `balance`, `betId`, `profit` — financial details stay in the
  player-targeted events.
- `status` field — implied by the event name (`players:cashout` →
  `cashed_out`, `players:lost` → `lost`); no need to repeat.

### 3.4 Event ordering on crash

1. Engine emits `phase:crashed` → broadcast adapter emits `round:crash`
   (with final `players` snapshot and `tier`).
2. For each remaining placed bet, engine emits `bet:lost` → broadcast
   adapter emits BOTH:
   - private `bet:lost` to the bet owner (with `balance`, `betId`),
   - public `players:lost` to all sockets (with `username`, `amount`).

Snapshot first, diff events second. Frontend can either re-render from
the snapshot or apply diffs over an existing list — the snapshot is the
source of truth on reconnect.

**Auto-cashout ordering during `tick()`:** when an auto-cashout fires
mid-tick, the wire order is `players:cashout` → `round:tick` (because
the engine processes auto-cashouts before emitting the tick). Manual
cashouts go through their own async path and may interleave with ticks
arbitrarily. Frontends MUST tolerate `players:cashout` arriving outside
strict tick alignment.

## 4. REST Contract Changes

### 4.1 `GET /api/rounds/recent` — response gains `tier`

```json
{
  "rounds": [
    {
      "roundId": "round_24",
      "crashPoint": 1.20,
      "crashedAt": "2026-05-04T07:35:22Z",
      "tier": "low"
    }
  ]
}
```

`tier` is computed by `computeTier(crashPoint)` (see §5). It is NOT
stored in the database.

### 4.2 `GET /api/history` — removed

Endpoint, route file, app wiring, and all supporting code go away. See
§7 for the full removal checklist.

## 5. Tier Classification

```ts
// src/domain/tier.ts — pure function, no I/O
export function computeTier(crashPoint: number): RoundTier {
  if (crashPoint < 1.5) return 'low';
  if (crashPoint < 3.0) return 'mid';
  return 'high';
}
```

Used by:
- `roundRepo.listRecent` to populate `RecentRound.tier`,
- `engine.beginCrash` (or wherever the `round:crash` payload is built)
  to populate `RoundCrashEvent.tier`.

Tested with 5 boundary cases: 0.99 → low, 1.49 → low, 1.50 → mid, 2.99
→ mid, 3.00 → high, 100.00 → high.

## 6. Engine Changes

### 6.1 New in-memory state field

```ts
interface EngineState {
  // existing fields ...
  publicPlayers: Map<string /* apiKey */, PublicPlayer>;  // NEW
}
```

The `bets` map already holds active bets (cleared on
`advanceToWaiting`). `publicPlayers` is parallel: it tracks the public
view including cashed-out players (whose entries are removed from
`bets` but should still appear in the panel). Single-responsibility:
`bets` controls game logic (auto-cashout iteration), `publicPlayers`
serves snapshot rendering.

### 6.2 State transitions

- `advanceToWaiting` → `publicPlayers.clear()`.
- `placeBet` success → `publicPlayers.set(apiKey, {username: apiKey,
  amount, status: 'placed', multiplier: null})` AND emit
  `players:bet` (alongside existing `bet:placed`).
- `settleCashout` (manual or auto) → `publicPlayers.set(bet.apiKey,
  {...existing, status: 'cashed_out', multiplier: atMultiplier})` AND
  emit `players:cashout` (alongside existing `bet:cashedOut`).
- `beginCrash` → for each remaining bet,
  `publicPlayers.set(bet.apiKey, {...existing, status: 'lost'})` AND
  emit `players:lost` (alongside existing `bet:lost`).

### 6.3 Snapshot building

```ts
// in round:state, round:start, round:crash payloads:
players: [...this.state.publicPlayers.values()]
```

Iteration order of a `Map` is insertion order, which matches the order
players joined the round — sensible for the panel.

## 7. Removal Checklist for `/api/history`

| File | Change |
|---|---|
| `src/routes/history.ts` | DELETE |
| `src/app.ts` | Remove `historyRouter` import + `app.use('/api', historyRouter)` |
| `src/repos/betRepo.ts` | DELETE `listForPlayer` function and its `BetRow` interface |
| `src/repos/repos.test.ts` | DELETE the `listForPlayer` test block |
| `src/types.ts` | DELETE `HistoryBet` and `HistoryResponse` interfaces |
| `openapi.yaml` | DELETE `/api/history` path and `History`/`HistoryBet` schemas |
| `README.md` | DELETE the `/api/history` row from the endpoints table |
| `docs/api-reference.html` | DELETE section 1.3 (history endpoint block) |

## 8. Documentation Updates

- `openapi.yaml`: drop history paths/schemas; add `tier` to RecentRound
  schema; add `PublicPlayer` and `RoundTier` schemas; document new
  `players:bet`/`players:cashout`/`players:lost` WS events; remove
  `playerCount` references.
- `README.md`: remove `/api/history` row.
- `docs/api-reference.html`: remove history section; add `tier` to
  `/api/rounds/recent` example; replace `playerCount` with `players` in
  the four affected WS events; add three new WS event blocks for
  `players:bet`/`players:cashout`/`players:lost`; refresh the cheat
  sheet.

## 9. Test Strategy

- `src/domain/tier.test.ts` (NEW): boundary cases for `computeTier`.
- `src/engine/engine.test.ts`: add cases for
  - `players:bet` emitted on successful `placeBet`,
  - `players:cashout` emitted on `settleCashout` (both manual and auto),
  - `players:lost` emitted for each remaining bet on `beginCrash`,
  - `publicPlayers` snapshot reflects placed → cashed_out → lost
    transitions correctly,
  - `publicPlayers` cleared on `advanceToWaiting`.
- `src/repos/repos.test.ts`:
  - DELETE `listForPlayer` block,
  - UPDATE `listRecent` test to assert `tier` field is computed
    correctly for boundary cases.
- `scripts/smoke.ts`: add a second spectator client that connects but
  does not bet; verify it receives `round:state.players`,
  `players:bet` when the betting client bets, and `players:cashout`
  on cashout.

## 10. Out of Scope

- Display name separate from apiKey (auth model already says "any
  non-empty string is the user's identifier").
- Avatars, colors, profile metadata.
- Player history across rounds (different feature, different spec).
- Lifetime stats (total wagered, win rate, etc.).
- Persisting `tier` or `publicPlayers` snapshots in the database.
