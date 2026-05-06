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
