import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

const dir = join(process.cwd(), 'migrations');
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8');
  console.log(`Running ${file}...`);
  await pool.query(sql);
}

console.log('Migrations done.');
await pool.end();
