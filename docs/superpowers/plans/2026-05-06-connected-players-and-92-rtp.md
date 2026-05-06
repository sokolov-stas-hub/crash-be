# Connected Players And 92% RTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Socket snapshot events show every currently connected authenticated player, and crash generation targets about 92% RTP.

**Architecture:** Keep bet and round state in `Engine`; keep live socket presence in the socket layer. Add a pure socket helper that merges connected `apiKey`s with engine `PublicPlayer` round participants, then use it in `round:state` and broadcast phase events. Lower RTP by changing only `generateCrash`; leave multiplier display growth and settlement math unchanged.

**Tech Stack:** TypeScript, Node.js, Socket.IO, Vitest, existing Express/Postgres backend.

---

## File Map

- Modify: `src/types.ts`
  - Add `watching` to `PublicPlayer.status`.
- Create: `src/socket/players.ts`
  - Pure helper for building the socket-facing `players` snapshot.
- Create: `src/socket/players.test.ts`
  - Unit coverage for spectators, bettor overlay, duplicate tabs, empty socket sets, and disconnected bettors.
- Modify: `src/socket/server.ts`
  - Use the helper for the one-client `round:state` snapshot.
- Modify: `src/socket/broadcast.ts`
  - Use the helper before broadcasting `round:waiting`, `round:start`, and `round:crash`.
- Modify: `src/engine/multiplier.ts`
  - Change crash generation from ~99% RTP to ~92% RTP.
- Modify: `src/engine/multiplier.test.ts`
  - Update instant-crash and distribution tests for the 92% RTP formula.
- Modify: `src/engine/engine.test.ts`
  - Add a focused assertion that engine `publicPlayers` still does not track passive watchers.
- Modify: `scripts/smoke.ts`
  - Verify initial and phase snapshots include a connected spectator with `watching`.
- Modify: `README.md`, `openapi.yaml`, `docs/api-reference.html`
  - Document `watching`, connected-player snapshots, and 92% RTP.

---

### Task 1: Add Pure Connected-Players Snapshot Helper

**Files:**
- Modify: `src/types.ts`
- Create: `src/socket/players.ts`
- Create: `src/socket/players.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `src/socket/players.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PublicPlayer } from '../types.js';
import { buildSocketPlayersSnapshot } from './players.js';

describe('buildSocketPlayersSnapshot', () => {
  it('includes connected players with no bet as watching', () => {
    const connected = new Map<string, Set<string>>([
      ['alice', new Set(['socket-1'])],
      ['bob', new Set(['socket-2'])],
    ]);

    expect(buildSocketPlayersSnapshot(connected, [])).toEqual([
      { username: 'alice', amount: 0, status: 'watching', multiplier: null },
      { username: 'bob', amount: 0, status: 'watching', multiplier: null },
    ]);
  });

  it('overlays round participant state over watching state', () => {
    const connected = new Map<string, Set<string>>([
      ['alice', new Set(['socket-1'])],
      ['bob', new Set(['socket-2'])],
    ]);
    const roundPlayers: PublicPlayer[] = [
      { username: 'alice', amount: 100, status: 'placed', multiplier: null },
    ];

    expect(buildSocketPlayersSnapshot(connected, roundPlayers)).toEqual([
      { username: 'alice', amount: 100, status: 'placed', multiplier: null },
      { username: 'bob', amount: 0, status: 'watching', multiplier: null },
    ]);
  });

  it('deduplicates multiple sockets for the same apiKey', () => {
    const connected = new Map<string, Set<string>>([
      ['alice', new Set(['socket-1', 'socket-2'])],
    ]);

    expect(buildSocketPlayersSnapshot(connected, [])).toEqual([
      { username: 'alice', amount: 0, status: 'watching', multiplier: null },
    ]);
  });

  it('ignores connected entries with no active socket ids', () => {
    const connected = new Map<string, Set<string>>([
      ['alice', new Set()],
      ['bob', new Set(['socket-2'])],
    ]);

    expect(buildSocketPlayersSnapshot(connected, [])).toEqual([
      { username: 'bob', amount: 0, status: 'watching', multiplier: null },
    ]);
  });

  it('keeps disconnected bettors from the engine round snapshot', () => {
    const connected = new Map<string, Set<string>>([
      ['spectator', new Set(['socket-1'])],
    ]);
    const roundPlayers: PublicPlayer[] = [
      { username: 'alice', amount: 100, status: 'lost', multiplier: null },
    ];

    expect(buildSocketPlayersSnapshot(connected, roundPlayers)).toEqual([
      { username: 'spectator', amount: 0, status: 'watching', multiplier: null },
      { username: 'alice', amount: 100, status: 'lost', multiplier: null },
    ]);
  });
});
```

- [ ] **Step 2: Run the helper test to verify it fails**

Run:

```bash
npm test -- src/socket/players.test.ts
```

Expected: FAIL because `src/socket/players.ts` does not exist and `PublicPlayer.status` does not allow `watching`.

- [ ] **Step 3: Update `PublicPlayer` type**

In `src/types.ts`, replace the `PublicPlayer` interface with:

```ts
export interface PublicPlayer {
  username: string;       // === apiKey
  amount: number;
  status: 'watching' | 'placed' | 'cashed_out' | 'lost';
  multiplier: number | null;  // only set when status === 'cashed_out'
}
```

- [ ] **Step 4: Add the helper implementation**

Create `src/socket/players.ts`:

```ts
import type { PublicPlayer } from '../types.js';

