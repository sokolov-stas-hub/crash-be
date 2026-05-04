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

function connect(apiKey: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(url, { auth: { apiKey } });
    s.once('round:state', () => resolve(s));
    s.once('connect_error', reject);
  });
}

const alice = await connect('smoke-alice');
const bob = await connect('smoke-bob');
console.log('connected: alice + bob');

// Wait for a fresh waiting phase
await new Promise<void>(resolve => alice.once('round:waiting', () => resolve()));
console.log('round:waiting received');

alice.emit('bet:place', { amount: 100, autoCashOutAt: null });
bob.emit('bet:place',   { amount: 200, autoCashOutAt: 1.5 });

const alicePlaced = await new Promise<unknown>(r => alice.once('bet:placed', r));
const bobPlaced = await new Promise<unknown>(r => bob.once('bet:placed', r));
console.log('bet:placed alice =', alicePlaced);
console.log('bet:placed bob =', bobPlaced);

await new Promise<void>(r => alice.once('round:start', () => r()));
console.log('round:start received');

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

alice.close();
bob.close();
io.close();
server.close();
await pool.end();
console.log('smoke complete');
process.exit(0);
