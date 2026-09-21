/** A run: one tenant, one invocation. Registers the tenant and its expectations, then tracks stats. */
import fs from 'node:fs';
import path from 'node:path';
import { withTenant } from './db.ts';
import { tenantConfigHash, type Config, type TenantSpec } from './config.ts';

export interface RunCtx {
  config: Config;
  tenant: TenantSpec;
  runId: number;
}

interface ManifestEntry { tenant: string; source: string; batch: number; path: string; covers_from: string; covers_to: string }

/** Upsert the tenant row and load the manifest entries for this tenant into ops.expected_deliveries. */
export async function registerTenant(config: Config, tenant: TenantSpec): Promise<{ expected: number }> {
  return withTenant(tenant.id, async (tx) => {
    await tx.query(
      `INSERT INTO ops.tenants (id, display_name, currency, config_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, currency = EXCLUDED.currency, config_hash = EXCLUDED.config_hash`,
      [tenant.id, tenant.display_name, tenant.currency, tenantConfigHash(tenant)],
    );
    let expected = 0;
    if (tenant.expected_deliveries) {
      const file = path.resolve(config.fixturesDir, tenant.expected_deliveries.manifest);
      const entries = (JSON.parse(fs.readFileSync(file, 'utf8')).batches as ManifestEntry[]).filter((b) => b.tenant === tenant.id);
      for (const b of entries) {
        await tx.query(
          `INSERT INTO ops.expected_deliveries (tenant_id, source, batch, path, covers_from, covers_to) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, source, batch) DO UPDATE SET path = EXCLUDED.path, covers_from = EXCLUDED.covers_from, covers_to = EXCLUDED.covers_to`,
          [tenant.id, b.source, b.batch, b.path, b.covers_from, b.covers_to],
        );
        expected += 1;
      }
    }
    return { expected };
  });
}

export async function startRun(tenant: TenantSpec, args: Record<string, unknown>): Promise<number> {
  return withTenant(tenant.id, async (tx) => {
    const r = await tx.query<{ id: string }>('INSERT INTO ops.runs (tenant_id, args) VALUES ($1, $2) RETURNING id', [tenant.id, JSON.stringify(args)]);
    return Number(r.rows[0]!.id);
  });
}

export async function finishRun(tenant: TenantSpec, runId: number, status: 'succeeded' | 'failed', stats: unknown, error?: string): Promise<void> {
  await withTenant(tenant.id, (tx) =>
    tx.query('UPDATE ops.runs SET finished_at = now(), status = $2, stats = $3, error = $4 WHERE id = $1',
      [runId, status, JSON.stringify(stats), error ?? null]));
}
