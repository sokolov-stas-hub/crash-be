export type RoundTier = 'low' | 'mid' | 'high';

export function computeTier(crashPoint: number): RoundTier {
  if (crashPoint < 1.5) return 'low';
  if (crashPoint < 3.0) return 'mid';
  return 'high';
}
