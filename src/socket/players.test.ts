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
