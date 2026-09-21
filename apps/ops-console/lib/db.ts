/**
 * The console reads through the same door as the pipeline: the app role, inside a transaction that
 * sets app.tenant_id. Row-level security does the isolation; the console has no WHERE tenant_id
 * anywhere and could not read another tenant's rows if it tried.
 */
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";

for (const file of [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../../.env")]) {
  dotenv.config({ path: file, quiet: true });
}

let pool: pg.Pool | undefined;

export function appPool(): pg.Pool {
  const url = process.env.APP_DATABASE_URL;
  if (!url) throw new Error("APP_DATABASE_URL is not set (copy .env.example to .env at the repo root)");
  pool ??= new pg.Pool({ connectionString: url, max: 4 });
  return pool;
}

export type Tx = pg.PoolClient;

export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^[a-z0-9_-]+$/.test(tenantId)) throw new Error(`refusing to open a tenant context for "${tenantId}"`);
  const client = await appPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface Tenant { id: string; display_name: string; currency: string }

/** The registry has no tenant data and no policy: it is the one table readable without a context. */
export async function listTenants(): Promise<Tenant[]> {
  const r = await appPool().query<Tenant>("SELECT id, display_name, currency FROM ops.tenants ORDER BY id");
  return r.rows;
}
