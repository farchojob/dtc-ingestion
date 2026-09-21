/**
 * Checks that say what did not happen.
 *  - deliveries: every batch the manifest promises, against what actually loaded, per tenant.
 *  - finance: the client's own daily summary against the marts (gross ties or it does not; net and currency are questions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as csvParseSync } from 'csv-parse/sync';
import { withTenant } from './db.ts';
import type { Config, TenantSpec } from './config.ts';

export interface DeliveryStatus {
  tenant: string;
  source: string;
  batch: number;
  covers: string;
  expected_path: string;
  status: 'loaded' | 'loading' | 'quarantined' | 'failed' | 'missing';
  rows: number | null;
  schema: string | null;
}

export async function checkDeliveries(config: Config, tenantIds?: string[]): Promise<{ rows: DeliveryStatus[]; missing: number; notLoaded: number }> {
  const rows: DeliveryStatus[] = [];
  for (const id of tenantIds ?? Object.keys(config.tenants)) {
    const r = await withTenant(id, (tx) => tx.query<{
      source: string; batch: number; path: string; covers_from: string; covers_to: string; status: string | null; rows_seen: number | null; schema_version: string | null;
    }>(
      `SELECT e.source, e.batch, e.path, to_char(e.covers_from, 'YYYY-MM-DD') AS covers_from, to_char(e.covers_to, 'YYYY-MM-DD') AS covers_to,
              f.status, f.rows_seen, f.schema_version
       FROM ops.expected_deliveries e
       LEFT JOIN raw.file_loads f ON f.tenant_id = e.tenant_id AND f.source = e.source AND f.batch = e.batch
       WHERE e.tenant_id = $1 ORDER BY e.source, e.batch`, [id]));
    for (const x of r.rows) {
      rows.push({
        tenant: id, source: x.source, batch: x.batch, covers: `${x.covers_from} to ${x.covers_to}`, expected_path: x.path,
        status: (x.status as DeliveryStatus['status'] | null) ?? 'missing', rows: x.rows_seen, schema: x.schema_version,
      });
    }
  }
  return { rows, missing: rows.filter((r) => r.status === 'missing').length, notLoaded: rows.filter((r) => r.status !== 'loaded').length };
}

export interface FinanceLine { day: string; reported_gross: string; mart_gross: string; gross_diff: string; reported_net: string; mart_net: string; net_diff: string }
export interface FinanceCheck { tenant: string; finance_currency: string; tenant_currency: string; days: number; gross_ties: number; lines: FinanceLine[] }

export async function checkFinance(config: Config, tenant: TenantSpec): Promise<FinanceCheck> {
  const file = path.join(config.fixturesDir, tenant.id, 'finance_summary.csv');
  const reported = csvParseSync(fs.readFileSync(file, 'utf8'), { columns: true }) as { date: string; gross_reported: string; net_reported: string; currency: string }[];
  const mart = await withTenant(tenant.id, (tx) => tx.query<{ day: string; gross: string; net: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(gross)::numeric(14,2)::text AS gross, sum(net)::numeric(14,2)::text AS net
     FROM mart.daily_revenue WHERE tenant_id = $1 GROUP BY day`, [tenant.id]));
  const byDay = new Map(mart.rows.map((r) => [r.day, r]));
  const lines: FinanceLine[] = reported.map((r) => {
    const m = byDay.get(r.date);
    const mg = m?.gross ?? '0.00';
    const mn = m?.net ?? '0.00';
    return {
      day: r.date, reported_gross: r.gross_reported, mart_gross: mg, gross_diff: (Number(r.gross_reported) - Number(mg)).toFixed(2),
      reported_net: r.net_reported, mart_net: mn, net_diff: (Number(r.net_reported) - Number(mn)).toFixed(2),
    };
  });
  return {
    tenant: tenant.id, finance_currency: reported[0]?.currency ?? '?', tenant_currency: tenant.currency, days: lines.length,
    gross_ties: lines.filter((l) => l.gross_diff === '0.00' || l.gross_diff === '-0.00').length, lines,
  };
}
