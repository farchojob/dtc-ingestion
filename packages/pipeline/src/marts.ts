/**
 * Marts: what the client queries, rebuilt one (tenant, day) at a time.
 *
 * - Only days marked dirty by staging are rebuilt. A day is dirty when a record for it was inserted or changed.
 * - If the day already had numbers, every metric that moves is written to ops.restatements first
 *   (previous, current, the run, and which sources caused it). That is what happens to a number the
 *   client had already seen: it changes, and the change is on record.
 * - A refund whose order is unknown counts under channel 'unattributed' and is also quarantined by refund id.
 * - A day is 'complete' only if every expected orders/refunds delivery covering it has loaded.
 */
import type { Tx } from './db.ts';
import { withTenant } from './db.ts';
import type { RunCtx } from './run.ts';

export interface MartStats {
  daysRebuilt: number;
  rowsWritten: number;
  restatements: number;
  orphanRefunds: number;
  incompleteDays: number;
}

interface RevenueRow { channel: string; orders: number; gross: string; refunds: string; net: string }

const METRICS: (keyof Omit<RevenueRow, 'channel'>)[] = ['orders', 'gross', 'refunds', 'net'];

export async function buildMarts(ctx: RunCtx): Promise<MartStats> {
  const tenantId = ctx.tenant.id;
  const stats: MartStats = { daysRebuilt: 0, rowsWritten: 0, restatements: 0, orphanRefunds: 0, incompleteDays: 0 };
  stats.orphanRefunds = await withTenant(tenantId, (tx) => quarantineOrphanRefunds(tx, tenantId));
  const dirty = await withTenant(tenantId, async (tx) => (await tx.query<{ day: string; sources: string[] }>(
    "SELECT to_char(day, 'YYYY-MM-DD') AS day, sources FROM ops.dirty_days WHERE tenant_id = $1 ORDER BY day", [tenantId])).rows);
  for (const d of dirty) {
    await withTenant(tenantId, async (tx) => {
      const fresh = await computeDay(tx, tenantId, d.day);
      const previous = await currentDay(tx, tenantId, d.day);
      const complete = await deliveriesComplete(tx, tenantId, d.day);
      if (!complete) stats.incompleteDays += 1;
      for (const row of fresh) {
        const before = previous.get(row.channel);
        if (before) {
          for (const m of METRICS) {
            if (Number(before[m]) !== Number(row[m])) {
              await tx.query(
                'INSERT INTO ops.restatements (tenant_id, day, channel, metric, previous, current, run_id, cause) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                [tenantId, d.day, row.channel, m, before[m], row[m], ctx.runId, `late or changed records in: ${d.sources.join(', ')}`]);
              stats.restatements += 1;
            }
          }
        }
        await tx.query(
          `INSERT INTO mart.daily_revenue (tenant_id, day, channel, orders, gross, refunds, net, currency, complete, built_by_run, built_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
           ON CONFLICT (tenant_id, day, channel) DO UPDATE SET orders = EXCLUDED.orders, gross = EXCLUDED.gross, refunds = EXCLUDED.refunds,
             net = EXCLUDED.net, currency = EXCLUDED.currency, complete = EXCLUDED.complete, built_by_run = EXCLUDED.built_by_run, built_at = now()`,
          [tenantId, d.day, row.channel, row.orders, row.gross, row.refunds, row.net, ctx.tenant.currency, complete, ctx.runId]);
        stats.rowsWritten += 1;
      }
      await tx.query('DELETE FROM ops.dirty_days WHERE tenant_id = $1 AND day = $2', [tenantId, d.day]);
    });
    stats.daysRebuilt += 1;
  }
  return stats;
}

/** Gross by the order's channel on its creation day; refunds by the refund day, attributed to the order's channel. */
async function computeDay(tx: Tx, tenantId: string, day: string): Promise<RevenueRow[]> {
  const r = await tx.query<RevenueRow>(
    `WITH o AS (
       SELECT channel, count(*)::int AS orders, sum(gross) AS gross
       FROM stg.orders WHERE tenant_id = $1 AND (created_at AT TIME ZONE 'UTC')::date = $2::date GROUP BY channel),
     r AS (
       SELECT coalesce(ord.channel, 'unattributed') AS channel, sum(rf.amount) AS refunds
       FROM stg.refunds rf LEFT JOIN stg.orders ord ON ord.tenant_id = rf.tenant_id AND ord.order_id = rf.order_id
       WHERE rf.tenant_id = $1 AND (rf.refunded_at AT TIME ZONE 'UTC')::date = $2::date GROUP BY 1)
     SELECT coalesce(o.channel, r.channel) AS channel, coalesce(o.orders, 0) AS orders,
            coalesce(o.gross, 0)::numeric(14,2)::text AS gross, coalesce(r.refunds, 0)::numeric(14,2)::text AS refunds,
            (coalesce(o.gross, 0) - coalesce(r.refunds, 0))::numeric(14,2)::text AS net
     FROM o FULL OUTER JOIN r ON o.channel = r.channel ORDER BY 1`, [tenantId, day]);
  return r.rows;
}

async function currentDay(tx: Tx, tenantId: string, day: string): Promise<Map<string, RevenueRow>> {
  const r = await tx.query<RevenueRow>(
    'SELECT channel, orders, gross::text, refunds::text, net::text FROM mart.daily_revenue WHERE tenant_id = $1 AND day = $2::date', [tenantId, day]);
  return new Map(r.rows.map((x) => [x.channel, x]));
}

async function deliveriesComplete(tx: Tx, tenantId: string, day: string): Promise<boolean> {
  const r = await tx.query<{ missing: string }>(
    `SELECT count(*) FILTER (WHERE f.id IS NULL)::text AS missing
     FROM ops.expected_deliveries e
     LEFT JOIN raw.file_loads f ON f.tenant_id = e.tenant_id AND f.source = e.source AND f.batch = e.batch AND f.status = 'loaded'
     WHERE e.tenant_id = $1 AND e.source IN ('orders', 'refunds') AND e.covers_from <= $2::date AND e.covers_to >= $2::date`, [tenantId, day]);
  return Number(r.rows[0]?.missing ?? 0) === 0;
}

async function quarantineOrphanRefunds(tx: Tx, tenantId: string): Promise<number> {
  const r = await tx.query(
    `INSERT INTO ops.quarantine (tenant_id, source, file_load_id, ref, reason, detail)
     SELECT rf.tenant_id, 'refunds', rf.last_file_load_id, rf.refund_id, 'unresolvable_reference',
            jsonb_build_object('order_id', rf.order_id, 'amount', rf.amount, 'refunded_at', rf.refunded_at)
     FROM stg.refunds rf LEFT JOIN stg.orders o ON o.tenant_id = rf.tenant_id AND o.order_id = rf.order_id
     WHERE rf.tenant_id = $1 AND o.order_id IS NULL
     ON CONFLICT (tenant_id, source, ref, reason) DO NOTHING`, [tenantId]);
  return r.rowCount ?? 0;
}