type ConnectedSockets = ReadonlyMap<string, ReadonlySet<string>>;

export function buildSocketPlayersSnapshot(
  connectedSockets: ConnectedSockets,
  roundPlayers: Iterable<PublicPlayer>,
): PublicPlayer[] {
  const players = new Map<string, PublicPlayer>();

  for (const [apiKey, socketIds] of connectedSockets) {
    if (socketIds.size === 0) continue;
    players.set(apiKey, {
      username: apiKey,
      amount: 0,
      status: 'watching',
      multiplier: null,
    });
  }

  for (const player of roundPlayers) {
    players.set(player.username, player);
  }

  return [...players.values()];
}
```

- [ ] **Step 5: Run helper test to verify it passes**

Run:

```bash
npm test -- src/socket/players.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit helper changes**

Run:

```bash
git add src/types.ts src/socket/players.ts src/socket/players.test.ts
git commit -m "feat(socket): build connected players snapshots"
```

---

### Task 2: Use Merged Players In Socket Snapshots

**Files:**
- Modify: `src/socket/server.ts`
- Modify: `src/socket/broadcast.ts`

- [ ] **Step 1: Update `round:state` snapshot construction**

In `src/socket/server.ts`, add the import:

```ts
import { buildSocketPlayersSnapshot } from './players.js';
```

Then replace the `players` assignment in the `snapshot` object:

```ts
players: buildSocketPlayersSnapshot(sockets, state.publicPlayers.values()),
```

The resulting snapshot block should look like:

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
  players: buildSocketPlayersSnapshot(sockets, state.publicPlayers.values()),
};
```

- [ ] **Step 2: Update phase broadcast payloads**

In `src/socket/broadcast.ts`, add imports:

```ts
import type { PublicPlayer } from '../types.js';
import { buildSocketPlayersSnapshot } from './players.js';
```

Add this helper above `wireBroadcast`:

```ts
function mergePlayersForPhasePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || !('players' in payload)) {
    return payload;
  }

  const phasePayload = payload as Record<string, unknown> & { players: PublicPlayer[] };
  return {
    ...phasePayload,
    players: buildSocketPlayersSnapshot(sockets, phasePayload.players),
  };
}
```

Replace the phase/tick listener loop with:

```ts
for (const engineName of Object.keys(engineEventMap)) {
  engine.on(engineName, (payload) => {
    const publicPayload = engineName === 'tick' ? payload : mergePlayersForPhasePayload(payload);
    io.emit(engineEventMap[engineName], publicPayload);
  });
}
```

- [ ] **Step 3: Run socket helper and typecheck**

Run:

```bash
npm test -- src/socket/players.test.ts
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 4: Commit socket wiring**

Run:

```bash
git add src/socket/server.ts src/socket/broadcast.ts
git commit -m "feat(socket): include connected watchers in snapshots"
```

---

### Task 3: Lower Crash Generation To 92% RTP

**Files:**
- Modify: `src/engine/multiplier.ts`
- Modify: `src/engine/multiplier.test.ts`

- [ ] **Step 1: Update multiplier tests first**

In `src/engine/multiplier.test.ts`, add this helper inside the `describe('generateCrash', ...)` block, before the tests:

```ts
const seedFrom52BitValue = (value: bigint): string =>
  value.toString(16).padStart(13, '0').padEnd(64, '0');
```

Replace the instant-crash test with:

```ts
it('returns 1.00 for the bottom 8% of the seed space (92% RTP)', () => {
  const fivePercentThroughSeedSpace = (1n << 52n) / 20n;
  const seed = seedFrom52BitValue(fivePercentThroughSeedSpace);
  expect(generateCrash(seed)).toBe(1.0);
});
```

