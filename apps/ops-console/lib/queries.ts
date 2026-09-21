import { withTenant } from "./db";
import { sourcesFromCause } from "./format";

export const SOURCE_ORDER = ["orders", "email_events", "ad_spend", "refunds"];
export const CHANNEL_ORDER = ["paid_social", "paid_search", "email", "direct", "affiliate", "other", "unattributed"];
const SOURCE_RANK = `array_position(ARRAY['orders','email_events','ad_spend','refunds'], e.source)`;

export type DeliveryStatus = "loaded" | "loading" | "quarantined" | "failed" | "missing";

export interface MatrixCell { batch: number; status: DeliveryStatus; rows: number | null; alias: boolean }
export interface MatrixRow { source: string; cells: MatrixCell[] }

export interface LastRun { id: number; status: string; finished_at: string | null }

export interface Overview {
  expected: number;
  loaded: number;
  missing: number;
  lastRun: LastRun | null;
  restatements: number;
  holds: number;
  days: number;
  gross: string;
  refunds: string;
  net: string;
  incompleteDays: number;
  matrix: MatrixRow[];
}

/** The manifest against what loaded, as a source × batch grid. Shared by Home (mini bars) and Deliveries. */
async function matrix(tx: import("./db").Tx): Promise<MatrixRow[]> {
  const r = await tx.query<{ source: string; batch: number; status: string | null; rows_seen: number | null; schema_version: string | null }>(
    `SELECT e.source, e.batch, f.status, f.rows_seen, f.schema_version
     FROM ops.expected_deliveries e
     LEFT JOIN raw.file_loads f ON f.tenant_id = e.tenant_id AND f.source = e.source AND f.batch = e.batch
     ORDER BY ${SOURCE_RANK}, e.source, e.batch`);
  const rows: MatrixRow[] = [];
  for (const x of r.rows) {
    let row = rows.find((m) => m.source === x.source);
    if (!row) { row = { source: x.source, cells: [] }; rows.push(row); }
    row.cells.push({
      batch: x.batch, status: (x.status as DeliveryStatus | null) ?? "missing", rows: x.rows_seen,
      alias: !!x.schema_version && x.schema_version !== "v1",
    });
  }
  return rows;
}

export async function lastRun(tx: import("./db").Tx): Promise<LastRun | null> {
  const r = (await tx.query<{ id: string; status: string; finished_at: string | null }>(
    "SELECT id, status, finished_at::text FROM ops.runs ORDER BY id DESC LIMIT 1")).rows[0];
  return r ? { id: Number(r.id), status: r.status, finished_at: r.finished_at } : null;
}

