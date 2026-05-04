import type { Socket } from 'socket.io';
import { Engine } from '../engine/engine.js';
import { betPlaceSchema } from '../domain/schemas.js';

export function registerHandlers(socket: Socket, engine: Engine): void {
  const apiKey = socket.data.apiKey as string;

  socket.on('bet:place', async (raw, ack?: (res: unknown) => void) => {
    try {
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
    } catch (err) {
      console.error('bet:place handler error', err);
      socket.emit('bet:rejected', { reason: 'invalid_payload', message: 'Internal error processing bet' });
      ack?.({ ok: false });
    }
  });

  socket.on('bet:cashout', async (_raw, ack?: (res: unknown) => void) => {
    try {
      await engine.cashout(apiKey);
      ack?.({ ok: true });
    } catch (err) {
      console.error('bet:cashout handler error', err);
      socket.emit('bet:rejected', { reason: 'invalid_payload', message: 'Internal error processing cashout' });
      ack?.({ ok: false });
    }
  });
}
