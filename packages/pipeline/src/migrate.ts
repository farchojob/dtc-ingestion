/** Applies migrations/*.sql in name order, once each, recorded in ops.migrations. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminPool } from './db.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(): Promise<{ applied: string[]; skipped: string[] }> {
  const client = await adminPool().connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS ops');
    await client.query('CREATE TABLE IF NOT EXISTS ops.migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ id: string }>('SELECT id FROM ops.migrations')).rows.map((r) => r.id));
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) { skipped.push(file); continue; }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO ops.migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    client.release();
  }
  return { applied, skipped };
}
