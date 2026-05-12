import { Router } from 'express';
import * as bonusRepo from '../repos/bonusRepo.js';
import type { BonusClaimResponse } from '../types.js';

export const bonusRouter = Router();

bonusRouter.post('/bonus/claim', async (req, res, next) => {
  try {
    const claim = await bonusRepo.claimBonus(req.apiKey);
    const response: BonusClaimResponse = {
      claimed: claim.claimed,
      amount: claim.amount,
      balance: claim.balance,
      claimedAt: claim.claimedAt.toISOString(),
      nextClaimAt: claim.nextClaimAt.toISOString(),
      retryAfterMs: claim.retryAfterMs,
    };

    if (!claim.claimed) {
      return res.status(429).json({
        error: 'Bonus is on cooldown',
        ...response,
      });
    }

    return res.json(response);
  } catch (err) { next(err); }
});
