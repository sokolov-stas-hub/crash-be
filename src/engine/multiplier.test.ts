import { describe, it, expect } from 'vitest';
import { computeMultiplier, generateCrash } from './multiplier.js';

describe('computeMultiplier', () => {
  it('returns 1.00 at t=0', () => {
    expect(computeMultiplier(0)).toBe(1.0);
  });

  it('grows monotonically', () => {
    expect(computeMultiplier(1000)).toBeGreaterThan(computeMultiplier(0));
    expect(computeMultiplier(5000)).toBeGreaterThan(computeMultiplier(1000));
    expect(computeMultiplier(30_000)).toBeGreaterThan(computeMultiplier(5000));
  });

  it('matches expected floored values for the Conservative preset', () => {
    // exp(0.06 * 5)  ≈ 1.3499 → floor → 1.34
    // exp(0.06 * 10) ≈ 1.8221 → floor → 1.82
    // exp(0.06 * 30) ≈ 6.0496 → floor → 6.04
    expect(computeMultiplier(5000)).toBe(1.34);
    expect(computeMultiplier(10_000)).toBe(1.82);
    expect(computeMultiplier(30_000)).toBe(6.04);
  });

  it('rounds down to 2 decimals', () => {
    const m = computeMultiplier(1234);
    expect(Number.isInteger(m * 100)).toBe(true);
  });
});

describe('generateCrash', () => {
  const seedFrom52BitValue = (value: bigint): string =>
    value.toString(16).padStart(13, '0').padEnd(64, '0');

  it('is deterministic for a given seed', () => {
    const seed = 'a'.repeat(64);
    expect(generateCrash(seed)).toBe(generateCrash(seed));
  });

  it('returns 1.00 for the bottom 8% of the seed space (92% RTP)', () => {
    const fivePercentThroughSeedSpace = (1n << 52n) / 20n;
    const seed = seedFrom52BitValue(fivePercentThroughSeedSpace);
    expect(generateCrash(seed)).toBe(1.0);
  });

  it('uses the 0.92 RTP factor in the general-formula branch', () => {
    const halfwayThroughSeedSpace = 1n << 51n; // u = 0.5
    const seed = seedFrom52BitValue(halfwayThroughSeedSpace);
    expect(generateCrash(seed)).toBe(1.84);
  });

  it('returns >= 1.00 for varied seeds covering the general-formula branch', () => {
    // Use the LCG mixer from the heavy-tail test so seeds spread across the
    // 52-bit u-space, exercising the general RTP/(1-u) branch (not just the
    // u<0.01 house-edge early return).
    for (let i = 0; i < 200; i++) {
      const val = (BigInt(i + 1) * 99991n * 6364136223846793005n) % (1n << 52n);
      const seed = val.toString(16).padStart(13, '0').padEnd(64, '0');
      expect(generateCrash(seed)).toBeGreaterThanOrEqual(1.0);
    }
  });

  it('produces a heavy-tail distribution (sanity check)', () => {
    let high = 0;
    for (let i = 0; i < 1000; i++) {
      // pseudo-random seed per iteration: map i into the full 52-bit seed space
      // using an LCG hash so significant bits appear in the first 13 hex chars
      // (generateCrash reads the first 13 hex chars, so seeds must vary there).
      const val = (BigInt(i) * 99991n * 6364136223846793005n) % (1n << 52n);
      const seed = val.toString(16).padStart(13, '0').padEnd(64, '0');
      if (generateCrash(seed) >= 3.0) high++;
    }
    // With 92% RTP, P(crash >= 3.0) is about 0.92 / 3 = 30.7%.
    expect(high).toBeGreaterThan(120);
    expect(high).toBeLessThan(450);
  });
});