export async function overview(tenantId: string): Promise<Overview> {
  return withTenant(tenantId, async (tx) => {
    const m = await matrix(tx);
    const cells = m.flatMap((r) => r.cells);
    const rs = (await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM ops.restatements")).rows[0]!;
    const q = (await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM ops.quarantine")).rows[0]!;
    const rev = (await tx.query<{ days: string; gross: string; refunds: string; net: string; incomplete: string }>(
      `SELECT count(DISTINCT day)::text AS days, coalesce(sum(gross), 0)::numeric(14,2)::text AS gross,
              coalesce(sum(refunds), 0)::numeric(14,2)::text AS refunds, coalesce(sum(net), 0)::numeric(14,2)::text AS net,
              count(DISTINCT day) FILTER (WHERE NOT complete)::text AS incomplete
       FROM mart.daily_revenue`)).rows[0]!;
    return {
      expected: cells.length, loaded: cells.filter((c) => c.status === "loaded").length, missing: cells.filter((c) => c.status === "missing").length,
      lastRun: await lastRun(tx), restatements: Number(rs.n), holds: Number(q.n),
      days: Number(rev.days), gross: rev.gross, refunds: rev.refunds, net: rev.net, incompleteDays: Number(rev.incomplete), matrix: m,
    };
  });
}

export interface DeliveryRow {
  source: string; batch: number; covers_from: string; covers_to: string; path: string; status: DeliveryStatus;
  rows_seen: number | null; schema_version: string | null; loaded_at: string | null; attempts: number | null;
}

export async function deliveries(tenantId: string): Promise<{ matrix: MatrixRow[]; rows: DeliveryRow[]; rowsLoaded: number; lastRun: LastRun | null }> {
  return withTenant(tenantId, async (tx) => {
    const rows = (await tx.query<DeliveryRow>(
      `SELECT e.source, e.batch, e.covers_from::text, e.covers_to::text, e.path, coalesce(f.status, 'missing') AS status,
              f.rows_seen, f.schema_version, f.loaded_at::text, f.attempts
       FROM ops.expected_deliveries e LEFT JOIN raw.file_loads f ON f.tenant_id = e.tenant_id AND f.source = e.source AND f.batch = e.batch
       ORDER BY ${SOURCE_RANK}, e.source, e.batch`)).rows;
    return { matrix: await matrix(tx), rows, rowsLoaded: rows.reduce((n, r) => n + (r.status === "loaded" ? r.rows_seen ?? 0 : 0), 0), lastRun: await lastRun(tx) };
  });
}

export interface RunRow {
  id: number; status: string; started_at: string; finished_at: string | null; error: string | null;
  files: number; duplicates: number; inserted: number; restatements: number; missing: number; args: string;
  context: string | null;   // the second line: what happened, in one sentence
}

interface RunStatsShape {
  ingest?: { files: { status: string; rowsInserted: number; path: string; note?: string }[] }[];
  marts?: { restatements: number; orphansResolved?: number };
  missingDeliveries?: unknown[];
}

export async function runs(tenantId: string): Promise<{ rows: RunRow[]; lastRun: LastRun | null }> {
  return withTenant(tenantId, async (tx) => {
    const r = await tx.query<{ id: string; status: string; started_at: string; finished_at: string | null; error: string | null; args: Record<string, unknown>; stats: RunStatsShape }>(
      "SELECT id, status, started_at::text, finished_at::text, error, args, stats FROM ops.runs ORDER BY id DESC LIMIT 50");
    const rows = r.rows.map((x) => {
      const files = (x.stats.ingest ?? []).flatMap((i) => i.files);
      const resumed = files.filter((f) => f.status === "resumed");
      const duplicates = files.filter((f) => f.status === "duplicate").length;
      const quarantined = files.filter((f) => f.status === "quarantined");
      const parts: string[] = [];
      if (x.status === "failed" && x.error) parts.push(x.error.replace(" (the chunk in flight was not committed)", " · the chunk in flight was not committed"));
      for (const f of resumed) parts.push(`resumed ${f.path}${f.note ? ` ${f.note.replace("resumed from line", "at line")}` : ""}`);
      if (duplicates && x.status !== "failed") parts.push(`${duplicates} file${duplicates > 1 ? "s" : ""} already loaded, skipped`);
      for (const f of quarantined) parts.push(`quarantined ${f.path}${f.note ? `: ${f.note}` : ""}`);
      if (x.stats.marts?.orphansResolved) parts.push(`${x.stats.marts.orphansResolved} refund${x.stats.marts.orphansResolved > 1 ? "s" : ""} found their order`);
      const args = Object.entries(x.args ?? {})
        .filter(([k, v]) => !["phases", "tenant", "skipMarts"].includes(k) && v !== undefined && v !== null && v !== false)
        .map(([k, v]) => `${k}=${String(v)}`).join(" ");
      return {
        id: Number(x.id), status: x.status, started_at: x.started_at, finished_at: x.finished_at, error: x.error,
        files: files.length, duplicates, inserted: files.reduce((n, f) => n + (f.rowsInserted ?? 0), 0),
        restatements: x.stats.marts?.restatements ?? 0, missing: x.stats.missingDeliveries?.length ?? 0, args,
        context: parts.length ? parts.join(" · ") : null,
      };
    });
    return { rows, lastRun: await lastRun(tx) };
  });
}

export interface RevenueRow { day: string; orders: number; gross: string; refunds: string; net: string; complete: boolean; by_channel: Record<string, string> }
export interface RevenueTable { rows: RevenueRow[]; channels: string[]; totals: { orders: number; gross: number; refunds: number; net: number; by_channel: Record<string, number> }; currency: string; lastRun: LastRun | null }

export async function revenue(tenantId: string): Promise<RevenueTable> {
  return withTenant(tenantId, async (tx) => {
    const r = await tx.query<RevenueRow & { currency: string }>(
      `SELECT day::text, sum(orders)::int AS orders, sum(gross)::numeric(14,2)::text AS gross, sum(refunds)::numeric(14,2)::text AS refunds,
              sum(net)::numeric(14,2)::text AS net, bool_and(complete) AS complete, json_object_agg(channel, net::text) AS by_channel, min(currency) AS currency
       FROM mart.daily_revenue GROUP BY day ORDER BY day`);
    const present = new Set(r.rows.flatMap((x) => Object.keys(x.by_channel)));
    const channels = [...CHANNEL_ORDER.filter((c) => present.has(c)), ...[...present].filter((c) => !CHANNEL_ORDER.includes(c)).sort()];
    const totals = { orders: 0, gross: 0, refunds: 0, net: 0, by_channel: Object.fromEntries(channels.map((c) => [c, 0])) as Record<string, number> };
    for (const x of r.rows) {
      totals.orders += x.orders; totals.gross += Number(x.gross); totals.refunds += Number(x.refunds); totals.net += Number(x.net);
      for (const c of channels) totals.by_channel[c] = (totals.by_channel[c] ?? 0) + Number(x.by_channel[c] ?? 0);
    }
    return { rows: r.rows, channels, totals, currency: r.rows[0]?.currency ?? "", lastRun: await lastRun(tx) };
  });
}

export interface RestatementRow { id: number; mart: string; day: string; dimension: string; metric: string; previous: string; current: string; run_id: number; cause: string }
export interface RestatementDay { day: string; runs: number[]; sources: string[]; rows: RestatementRow[] }
export interface Restatements { days: RestatementDay[]; total: number; marts: number; lastRun: LastRun | null }

export async function restatements(tenantId: string): Promise<Restatements> {
  return withTenant(tenantId, async (tx) => {
    const r = await tx.query<RestatementRow>(
      "SELECT id, mart, day::text, dimension, metric, previous::text, current::text, run_id, cause FROM ops.restatements ORDER BY day DESC, id LIMIT 500");
    const days: RestatementDay[] = [];
    for (const x of r.rows) {
      let d = days.find((y) => y.day === x.day);
      if (!d) { d = { day: x.day, runs: [], sources: [], rows: [] }; days.push(d); }
      d.rows.push(x);
      if (!d.runs.includes(x.run_id)) d.runs.push(x.run_id);
      for (const s of sourcesFromCause(x.cause)) if (!d.sources.includes(s)) d.sources.push(s);
    }
    return { days, total: r.rows.length, marts: new Set(r.rows.map((x) => x.mart)).size, lastRun: await lastRun(tx) };
  });
}

export interface HoldRow { kind: "quarantine" | "schema event" | "conflict"; source: string; batch: number | null; ref: string; reason: string; detail: Record<string, unknown>; run_id: number | null; at: string }
export interface Holds { rows: HoldRow[]; quarantined: number; schemaEvents: number; conflicts: number; lastRun: LastRun | null }

/** Everything the pipeline held back or flagged, newest first, with the batch and run it came from. */
export async function holds(tenantId: string): Promise<Holds> {
  return withTenant(tenantId, async (tx) => {
    const r = await tx.query<HoldRow>(
      `SELECT 'quarantine' AS kind, q.source, f.batch, q.ref, q.reason, q.detail, f.run_id, q.at::text
         FROM ops.quarantine q LEFT JOIN raw.file_loads f ON f.id = q.file_load_id
       UNION ALL
       SELECT 'schema event', s.source, f.batch, '', s.kind, s.detail || jsonb_build_object('file', f.path), f.run_id, s.at::text
         FROM ops.schema_events s LEFT JOIN raw.file_loads f ON f.id = s.file_load_id
       UNION ALL
       SELECT 'conflict', c.source, f.batch, c.natural_key, 'redelivered with different content',
              jsonb_build_object('previous', c.previous, 'incoming', c.incoming), f.run_id, c.at::text
         FROM ops.conflicts c LEFT JOIN raw.file_loads f ON f.id = c.file_load_id
       ORDER BY 1, 4, 3, 8 DESC LIMIT 300`);
    const rows = r.rows.map((x) => ({ ...x, run_id: x.run_id === null ? null : Number(x.run_id) }));
    return {
      rows, quarantined: rows.filter((x) => x.kind === "quarantine").length, schemaEvents: rows.filter((x) => x.kind === "schema event").length,
      conflicts: rows.filter((x) => x.kind === "conflict").length, lastRun: await lastRun(tx),
    };
  });
}
