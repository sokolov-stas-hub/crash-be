import { Router } from 'express';
import * as betRepo from '../repos/betRepo.js';
import { limitQuerySchema } from '../domain/schemas.js';
import type { HistoryResponse } from '../types.js';

export const historyRouter = Router();

historyRouter.get('/history', async (req, res, next) => {
  try {
    const { limit } = limitQuerySchema.parse(req.query);
    const rows = await betRepo.listForPlayer(req.apiKey, limit);
    // Strip apiKey from the response — the client knows its own key.
    const bets = rows.map(({ apiKey, ...rest }) => rest);
    const response: HistoryResponse = { bets };
    res.json(response);
  } catch (err) { next(err); }
});
