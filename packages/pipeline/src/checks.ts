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
  overdue_days: number | null;   // for a delivery not loaded: days since the window it covers closed (as of today, UTC)
}

function overdueDays(coversTo: string): number {
  const end = Date.parse(`${coversTo}T00:00:00Z`);
  return Math.max(0, Math.floor((Date.now() - end) / 86_400_000) - 1);
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
      const status = (x.status as DeliveryStatus['status'] | null) ?? 'missing';
      rows.push({
        tenant: id, source: x.source, batch: x.batch, covers: `${x.covers_from} to ${x.covers_to}`, expected_path: x.path,
        status, rows: x.rows_seen, schema: x.schema_version, overdue_days: status === 'loaded' ? null : overdueDays(x.covers_to),
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

export interface SourceFreshness { tenant: string; source: string; last_covered: string | null; expected_through: string; stale_days: number; missing: number }

/** Per source: the last day a loaded delivery covers, the last day the manifest promises, and the gap. */
export async function checkFreshness(config: Config, tenantIds?: string[]): Promise<SourceFreshness[]> {
  const out: SourceFreshness[] = [];
  for (const id of tenantIds ?? Object.keys(config.tenants)) {
    const r = await withTenant(id, (tx) => tx.query<{ source: string; last_covered: string | null; expected_through: string; missing: string }>(
      `SELECT e.source, to_char(max(e.covers_to) FILTER (WHERE f.status = 'loaded'), 'YYYY-MM-DD') AS last_covered,
              to_char(max(e.covers_to), 'YYYY-MM-DD') AS expected_through,
              count(*) FILTER (WHERE f.id IS NULL OR f.status <> 'loaded')::text AS missing
       FROM ops.expected_deliveries e
       LEFT JOIN raw.file_loads f ON f.tenant_id = e.tenant_id AND f.source = e.source AND f.batch = e.batch
       WHERE e.tenant_id = $1 GROUP BY e.source ORDER BY e.source`, [id]));
    for (const x of r.rows) {
      const lastCovered = x.last_covered ? Date.parse(`${x.last_covered}T00:00:00Z`) : null;
      const expected = Date.parse(`${x.expected_through}T00:00:00Z`);
      const staleDays = lastCovered === null ? overdueDays(x.expected_through) : Math.max(0, Math.round((expected - lastCovered) / 86_400_000));
      out.push({ tenant: id, source: x.source, last_covered: x.last_covered, expected_through: x.expected_through, stale_days: staleDays, missing: Number(x.missing) });
    }
  }
  return out;
}

export interface TenantStatus {
  tenant: string; display_name: string; currency: string;
  last_run: { id: number; status: string; finished_at: string | null } | null;
  deliveries: { expected: number; loaded: number; missing: number };
  restatements: number; held: number; incomplete_days: number; late_postings: number;
  days: number; net: string; gross: string; refunds: string;
}

/** What the console's tenant card shows, for the terminal. */
export async function tenantStatus(config: Config, tenant: TenantSpec): Promise<TenantStatus> {
  return withTenant(tenant.id, async (tx) => {
    const run = (await tx.query<{ id: string; status: string; finished_at: string | null }>(
      'SELECT id, status, finished_at::text FROM ops.runs ORDER BY id DESC LIMIT 1')).rows[0];
    const d = (await tx.query<{ expected: string; loaded: string }>(
      `SELECT count(*)::text AS expected, count(f.id) FILTER (WHERE f.status = 'loaded')::text AS loaded
       FROM ops.expected_deliveries e LEFT JOIN raw.file_loads f ON f.tenant_id = e.tenant_id AND f.source = e.source AND f.batch = e.batch`)).rows[0]!;
    const n = async (sql: string) => Number((await tx.query<{ n: string }>(sql)).rows[0]!.n);
    const rev = (await tx.query<{ days: string; gross: string; refunds: string; net: string; incomplete: string }>(
      `SELECT count(DISTINCT day)::text AS days, coalesce(sum(gross), 0)::numeric(14,2)::text AS gross, coalesce(sum(refunds), 0)::numeric(14,2)::text AS refunds,
              coalesce(sum(net), 0)::numeric(14,2)::text AS net, count(DISTINCT day) FILTER (WHERE NOT complete)::text AS incomplete FROM mart.daily_revenue`)).rows[0]!;
    return {
      tenant: tenant.id, display_name: tenant.display_name, currency: tenant.currency,
      last_run: run ? { id: Number(run.id), status: run.status, finished_at: run.finished_at } : null,
      deliveries: { expected: Number(d.expected), loaded: Number(d.loaded), missing: Number(d.expected) - Number(d.loaded) },
      restatements: await n('SELECT count(*)::text AS n FROM ops.restatements'), held: await n('SELECT count(*)::text AS n FROM ops.quarantine'),
      incomplete_days: Number(rev.incomplete), late_postings: await n('SELECT count(*)::text AS n FROM mart.late_postings'),
      days: Number(rev.days), net: rev.net, gross: rev.gross, refunds: rev.refunds,
    };
  });
}
