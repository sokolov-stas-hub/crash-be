import { Router } from 'express';
import * as playerRepo from '../repos/playerRepo.js';
import type { BalanceResponse } from '../types.js';

export const balanceRouter = Router();

balanceRouter.get('/balance', async (req, res, next) => {
  try {
    const balance = await playerRepo.getBalance(req.apiKey);
    const response: BalanceResponse = { balance };
    res.json(response);
  } catch (err) { next(err); }
});
