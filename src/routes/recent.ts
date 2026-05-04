import { Router } from 'express';
import * as roundRepo from '../repos/roundRepo.js';
import { limitQuerySchema } from '../domain/schemas.js';
import type { RecentRoundsResponse } from '../types.js';

export const recentRouter = Router();

recentRouter.get('/rounds/recent', async (req, res, next) => {
  try {
    const { limit } = limitQuerySchema.parse(req.query);
    const rounds = await roundRepo.listRecent(limit);
    const response: RecentRoundsResponse = { rounds };
    res.json(response);
  } catch (err) { next(err); }
});
