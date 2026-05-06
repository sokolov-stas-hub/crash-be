import type { Server } from 'socket.io';
import { Engine } from '../engine/engine.js';
import type { PublicPlayer } from '../types.js';
import { buildSocketPlayersSnapshot } from './players.js';
import { sockets } from './server.js';

const broadcastEvents = ['round:waiting', 'round:start', 'round:tick', 'round:crash'] as const;
const playerEvents = ['bet:placed', 'bet:cashedOut', 'bet:lost', 'bet:rejected'] as const;
const publicEvents = ['players:bet', 'players:cashout', 'players:lost'] as const;

const engineEventMap: Record<string, string> = {
  'phase:waiting': 'round:waiting',
  'phase:running': 'round:start',
  'phase:crashed': 'round:crash',
  'tick': 'round:tick',
};

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

export function wireBroadcast(engine: Engine, io: Server): void {
  // Phase / tick events → broadcast (existing)
  for (const engineName of Object.keys(engineEventMap)) {
    engine.on(engineName, (payload) => {
      const publicPayload = engineName === 'tick' ? payload : mergePlayersForPhasePayload(payload);
      io.emit(engineEventMap[engineName], publicPayload);
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
