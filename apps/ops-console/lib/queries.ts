import { withTenant } from "./db";

export interface Overview {
  expected: number;
  loaded: number;
  missing: number;
  lastRun: { id: number; status: string; finished_at: string | null; restatements: number; missing: number } | null;
  restatements: number;
  quarantine: number;
  days: number;
  gross: string;
  refunds: string;
  net: string;
  incompleteDays: number;
}

export async function overview(tenantId: string): Promise<Overview> {
  return withTenant(tenantId, async (tx) => {
    const d = (await tx.query<{ expected: string; loaded: string }>(
      `SELECT count(*)::text AS expected, count(f.id) FILTER (WHERE f.status = 'loaded')::text AS loaded
       FROM ops.expected_deliveries e LEFT JOIN raw.file_loads f ON f.tenant_id = e.tenant_id AND f.source = e.source AND f.batch = e.batch`)).rows[0]!;
    const run = (await tx.query<{ id: string; status: string; finished_at: string | null; stats: { marts?: { restatements?: number }; missingDeliveries?: unknown[] } }>(
      "SELECT id, status, finished_at::text, stats FROM ops.runs ORDER BY id DESC LIMIT 1")).rows[0];
    const rs = (await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM ops.restatements")).rows[0]!;
    const q = (await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM ops.quarantine")).rows[0]!;
    const rev = (await tx.query<{ days: string; gross: string; refunds: string; net: string; incomplete: string }>(
      `SELECT count(DISTINCT day)::text AS days, coalesce(sum(gross), 0)::numeric(14,2)::text AS gross,
              coalesce(sum(refunds), 0)::numeric(14,2)::text AS refunds, coalesce(sum(net), 0)::numeric(14,2)::text AS net,
              count(DISTINCT day) FILTER (WHERE NOT complete)::text AS incomplete
       FROM mart.daily_revenue`)).rows[0]!;
    return {
      expected: Number(d.expected), loaded: Number(d.loaded), missing: Number(d.expected) - Number(d.loaded),
      lastRun: run ? { id: Number(run.id), status: run.status, finished_at: run.finished_at, restatements: run.stats?.marts?.restatements ?? 0, missing: run.stats?.missingDeliveries?.length ?? 0 } : null,
      restatements: Number(rs.n), quarantine: Number(q.n),
      days: Number(rev.days), gross: rev.gross, refunds: rev.refunds, net: rev.net, incompleteDays: Number(rev.incomplete),
    };
  });
}

export interface DeliveryRow { source: string; batch: number; covers_from: string; covers_to: string; path: string; status: string; rows_seen: number | null; schema_version: string | null; loaded_at: string | null; attempts: number | null }

export async function deliveries(tenantId: string): Promise<DeliveryRow[]> {
  return withTenant(tenantId, async (tx) => (await tx.query<DeliveryRow>(
    `SELECT e.source, e.batch, e.covers_from::text, e.covers_to::text, e.path, coalesce(f.status, 'missing') AS status,
            f.rows_seen, f.schema_version, f.loaded_at::text, f.attempts
     FROM ops.expected_deliveries e LEFT JOIN raw.file_loads f ON f.tenant_id = e.tenant_id AND f.source = e.source AND f.batch = e.batch
     ORDER BY e.source, e.batch`)).rows);
}

export interface RunRow { id: number; status: string; started_at: string; finished_at: string | null; error: string | null; files: number; duplicates: number; inserted: number; restatements: number; missing: number; args: Record<string, unknown> }

export async function runs(tenantId: string): Promise<RunRow[]> {
  return withTenant(tenantId, async (tx) => (await tx.query<{ id: string; status: string; started_at: string; finished_at: string | null; error: string | null; args: Record<string, unknown>; stats: {
    ingest?: { files: { status: string; rowsInserted: number }[] }[]; marts?: { restatements: number }; missingDeliveries?: unknown[];
  } }>("SELECT id, status, started_at::text, finished_at::text, error, args, stats FROM ops.runs ORDER BY id DESC LIMIT 50")).rows.map((r) => {
    const files = (r.stats.ingest ?? []).flatMap((i) => i.files);
    return {
      id: Number(r.id), status: r.status, started_at: r.started_at, finished_at: r.finished_at, error: r.error, args: r.args,
      files: files.length, duplicates: files.filter((f) => f.status === "duplicate").length,
      inserted: files.reduce((n, f) => n + (f.rowsInserted ?? 0), 0),
      restatements: r.stats.marts?.restatements ?? 0, missing: r.stats.missingDeliveries?.length ?? 0,
    };
  }));
}

export interface RevenueRow { day: string; orders: number; gross: string; refunds: string; net: string; complete: boolean; by_channel: Record<string, string>; currency: string }

export async function revenue(tenantId: string): Promise<RevenueRow[]> {
  return withTenant(tenantId, async (tx) => (await tx.query<RevenueRow>(
    `SELECT day::text, sum(orders)::int AS orders, sum(gross)::numeric(14,2)::text AS gross, sum(refunds)::numeric(14,2)::text AS refunds,
            sum(net)::numeric(14,2)::text AS net, bool_and(complete) AS complete, json_object_agg(channel, net::text) AS by_channel, min(currency) AS currency
     FROM mart.daily_revenue GROUP BY day ORDER BY day`)).rows);
}

export interface RestatementRow { id: number; mart: string; day: string; dimension: string; metric: string; previous: string; current: string; run_id: number; cause: string; at: string }

export async function restatements(tenantId: string): Promise<RestatementRow[]> {
  return withTenant(tenantId, async (tx) => (await tx.query<RestatementRow>(
    "SELECT id, mart, day::text, dimension, metric, previous::text, current::text, run_id, cause, at::text FROM ops.restatements ORDER BY id DESC LIMIT 300")).rows);
}

export interface HoldRow { kind: string; source: string; ref: string; reason: string; detail: Record<string, unknown>; at: string }

/** Everything the pipeline held back or flagged: quarantined rows and files, schema events, conflicts. */
export async function holds(tenantId: string): Promise<HoldRow[]> {
  return withTenant(tenantId, async (tx) => (await tx.query<HoldRow>(
    `SELECT 'quarantine' AS kind, source, ref, reason, detail, at::text FROM ops.quarantine
     UNION ALL SELECT 'schema event', source, coalesce(f.path, ''), s.kind, s.detail, s.at::text FROM ops.schema_events s LEFT JOIN raw.file_loads f ON f.id = s.file_load_id
     UNION ALL SELECT 'conflict', source, natural_key, 'redelivered with different content', jsonb_build_object('previous', previous, 'incoming', incoming), at::text FROM ops.conflicts
     ORDER BY 6 DESC LIMIT 300`)).rows);
}
