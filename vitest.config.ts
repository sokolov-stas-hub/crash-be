import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Vitest doesn't auto-populate process.env from .env.local — load it manually
  // so repo integration tests (which need DATABASE_URL) can connect to Postgres.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return {
    test: {
      globals: true,
      environment: 'node',
      testTimeout: 10_000,
    },
  };
});