Add this formula test after it:

```ts
it('uses the 0.92 RTP factor in the general-formula branch', () => {
  const halfwayThroughSeedSpace = 1n << 51n; // u = 0.5
  const seed = seedFrom52BitValue(halfwayThroughSeedSpace);
  expect(generateCrash(seed)).toBe(1.84);
});
```

Replace the high-distribution sanity assertion with:

```ts
// With 92% RTP, P(crash >= 3.0) is about 0.92 / 3 = 30.7%.
expect(high).toBeGreaterThan(120);
expect(high).toBeLessThan(450);
```

- [ ] **Step 2: Run multiplier tests to verify they fail**

Run:

```bash
npm test -- src/engine/multiplier.test.ts
```

Expected: FAIL because `generateCrash(seedFrom52BitValue(1n << 51n))` still returns `1.98`.

- [ ] **Step 3: Update crash generation implementation**

Replace `generateCrash` in `src/engine/multiplier.ts` with:

```ts
export function generateCrash(seed: string): number {
  // Take the first 13 hex characters → 52 bits → uniform in [0, 1)
  const u = parseInt(seed.slice(0, 13), 16) / Math.pow(2, 52);
  const rtp = 0.92;
  if (u < 1 - rtp) return 1.0;
  const crash = rtp / (1 - u);
  return Math.floor(crash * 100) / 100;
}
```

- [ ] **Step 4: Run multiplier tests to verify they pass**

Run:

```bash
npm test -- src/engine/multiplier.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run engine tests for settlement regression coverage**

Run:

```bash
npm test -- src/engine/engine.test.ts
```

Expected: PASS. Existing pinned crash point tests should not change because they use `__setCrashPointForTest`.

- [ ] **Step 6: Commit RTP change**

Run:

```bash
git add src/engine/multiplier.ts src/engine/multiplier.test.ts
git commit -m "feat(engine): lower crash rtp to 92 percent"
```

---

### Task 4: Add Engine Boundary Assertion

**Files:**
- Modify: `src/engine/engine.test.ts`

- [ ] **Step 1: Add a test proving watchers stay outside engine state**

Add this test near the existing `publicPlayers` tests in `src/engine/engine.test.ts`:

```ts
it('engine publicPlayers only tracks current-round bet participants', async () => {
  await engine.placeBet('alice', 100, null);

  expect(engine.getState().publicPlayers.has('alice')).toBe(true);
  expect(engine.getState().publicPlayers.has('bob')).toBe(false);
  expect([...engine.getState().publicPlayers.values()]).toEqual([
    { username: 'alice', amount: 100, status: 'placed', multiplier: null },
  ]);
});
```

- [ ] **Step 2: Run engine tests**

Run:

```bash
npm test -- src/engine/engine.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit engine boundary test**

Run:

```bash
git add src/engine/engine.test.ts
git commit -m "test(engine): document public players boundary"
```

---

### Task 5: Extend Smoke Script For Connected Watchers

**Files:**
- Modify: `scripts/smoke.ts`

- [ ] **Step 1: Capture `round:state` from `connect`**

Replace the `connect` helper in `scripts/smoke.ts` with:

```ts
type ConnectedClient = {
  socket: Socket;
  state: {
    players?: Array<{ username: string; status: string; amount: number; multiplier: number | null }>;
  };
};

function connect(apiKey: string): Promise<ConnectedClient> {
  return new Promise((resolve, reject) => {
    const s = ioClient(url, { auth: { apiKey } });
    s.once('round:state', (state) => resolve({ socket: s, state }));
    s.once('connect_error', reject);
  });
}
```

Then replace the three client assignments:

```ts
const aliceClient = await connect('smoke-alice');
const bobClient = await connect('smoke-bob');
const alice = aliceClient.socket;
const bob = bobClient.socket;
console.log('connected: alice + bob');

const spectatorClient = await connect('smoke-spectator-' + Date.now());
const spectator = spectatorClient.socket;
console.log('spectator connected');
```

- [ ] **Step 2: Assert spectator sees itself as watching in initial state**

After `console.log('spectator connected');`, add:

```ts
const spectatorSelf = spectatorClient.state.players?.find(
  p => p.username.startsWith('smoke-spectator-'),
);
if (!spectatorSelf || spectatorSelf.status !== 'watching' || spectatorSelf.amount !== 0) {
  console.error('SMOKE FAIL: spectator round:state did not include spectator as watching');
  console.error('spectator round:state players:', spectatorClient.state.players);
  process.exit(1);
}
console.log('spectator saw itself as watching in round:state');
```

