export function computeMultiplier(elapsedMs: number): number {
  const t = elapsedMs / 1000;
  const m = Math.exp(0.06 * t);
  // Round DOWN to 2 decimals so the displayed value never exceeds the true value.
  return Math.floor(m * 100) / 100;
}

export function generateCrash(seed: string): number {
  // Take the first 13 hex characters → 52 bits → uniform in [0, 1)
  const u = parseInt(seed.slice(0, 13), 16) / Math.pow(2, 52);
  if (u < 0.01) return 1.0;          // 1% house edge: instant crash
  const crash = 0.99 / (1 - u);
  return Math.floor(crash * 100) / 100;
}
