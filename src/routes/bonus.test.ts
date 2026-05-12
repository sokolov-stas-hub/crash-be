import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createApp } from '../app.js';

const mocks = vi.hoisted(() => ({
  ensureExists: vi.fn(),
  claimBonus: vi.fn(),
}));

vi.mock('../repos/playerRepo.js', () => ({
  ensureExists: mocks.ensureExists,
}));

vi.mock('../repos/bonusRepo.js', () => ({
  claimBonus: mocks.claimBonus,
}));

let server: Server;
let baseUrl: string;

async function postClaim(apiKey: string) {
  return fetch(`${baseUrl}/api/bonus/claim`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey },
  });
}

beforeAll(async () => {
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  mocks.ensureExists.mockResolvedValue(undefined);
  mocks.claimBonus.mockReset();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
});

describe('POST /api/bonus/claim', () => {
  it('credits 100 coins and returns the updated balance plus next claim time', async () => {
    mocks.claimBonus.mockResolvedValue({
      claimed: true,
      amount: 100,
      balance: 10_100,
      claimedAt: new Date('2026-05-12T10:00:00.000Z'),
      nextClaimAt: new Date('2026-05-12T10:10:00.000Z'),
      retryAfterMs: 0,
    });

    const response = await postClaim('bonus-alice');

    expect(response.status).toBe(200);
    expect(mocks.claimBonus).toHaveBeenCalledWith('bonus-alice');
    const body = await response.json();
    expect(body).toMatchObject({
      claimed: true,
      amount: 100,
      balance: 10_100,
    });
    expect(typeof body.claimedAt).toBe('string');
    expect(typeof body.nextClaimAt).toBe('string');
    expect(new Date(body.nextClaimAt).getTime() - new Date(body.claimedAt).getTime()).toBe(10 * 60 * 1000);
  });

  it('rejects a second claim during the 10 minute cooldown', async () => {
    mocks.claimBonus.mockResolvedValue({
      claimed: false,
      amount: 100,
      balance: 10_100,
      claimedAt: new Date('2026-05-12T10:00:00.000Z'),
      nextClaimAt: new Date('2026-05-12T10:10:00.000Z'),
      retryAfterMs: 123_000,
    });

    const response = await postClaim('bonus-bob');

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body).toMatchObject({
      error: 'Bonus is on cooldown',
      claimed: false,
      amount: 100,
      balance: 10_100,
    });
    expect(typeof body.nextClaimAt).toBe('string');
    expect(body.retryAfterMs).toBe(123_000);
  });
});
