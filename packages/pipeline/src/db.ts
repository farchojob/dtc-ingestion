/**
 * Database access. Two pools:
 *  - admin (DATABASE_URL): migrations and the tenant registry. Superuser in the docker image.
 *  - app (APP_DATABASE_URL): every read and write of tenant data, as a role that cannot bypass
 *    row-level security.
 *
 * withTenant() is the only way the pipeline and the console touch tenant data. It opens a
 * transaction, sets app.tenant_id for that transaction, runs the callback, and commits. A query
 * outside it sees no rows, and an insert for another tenant is rejected by the policy's WITH CHECK.
 */
import pg from 'pg';

let admin: pg.Pool | undefined;
let app: pg.Pool | undefined;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (copy .env.example to .env)`);
  return v;
}

export function adminPool(): pg.Pool {
  admin ??= new pg.Pool({ connectionString: need('DATABASE_URL'), max: 4 });
  return admin;
}

export function appPool(): pg.Pool {
  app ??= new pg.Pool({ connectionString: need('APP_DATABASE_URL'), max: 8 });
  return app;
}

export type Tx = pg.PoolClient;

export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^[a-z0-9_-]+$/.test(tenantId)) throw new Error(`refusing to open a tenant context for "${tenantId}"`);
  const client = await appPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Admin-only work: migrations, tenant registration, and the cross-tenant delivery check. */
export async function withAdmin<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await adminPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.all([admin?.end(), app?.end()]);
  admin = undefined;
  app = undefined;
}
