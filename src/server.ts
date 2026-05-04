import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import { createApp } from './app.js';
import { Engine } from './engine/engine.js';
import { registerSocketHandlers } from './socket/server.js';
import { wireBroadcast } from './socket/broadcast.js';
import * as playerRepo from './repos/playerRepo.js';
import * as roundRepo from './repos/roundRepo.js';
import * as betRepo from './repos/betRepo.js';
import { withTransaction } from './db.js';

const app = createApp();
const httpServer = http.createServer(app);
const io = new IOServer(httpServer, {
  cors: { origin: process.env.ALLOWED_ORIGIN ?? '*' },
});

const engine = new Engine(
  { playerRepo, roundRepo, betRepo, withTransaction },
);

wireBroadcast(engine, io);
registerSocketHandlers(io, engine);
await engine.start();

const port = Number(process.env.PORT ?? 3000);
httpServer.listen(port, () => {
  console.log(`Crash backend listening on http://localhost:${port}`);
  console.log(`Docs at http://localhost:${port}/api/docs`);
});
