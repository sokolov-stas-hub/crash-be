import type { Request, Response, NextFunction } from 'express';
import * as playerRepo from '../repos/playerRepo.js';
import { AppError } from './errors.js';

declare global {
  namespace Express {
    interface Request {
      apiKey: string;
    }
  }
}

export async function apiKeyMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const key = req.header('X-API-Key');
    if (!key || key.trim().length === 0) {
      throw new AppError(401, 'X-API-Key header is required');
    }
    await playerRepo.ensureExists(key);
    req.apiKey = key;
    next();
  } catch (err) {
    next(err);
  }
}
