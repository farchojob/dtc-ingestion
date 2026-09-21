/**
 * Marts: what the client queries, rebuilt one (tenant, day) at a time.
 *
 * - Only days marked dirty by staging are rebuilt. A day is dirty when a record for it was inserted or changed.
 * - If the day already had numbers, every metric that moves is written to ops.restatements first
 *   (previous, current, the run, and which sources caused it). That is what happens to a number the
 *   client had already seen: it changes, and the change is on record.
 * - Two stored marts share the mechanism: daily_revenue (dimension = channel) and daily_email
 *   (dimension = campaign). daily_marketing is a view because spend has no derived metric yet.
 * - A refund whose order is unknown counts under channel 'unattributed' and is also quarantined by refund id.
 *   When the order arrives later (refund batches are not ordered by anything useful, F4), the refund moves to
 *   its channel on the next rebuild and the quarantine entry is released.
 * - A revenue day is 'complete' only if every expected orders/refunds delivery covering it has loaded.
 */
import type { Tx } from './db.ts';
import { withTenant } from './db.ts';
import type { RunCtx } from './run.ts';

export interface MartStats {
  daysRebuilt: number;
  rowsWritten: number;
  restatements: number;
  orphanRefunds: number;      // refunds whose order is unknown right now
  orphansResolved: number;    // refunds that were unattributed and whose order has since arrived
  incompleteDays: number;
}

type MetricRow = Record<string, string | number> & { dimension: string };

/** What a stored mart needs to be rebuilt for one day and compared with what it had. */
interface MartSpec {
  name: string;
  metrics: string[];
  compute(tx: Tx, tenantId: string, day: string): Promise<MetricRow[]>;
  current(tx: Tx, tenantId: string, day: string): Promise<MetricRow[]>;
  write(tx: Tx, ctx: RunCtx, day: string, row: MetricRow, complete: boolean): Promise<void>;
  remove(tx: Tx, tenantId: string, day: string, dimension: string): Promise<void>;
}

export async function buildMarts(ctx: RunCtx): Promise<MartStats> {
  const tenantId = ctx.tenant.id;
  const stats: MartStats = { daysRebuilt: 0, rowsWritten: 0, restatements: 0, orphanRefunds: 0, orphansResolved: 0, incompleteDays: 0 };
  await withTenant(tenantId, async (tx) => {
    stats.orphansResolved = await releaseResolvedRefunds(tx, tenantId);
    stats.orphanRefunds = await quarantineOrphanRefunds(tx, tenantId);
  });
  const dirty = await withTenant(tenantId, async (tx) => (await tx.query<{ day: string; sources: string[] }>(
    "SELECT to_char(day, 'YYYY-MM-DD') AS day, sources FROM ops.dirty_days WHERE tenant_id = $1 ORDER BY day", [tenantId])).rows);
  for (const d of dirty) {
    await withTenant(tenantId, async (tx) => {
      const complete = await deliveriesComplete(tx, tenantId, d.day);
      if (!complete) stats.incompleteDays += 1;
      const cause = `late or changed records in: ${d.sources.join(', ')}`;
      for (const mart of [REVENUE, EMAIL]) {
        const r = await rebuildDay(tx, ctx, mart, d.day, complete, cause);
        stats.rowsWritten += r.rows;
        stats.restatements += r.restatements;
      }
      await tx.query('DELETE FROM ops.dirty_days WHERE tenant_id = $1 AND day = $2', [tenantId, d.day]);
    });
    stats.daysRebuilt += 1;
  }
  return stats;
}

