# Crash Backend

Real-time Crash game backend for the Week 4 frontend homework.
Multi-tenant via the `X-API-Key` header (any non-empty string is a
valid identifier; first sighting auto-creates a player with starting
balance 10,000). Server is the source of truth for phase, multiplier,
and bet outcomes.

## Stack

TypeScript · Express · Socket.IO · Postgres (`pg`) · zod · Vitest ·
`swagger-ui-express`. Single long-running Node process — not serverless.

## Endpoints

| | Path | Notes |
|---|---|---|
| GET | `/api/health` | Liveness (no auth) |
| GET | `/api/docs` | Swagger UI (no auth) |
| GET | `/api/balance` | Current balance |
| GET | `/api/history?limit=20` | Player's bet history |
| GET | `/api/rounds/recent?limit=20` | Last N crash points |

WebSocket: `socket.io-client` with `auth: { apiKey: '<your-key>' }`.
Full event reference at `/api/docs` → "WebSocket events" section.

## Local development

```bash
npm install
cp .env.example .env.local
# edit DATABASE_URL to point at a local Postgres
npm run migrate
npm run dev
# → http://localhost:3000
# → http://localhost:3000/api/docs
```

## Tests

```bash
npm test
```

Repo tests run against the database at `DATABASE_URL` and TRUNCATE
between cases — do NOT point this at production.

## Deployment

```bash
fly launch          # follow prompts; uses the included Dockerfile
fly postgres create # provision a managed Postgres
fly ssh console -C "npm run migrate"
fly deploy
```

## Spec & plan

- `docs/superpowers/specs/2026-05-03-crash-backend-design.md`
- `docs/superpowers/plans/2026-05-03-crash-backend.md`
