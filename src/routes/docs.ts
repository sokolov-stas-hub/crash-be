import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import swaggerUi from 'swagger-ui-express';

const spec = parse(readFileSync(join(process.cwd(), 'openapi.yaml'), 'utf8'));

export const docsRouter = Router();
docsRouter.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
docsRouter.get('/openapi.json', (_req, res) => res.json(spec));
