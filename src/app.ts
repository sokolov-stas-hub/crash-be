import express from 'express';
import cors from 'cors';
import { errorHandler } from './middleware/errors.js';
import { apiKeyMiddleware } from './middleware/apiKey.js';
import { balanceRouter } from './routes/balance.js';
import { recentRouter } from './routes/recent.js';
import { docsRouter } from './routes/docs.js';

export function createApp() {
  const app = express();
  app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? '*' }));
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Public docs (must be before apiKeyMiddleware)
  app.use('/api', docsRouter);

  // Auth-required routes
  app.use('/api', apiKeyMiddleware);
  app.use('/api', balanceRouter);
  app.use('/api', recentRouter);

  app.use(errorHandler);
  return app;
}
