import { z } from 'zod';

export const betPlaceSchema = z.object({
  amount: z.number().positive().max(10_000),
  autoCashOutAt: z.number().min(1.01).nullable().optional(),
});

export const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type BetPlaceInput = z.infer<typeof betPlaceSchema>;
