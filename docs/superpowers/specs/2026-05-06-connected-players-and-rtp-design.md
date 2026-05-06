# Connected Players And 92% RTP Design

## Summary

Two backend behavior changes are needed:

1. Socket snapshot events must display all currently connected authenticated
   players, not only players who placed a bet in the current round.
2. Crash generation should target roughly 92% RTP instead of the current
   roughly 99% RTP.

The game engine remains the source of truth for round phase, bets, cashouts,
losses, and crash generation. Socket presence stays in the socket layer, where
it already lives today.

## Connected Player Snapshots

`PublicPlayer.status` gains a fourth public status:

```ts
type PublicPlayerStatus = 'watching' | 'placed' | 'cashed_out' | 'lost';
```

Connected authenticated users that have not placed a bet in the current round
appear as:

```ts
{
  username: apiKey,
  amount: 0,
  status: 'watching',
  multiplier: null
}
```

Players who did place a bet keep their existing bet lifecycle status:

- `placed` while their bet is active.
- `cashed_out` after manual or automatic cashout.
- `lost` after crash if they did not cash out.

## Snapshot Construction

The engine keeps its current `publicPlayers` map as round participant state.
That map contains only players with current-round bet activity.

The socket layer already tracks connected users in:

```ts
Map<string /* apiKey */, Set<string /* socket.id */>>
```

Socket-facing snapshot payloads should be built by merging those two sources:

1. Start with every connected `apiKey` as a `watching` `PublicPlayer`.
2. Overlay every engine `publicPlayers` entry by `username`.
3. Return the merged values as the event `players` array.

This ensures connected spectators appear in snapshots, while bettors still show
their real round outcome. If a player has multiple tabs, they appear once.

The merge belongs in the socket layer:

- `socket/server.ts` uses it for the one-client `round:state` snapshot.
- `socket/broadcast.ts` uses it before broadcasting phase events as
  `round:waiting`, `round:start`, and `round:crash`.

The engine continues to emit its own `publicPlayers` snapshot without knowing
which sockets are connected.

## Affected Events

These events include the merged all-connected player list:

- `round:state`
- `round:waiting`
- `round:start`
- `round:crash`

These existing public action events remain bet-lifecycle events and are not
emitted for passive spectators:

- `players:bet`
- `players:cashout`
- `players:lost`

## Disconnect Behavior

When a user disconnects and has no remaining sockets, they should disappear
from future all-connected snapshots. If that user placed a bet, the engine
still owns and settles the bet exactly as today.

For `round:crash`, disconnected bettors should still appear in the final
players snapshot because the snapshot overlays engine `publicPlayers` entries
onto connected watchers. This preserves final round result visibility.

## 92% RTP Crash Generation

The current crash formula is effectively a 99% RTP heavy-tail distribution:

```ts
if (u < 0.01) return 1.0;
return floor2(0.99 / (1 - u));
```

Change it to roughly 92% RTP:

```ts
const RTP = 0.92;
if (u < 1 - RTP) return 1.0;
return floor2(RTP / (1 - u));
```

This preserves the same distribution shape while lowering survival probability
at every target multiplier. Examples:

- Survival at `2x` becomes about `46%`.
- Survival at `10x` becomes about `9.2%`.
- Instant crash becomes about `8%`.

`computeMultiplier` display growth should not change. Only `generateCrash`
changes.

## Documentation

Update public docs to mention:

- `PublicPlayer.status` may be `watching`.
- `players` arrays include all currently connected authenticated players plus
  current-round bettor outcomes.
- Crash generation targets about 92% RTP.

## Testing

Add or update tests for:

- `PublicPlayer` supports `watching`.
- Socket snapshot merging includes connected non-bettors.
- Multiple sockets for one `apiKey` appear once.
- A disconnected bettor still appears in the `round:crash` final snapshot.
- `generateCrash` has an 8% instant-crash branch and uses the `0.92` factor.
- Distribution sanity bounds are adjusted for the lower RTP.

## Non-Goals

- Do not persist live connected-player snapshots in the database.
- Do not broadcast `players:bet`/`players:cashout`/`players:lost` for passive
  watchers.
- Do not change balance math, cashout settlement, or multiplier display speed.