- [ ] **Step 3: Assert `round:start` includes spectator as watching**

Replace the current `round:start` wait:

```ts
await new Promise<void>(r => alice.once('round:start', () => r()));
console.log('round:start received');
```

with:

```ts
const startPayload = await new Promise<{
  players?: Array<{ username: string; status: string; amount: number; multiplier: number | null }>;
}>(r => alice.once('round:start', r));
console.log('round:start received');

const spectatorAtStart = startPayload.players?.find(
  p => p.username === spectatorSelf.username,
);
if (!spectatorAtStart || spectatorAtStart.status !== 'watching' || spectatorAtStart.amount !== 0) {
  console.error('SMOKE FAIL: round:start did not include spectator as watching');
  console.error('round:start players:', startPayload.players);
  process.exit(1);
}
console.log('round:start included spectator as watching');
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit smoke update**

Run:

```bash
git add scripts/smoke.ts
git commit -m "test(smoke): verify connected watcher snapshots"
```

---

### Task 6: Update Public Documentation

**Files:**
- Modify: `README.md`
- Modify: `openapi.yaml`
- Modify: `docs/api-reference.html`

- [ ] **Step 1: Update README WebSocket text**

In `README.md`, find the WebSocket event table and update the player snapshot description so it says:

```md
`players` arrays contain `PublicPlayer` objects for all currently connected
authenticated players. Players without a current-round bet use
`status: 'watching'`, `amount: 0`, and `multiplier: null`.
```

Add this RTP line near the game description:

```md
Crash generation targets roughly 92% RTP using the same heavy-tail crash shape.
```

- [ ] **Step 2: Update OpenAPI WebSocket notes**

In `openapi.yaml`, update the WebSocket description block to include:

```yaml
    `players` arrays contain all currently connected authenticated users plus
    current-round bettor outcomes. Connected users without a bet appear as
    `{ username, amount: 0, status: 'watching', multiplier: null }`.
    Crash generation targets roughly 92% RTP.
```

Also update any `PublicPlayer` schema or inline type text so `status` includes:

```yaml
enum: [watching, placed, cashed_out, lost]
```

- [ ] **Step 3: Update HTML API reference**

In `docs/api-reference.html`, update the `PublicPlayer` display block so the status union is:

```html
<span class="k">status</span>: <span class="str">'watching'</span> | <span class="str">'placed'</span> | <span class="str">'cashed_out'</span> | <span class="str">'lost'</span>;
```

Add this explanatory paragraph near the `PublicPlayer` or socket snapshot section:

```html
<p><code>players</code> arrays include all currently connected authenticated users. Users without a bet in the current round appear with <code>status: 'watching'</code>, <code>amount: 0</code>, and <code>multiplier: null</code>.</p>
```

Add this RTP sentence near the crash description:

```html
<p>Crash generation targets roughly 92% RTP while keeping the same heavy-tail multiplier shape.</p>
```

- [ ] **Step 4: Search docs for stale RTP/status text**

Run:

```bash
rg -n "99%|0\\.99|1% house|placed' \\| 'cashed_out|placed, cashed_out|players: \\[\\]" README.md openapi.yaml docs/api-reference.html
```

Expected: no stale public-doc references claiming 99% RTP or a three-status-only `PublicPlayer`. `players: []` may remain only if the docs explicitly explain that engine internals reset the round participant list, not client socket snapshots.

- [ ] **Step 5: Commit documentation**

Run:

```bash
git add README.md openapi.yaml docs/api-reference.html
git commit -m "docs: describe connected watchers and 92 rtp"
```

---

### Task 7: Final Verification

**Files:**
- Read-only verification across the repo.

- [ ] **Step 1: Run unit tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run smoke script if local database environment is available**

Run:

```bash
node --env-file=.env.local --import tsx scripts/smoke.ts
```

Expected output includes:

```text
spectator saw itself as watching in round:state
round:start included spectator as watching
spectator saw public events ✓
smoke complete
```

If `.env.local` or Postgres is not available, record that smoke verification was blocked by missing local runtime dependencies and include the exact error in the final implementation summary.

- [ ] **Step 4: Confirm no stale references**

Run:

```bash
rg -n "0\\.99|1% house edge|99% RTP|status: 'placed' \\| 'cashed_out' \\| 'lost'" src README.md openapi.yaml docs/api-reference.html
```

Expected: no stale source or current-public-doc references.

- [ ] **Step 5: Review final diff**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: clean worktree after commits, with the task commits visible at the top.
