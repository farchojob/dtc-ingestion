/**
 * Test database: a separate database (dtc_test) on the same Postgres, migrated from scratch once per
 * test file, truncated between tests. Everything below runs as the admin role; the code under test
 * runs as app_rw through withTenant(), exactly as in production.
 */
import pg from 'pg';
import { loadConfig } from '../src/config.ts';   // loads .env first
import { adminPool, closePools } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';

const TEST_DB = 'dtc_test';

function withDatabase(url: string, db: string): string {
  return url.replace(/\/[^/?]+(\?.*)?$/, `/${db}$1`);
}

export async function prepareTestDatabase(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  const appUrl = process.env.APP_DATABASE_URL;
  if (!adminUrl || !appUrl) throw new Error('DATABASE_URL and APP_DATABASE_URL must be set (copy .env.example to .env)');
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (!exists.rowCount) await c.query(`CREATE DATABASE ${TEST_DB}`);
  await c.end();
  process.env.DATABASE_URL = withDatabase(adminUrl, TEST_DB);
  process.env.APP_DATABASE_URL = withDatabase(appUrl, TEST_DB);
  await closePools();
  await adminPool().query('DROP SCHEMA IF EXISTS raw, stg, mart, ops CASCADE');
  await migrate();
}

export async function resetData(): Promise<void> {
  await adminPool().query(
    `TRUNCATE raw.records, raw.file_loads, stg.orders, stg.email_events, stg.ad_spend, stg.refunds,
             mart.daily_revenue, mart.daily_email, ops.runs, ops.expected_deliveries, ops.quarantine,
             ops.schema_events, ops.conflicts, ops.dirty_days, ops.restatements, ops.tenants
     RESTART IDENTITY CASCADE`);
}

/** Row counts and sums that must be identical between a clean run and a crashed-then-resumed run. */
export async function snapshot(tenantId: string): Promise<Record<string, string>> {
  const r = await adminPool().query<{ k: string; v: string }>(
    `SELECT 'raw_records' AS k, count(*)::text AS v FROM raw.records WHERE tenant_id = $1
     UNION ALL SELECT 'orders', count(*)::text FROM stg.orders WHERE tenant_id = $1
     UNION ALL SELECT 'orders_gross', sum(gross)::text FROM stg.orders WHERE tenant_id = $1
     UNION ALL SELECT 'email_events', count(*)::text FROM stg.email_events WHERE tenant_id = $1
     UNION ALL SELECT 'ad_spend', count(*)::text FROM stg.ad_spend WHERE tenant_id = $1
     UNION ALL SELECT 'refunds', count(*)::text FROM stg.refunds WHERE tenant_id = $1
     UNION ALL SELECT 'mart_net', sum(net)::text FROM mart.daily_revenue WHERE tenant_id = $1
     UNION ALL SELECT 'mart_rows', count(*)::text FROM mart.daily_revenue WHERE tenant_id = $1
     UNION ALL SELECT 'email_rows', count(*)::text FROM mart.daily_email WHERE tenant_id = $1`, [tenantId]);
  return Object.fromEntries(r.rows.map((x) => [x.k, x.v]));
}

export async function adminQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await adminPool().query<T>(sql, params)).rows;
}

export { loadConfig };