async function rebuildDay(tx: Tx, ctx: RunCtx, mart: MartSpec, day: string, complete: boolean, cause: string): Promise<{ rows: number; restatements: number }> {
  const tenantId = ctx.tenant.id;
  const fresh = await mart.compute(tx, tenantId, day);
  const previous = new Map((await mart.current(tx, tenantId, day)).map((r) => [r.dimension, r]));
  let restatements = 0;
  for (const row of fresh) {
    const before = previous.get(row.dimension);
    if (before) {
      for (const m of mart.metrics) {
        if (Number(before[m]) !== Number(row[m])) {
          await tx.query(
            'INSERT INTO ops.restatements (tenant_id, mart, day, dimension, metric, previous, current, run_id, cause) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [tenantId, mart.name, day, row.dimension, m, before[m], row[m], ctx.runId, cause]);
          restatements += 1;
        }
      }
    }
    await mart.write(tx, ctx, day, row, complete);
  }
  // A dimension the day no longer has (a refund that was 'unattributed' and now has its channel): the old row
  // would double count, so it goes, and each of its metrics is restated to zero.
  const gone = [...previous.keys()].filter((dim) => !fresh.some((r) => r.dimension === dim));
  for (const dim of gone) {
    const before = previous.get(dim)!;
    for (const m of mart.metrics) {
      if (Number(before[m]) !== 0) {
        await tx.query(
          'INSERT INTO ops.restatements (tenant_id, mart, day, dimension, metric, previous, current, run_id, cause) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)',
          [tenantId, mart.name, day, dim, m, before[m], ctx.runId, cause]);
        restatements += 1;
      }
    }
    await mart.remove(tx, tenantId, day, dim);
  }
  return { rows: fresh.length, restatements };
}

/** Gross by the order's channel on its creation day; refunds by the refund day, attributed to the order's channel. */
const REVENUE: MartSpec = {
  name: 'daily_revenue',
  metrics: ['orders', 'gross', 'refunds', 'net'],
  async compute(tx, tenantId, day) {
    return (await tx.query<MetricRow>(
      `WITH o AS (
         SELECT channel, count(*)::int AS orders, sum(gross) AS gross
         FROM stg.orders WHERE tenant_id = $1 AND (created_at AT TIME ZONE 'UTC')::date = $2::date GROUP BY channel),
       r AS (
         SELECT coalesce(ord.channel, 'unattributed') AS channel, sum(rf.amount) AS refunds
         FROM stg.refunds rf LEFT JOIN stg.orders ord ON ord.tenant_id = rf.tenant_id AND ord.order_id = rf.order_id
         WHERE rf.tenant_id = $1 AND (rf.refunded_at AT TIME ZONE 'UTC')::date = $2::date GROUP BY 1)
       SELECT coalesce(o.channel, r.channel) AS dimension, coalesce(o.orders, 0) AS orders,
              coalesce(o.gross, 0)::numeric(14,2)::text AS gross, coalesce(r.refunds, 0)::numeric(14,2)::text AS refunds,
              (coalesce(o.gross, 0) - coalesce(r.refunds, 0))::numeric(14,2)::text AS net
       FROM o FULL OUTER JOIN r ON o.channel = r.channel ORDER BY 1`, [tenantId, day])).rows;
  },
  async current(tx, tenantId, day) {
    return (await tx.query<MetricRow>(
      'SELECT channel AS dimension, orders, gross::text, refunds::text, net::text FROM mart.daily_revenue WHERE tenant_id = $1 AND day = $2::date',
      [tenantId, day])).rows;
  },
  async write(tx, ctx, day, row, complete) {
    await tx.query(
      `INSERT INTO mart.daily_revenue (tenant_id, day, channel, orders, gross, refunds, net, currency, complete, built_by_run, built_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (tenant_id, day, channel) DO UPDATE SET orders = EXCLUDED.orders, gross = EXCLUDED.gross, refunds = EXCLUDED.refunds,
         net = EXCLUDED.net, currency = EXCLUDED.currency, complete = EXCLUDED.complete, built_by_run = EXCLUDED.built_by_run, built_at = now()`,
      [ctx.tenant.id, day, row.dimension, row.orders, row.gross, row.refunds, row.net, ctx.tenant.currency, complete, ctx.runId]);
  },
  async remove(tx, tenantId, day, dimension) {
    await tx.query('DELETE FROM mart.daily_revenue WHERE tenant_id = $1 AND day = $2::date AND channel = $3', [tenantId, day, dimension]);
  },
};

/** Counts per campaign per day, by event type. Late events change these; the change is recorded. */
const EMAIL: MartSpec = {
  name: 'daily_email',
  metrics: ['delivered', 'opens', 'clicks', 'unsubscribes'],
  async compute(tx, tenantId, day) {
    return (await tx.query<MetricRow>(
      `SELECT coalesce(campaign_id, '(none)') AS dimension,
              count(*) FILTER (WHERE type = 'delivered')::int   AS delivered,
              count(*) FILTER (WHERE type = 'open')::int        AS opens,
              count(*) FILTER (WHERE type = 'click')::int       AS clicks,
              count(*) FILTER (WHERE type = 'unsubscribe')::int AS unsubscribes
       FROM stg.email_events WHERE tenant_id = $1 AND (occurred_at AT TIME ZONE 'UTC')::date = $2::date
       GROUP BY 1 ORDER BY 1`, [tenantId, day])).rows;
  },
  async current(tx, tenantId, day) {
    return (await tx.query<MetricRow>(
      'SELECT campaign_id AS dimension, delivered, opens, clicks, unsubscribes FROM mart.daily_email WHERE tenant_id = $1 AND day = $2::date',
      [tenantId, day])).rows;
  },
  async write(tx, ctx, day, row) {
    await tx.query(
      `INSERT INTO mart.daily_email (tenant_id, day, campaign_id, delivered, opens, clicks, unsubscribes, built_by_run, built_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (tenant_id, day, campaign_id) DO UPDATE SET delivered = EXCLUDED.delivered, opens = EXCLUDED.opens, clicks = EXCLUDED.clicks,
         unsubscribes = EXCLUDED.unsubscribes, built_by_run = EXCLUDED.built_by_run, built_at = now()`,
      [ctx.tenant.id, day, row.dimension, row.delivered, row.opens, row.clicks, row.unsubscribes, ctx.runId]);
  },
  async remove(tx, tenantId, day, dimension) {
    await tx.query('DELETE FROM mart.daily_email WHERE tenant_id = $1 AND day = $2::date AND campaign_id = $3', [tenantId, day, dimension]);
  },
};

async function deliveriesComplete(tx: Tx, tenantId: string, day: string): Promise<boolean> {
  const r = await tx.query<{ missing: string }>(
    `SELECT count(*) FILTER (WHERE f.id IS NULL)::text AS missing
     FROM ops.expected_deliveries e
     LEFT JOIN raw.file_loads f ON f.tenant_id = e.tenant_id AND f.source = e.source AND f.batch = e.batch AND f.status = 'loaded'
     WHERE e.tenant_id = $1 AND e.source IN ('orders', 'refunds') AND e.covers_from <= $2::date AND e.covers_to >= $2::date`, [tenantId, day]);
  return Number(r.rows[0]?.missing ?? 0) === 0;
}

/** Refunds that were unattributed and whose order has since arrived: release the hold and dirty the refund's
 *  own day, which nothing else would touch (the order's day is not the refund's day). */
async function releaseResolvedRefunds(tx: Tx, tenantId: string): Promise<number> {
  const r = await tx.query<{ ref: string }>(
    `DELETE FROM ops.quarantine q
     WHERE q.tenant_id = $1 AND q.source = 'refunds' AND q.reason = 'unresolvable_reference'
       AND EXISTS (SELECT 1 FROM stg.refunds rf JOIN stg.orders o ON o.tenant_id = rf.tenant_id AND o.order_id = rf.order_id
                   WHERE rf.tenant_id = q.tenant_id AND rf.refund_id = q.ref)
     RETURNING q.ref`, [tenantId]);
  if (r.rows.length) {
    await tx.query(
      `INSERT INTO ops.dirty_days (tenant_id, day, sources)
       SELECT DISTINCT tenant_id, (refunded_at AT TIME ZONE 'UTC')::date, ARRAY['refunds'] FROM stg.refunds
       WHERE tenant_id = $1 AND refund_id = ANY($2::text[])
       ON CONFLICT (tenant_id, day) DO UPDATE
       SET sources = (SELECT array_agg(DISTINCT x) FROM unnest(ops.dirty_days.sources || EXCLUDED.sources) AS x)`,
      [tenantId, r.rows.map((x) => x.ref)]);
  }
  return r.rows.length;
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
