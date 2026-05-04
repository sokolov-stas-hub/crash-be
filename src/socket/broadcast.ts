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
