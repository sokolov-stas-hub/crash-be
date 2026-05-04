import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const path = issue.path.join('.');
    return res.status(400).json({ error: path ? `${path}: ${issue.message}` : issue.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
}
