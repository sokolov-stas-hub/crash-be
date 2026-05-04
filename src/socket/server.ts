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
    const yourBetStatus: 'placed' | 'cashedOut' | 'lost' =
      state.phase === 'crashed' ? 'lost' : 'placed';
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
