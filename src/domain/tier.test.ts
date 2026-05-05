import { describe, it, expect } from 'vitest';
import { computeTier } from './tier.js';

describe('computeTier', () => {
  it('classifies crashPoint < 1.5 as low', () => {
    expect(computeTier(1.0)).toBe('low');
    expect(computeTier(1.49)).toBe('low');
  });

  it('classifies 1.5 <= crashPoint < 3.0 as mid', () => {
    expect(computeTier(1.5)).toBe('mid');
    expect(computeTier(2.0)).toBe('mid');
    expect(computeTier(2.99)).toBe('mid');
  });

  it('classifies crashPoint >= 3.0 as high', () => {
    expect(computeTier(3.0)).toBe('high');
    expect(computeTier(10.24)).toBe('high');
    expect(computeTier(100.0)).toBe('high');
  });

  it('handles edge of house-edge (instant crash)', () => {
    expect(computeTier(1.0)).toBe('low');
  });
});
