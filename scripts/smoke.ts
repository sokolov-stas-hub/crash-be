import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { Engine } from '../src/engine/engine.js';
import { registerSocketHandlers } from '../src/socket/server.js';
import { wireBroadcast } from '../src/socket/broadcast.js';
import * as playerRepo from '../src/repos/playerRepo.js';
import * as roundRepo from '../src/repos/roundRepo.js';
import * as betRepo from '../src/repos/betRepo.js';
import { pool, withTransaction } from '../src/db.js';

const app = createApp();
const server = http.createServer(app);
const io = new IOServer(server);

const engine = new Engine({ playerRepo, roundRepo, betRepo, withTransaction });
wireBroadcast(engine, io);
registerSocketHandlers(io, engine);
await engine.start();

await new Promise<void>(resolve => server.listen(0, resolve));
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const url = `http://localhost:${port}`;
console.log(`smoke server on ${url}`);

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

const aliceClient = await connect('smoke-alice');
const bobClient = await connect('smoke-bob');
const alice = aliceClient.socket;
const bob = bobClient.socket;
console.log('connected: alice + bob');

// Spectator: connects but doesn't bet — should still see public players:* events
const spectatorClient = await connect('smoke-spectator-' + Date.now());
const spectator = spectatorClient.socket;
console.log('spectator connected');

const spectatorSelf = spectatorClient.state.players?.find(
  p => p.username.startsWith('smoke-spectator-'),
);
if (!spectatorSelf || spectatorSelf.status !== 'watching' || spectatorSelf.amount !== 0) {
  console.error('SMOKE FAIL: spectator round:state did not include spectator as watching');
  console.error('spectator round:state players:', spectatorClient.state.players);
  process.exit(1);
}
console.log('spectator saw itself as watching in round:state');

const spectatorEvents: Array<{ name: string; payload: unknown }> = [];
for (const evt of ['players:bet', 'players:cashout', 'players:lost', 'round:crash']) {
  spectator.on(evt, (p) => spectatorEvents.push({ name: evt, payload: p }));
}

// Wait for a fresh waiting phase
await new Promise<void>(resolve => alice.once('round:waiting', () => resolve()));
console.log('round:waiting received');

alice.emit('bet:place', { amount: 100, autoCashOutAt: null });
bob.emit('bet:place',   { amount: 200, autoCashOutAt: 1.5 });

const alicePlaced = await new Promise<unknown>(r => alice.once('bet:placed', r));
const bobPlaced = await new Promise<unknown>(r => bob.once('bet:placed', r));
console.log('bet:placed alice =', alicePlaced);
console.log('bet:placed bob =', bobPlaced);

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

// Alice cashes out manually after 1 second of running
setTimeout(() => alice.emit('bet:cashout', {}), 1000);

const aliceResult = await Promise.race([
  new Promise(r => alice.once('bet:cashedOut', e => r({ kind: 'cashed', e }))),
  new Promise(r => alice.once('bet:lost',      e => r({ kind: 'lost',   e }))),
]);
console.log('alice result:', aliceResult);

const bobResult = await Promise.race([
  new Promise(r => bob.once('bet:cashedOut', e => r({ kind: 'cashed', e }))),
  new Promise(r => bob.once('bet:lost',      e => r({ kind: 'lost',   e }))),
]);
console.log('bob result:', bobResult);

// Wait briefly for the spectator to capture events
await new Promise(r => setTimeout(r, 500));
console.log('spectator captured events:');
for (const e of spectatorEvents) {
  console.log(`  ${e.name}:`, e.payload);
}
const sawCashoutOrLost = spectatorEvents.some(e => e.name === 'players:cashout' || e.name === 'players:lost');
if (!sawCashoutOrLost) {
  console.error('SMOKE FAIL: spectator did not see any players:cashout or players:lost event');
  process.exit(1);
}
console.log('spectator saw public events ✓');
spectator.close();

alice.close();
bob.close();
io.close();
server.close();
await pool.end();
console.log('smoke complete');
process.exit(0);
