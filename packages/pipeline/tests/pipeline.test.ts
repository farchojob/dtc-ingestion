/**
 * Each test is one claim from docs/DECISIONS.md, proved against a real Postgres with the real fixtures.
 * Run with `npm test` after `npm run db:up`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { prepareTestDatabase, resetData, snapshot, adminQuery, loadConfig } from './helpers.ts';
import { runTenant, RunFailed } from '../src/pipeline.ts';
import { SimulatedCrash } from '../src/ingest.ts';
import { withTenant, appPool, closePools } from '../src/db.ts';

let config: ReturnType<typeof loadConfig>;

beforeAll(async () => {
  await prepareTestDatabase();
  config = loadConfig();
});
beforeEach(resetData);
afterAll(closePools);

test('running the same files twice changes nothing (D6: idempotent at file and record level)', async () => {
  await runTenant(config, 'northwind');
  const after = await snapshot('northwind');
  const second = await runTenant(config, 'northwind');
  expect(second.ingest.flatMap((i) => i.files).map((f) => f.status)).toEqual(Array(20).fill('duplicate'));
  expect(second.stage.reduce((n, s) => n + s.inserted + s.updated, 0)).toBe(0);
  expect(second.marts).toMatchObject({ daysRebuilt: 0, restatements: 0 });
  expect(await snapshot('northwind')).toEqual(after);
});

test('a run that dies mid-file is resumed from the last committed chunk, and ends equal to a clean run (D6)', async () => {
  const failure = await runTenant(config, 'lumen', { crashAfterRows: 500 }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(RunFailed);
  expect((failure as RunFailed).cause).toBeInstanceOf(SimulatedCrash);
  expect(await adminQuery("SELECT path, status, rows_committed FROM raw.file_loads WHERE tenant_id = 'lumen' AND status = 'loading'"))
    .toEqual([{ path: 'lumen/email_events/batch_02.ndjson', status: 'loading', rows_committed: 100 }]);
  expect(await adminQuery("SELECT status FROM ops.runs WHERE tenant_id = 'lumen' ORDER BY id DESC LIMIT 1")).toEqual([{ status: 'failed' }]);

  const recovered = await runTenant(config, 'lumen');
  const b2 = recovered.ingest.flatMap((i) => i.files).find((f) => f.path.endsWith('email_events/batch_02.ndjson'));
  expect(b2).toMatchObject({ status: 'resumed', note: 'resumed from line 100', rowsSeen: 294 });
  const resumed = await snapshot('lumen');

  await resetData();
  await runTenant(config, 'lumen');
  expect(resumed).toEqual(await snapshot('lumen'));
});

test('an overlapping export counts each order once and the day still ties to the finance summary (F2)', async () => {
  const s = await runTenant(config, 'northwind');
  expect(s.stage.find((x) => x.source === 'orders')).toMatchObject({ inserted: 680, unchanged: 14, updated: 0, conflicts: 0 });
  expect(await adminQuery("SELECT count(*)::int AS n FROM raw.records WHERE tenant_id = 'northwind' AND source = 'orders'")).toEqual([{ n: 694 }]);
  expect(await adminQuery("SELECT count(*)::int AS n FROM stg.orders WHERE tenant_id = 'northwind' AND times_seen = 2")).toEqual([{ n: 14 }]);
  expect(await adminQuery("SELECT sum(gross)::text AS gross FROM mart.daily_revenue WHERE tenant_id = 'northwind' AND day = '2026-01-17'"))
    .toEqual([{ gross: '3627.70' }]);   // finance_summary.csv, 2026-01-17, gross_reported
});

test('late records rebuild days that were already built and leave a restatement per moved metric (D5, F3, F4)', async () => {
  const early = await runTenant(config, 'northwind', { batches: '1-4' });
  expect(early.marts?.restatements).toBe(0);
  const before = await adminQuery<Record<string, string>>(
    "SELECT day::text AS day, channel, orders::text, gross::text, refunds::text, net::text FROM mart.daily_revenue WHERE tenant_id = 'northwind'");
  const orphansBefore = early.marts!.orphanRefunds;
  const realOrphansBefore = (await adminQuery<{ n: number }>(
    "SELECT count(*)::int AS n FROM ops.quarantine WHERE tenant_id = 'northwind' AND reason = 'unresolvable_reference' AND ref LIKE 'rf-orphan-%'"))[0]!.n;

  const late = await runTenant(config, 'northwind');   // batch 5 of every source arrives
  expect(late.marts!.restatements).toBeGreaterThan(0);
  const rs = await adminQuery<{ mart: string; day: string; dimension: string; metric: string; previous: string; current: string }>(
    "SELECT mart, day::text AS day, dimension, metric, previous::text, current::text FROM ops.restatements WHERE tenant_id = 'northwind'");

  const revenue = rs.filter((r) => r.mart === 'daily_revenue');
  expect(revenue.length).toBeGreaterThan(0);
  const now = await adminQuery<Record<string, string>>(
    "SELECT day::text AS day, channel, orders::text, gross::text, refunds::text, net::text FROM mart.daily_revenue WHERE tenant_id = 'northwind'");
  for (const r of revenue) {
    // refunds delivered in batches 1-4 for orders that only arrive in batch 5 had built refund-only days: those move too
    const was = before.find((x) => x.day === r.day && x.channel === r.dimension);
    const is = now.find((x) => x.day === r.day && x.channel === r.dimension);
    if (!was) throw new Error(`no previous mart row for restatement ${JSON.stringify(r)}`);
    expect(Number(was[r.metric])).toBe(Number(r.previous));
    if (is) expect(Number(is[r.metric])).toBe(Number(r.current));
    else expect(Number(r.current)).toBe(0);    // the dimension left the day (a refund found its channel): restated to zero and removed
  }
  // refunds that arrived before their order were unattributed and quarantined; once the order lands they are released
  expect(orphansBefore).toBeGreaterThan(realOrphansBefore);                 // some refunds simply beat their order
  expect(late.marts!.orphansResolved).toBe(orphansBefore - realOrphansBefore);
  expect(await adminQuery("SELECT count(*)::int AS n, bool_and(ref LIKE 'rf-orphan-%') AS all_real FROM ops.quarantine WHERE tenant_id = 'northwind' AND reason = 'unresolvable_reference'"))
    .toEqual([{ n: 6, all_real: true }]);
  // the 'unattributed' rows those refunds had built are gone (restated to zero), and every day is complete again
  expect(await adminQuery("SELECT sum(refunds)::text AS refunds FROM mart.daily_revenue WHERE tenant_id = 'northwind' AND channel = 'unattributed'"))
    .toEqual([{ refunds: '1467.86' }]);   // rf-orphan-01..06 only
  expect(await adminQuery("SELECT count(*)::int AS n FROM mart.daily_revenue WHERE tenant_id = 'northwind' AND NOT complete")).toEqual([{ n: 0 }]);
  expect(rs.filter((r) => r.dimension === 'unattributed' && r.current === '0.00').length).toBeGreaterThan(0);

  const emailDays = [...new Set(rs.filter((r) => r.mart === 'daily_email').map((r) => r.day))].sort();
  expect(emailDays.length).toBeGreaterThan(0);
  expect(emailDays[0]! >= '2026-01-12' && emailDays[emailDays.length - 1]! <= '2026-01-17').toBe(true);   // the 24 late events
});

test('tenant isolation is enforced by the database, not by a WHERE clause (D3)', async () => {
  await runTenant(config, 'northwind');
  await runTenant(config, 'lumen');
  const mine = await withTenant('lumen', (tx) => tx.query(
    "SELECT count(*)::int AS n, count(*) FILTER (WHERE tenant_id <> 'lumen')::int AS other_tenant FROM stg.orders"));
  expect(mine.rows[0]).toEqual({ n: 662, other_tenant: 0 });
  const views = await withTenant('lumen', (tx) => tx.query("SELECT count(*)::int AS n FROM mart.daily_marketing WHERE tenant_id <> 'lumen'"));
  expect(views.rows[0]).toEqual({ n: 0 });

  const noContext = await appPool().query('SELECT count(*)::int AS n FROM stg.orders');
  expect(noContext.rows[0]).toEqual({ n: 0 });

  await expect(withTenant('lumen', (tx) => tx.query(
    `INSERT INTO stg.orders (tenant_id, order_id, created_at, channel, channel_raw, gross, currency, content_hash, first_file_load_id, last_file_load_id)
     VALUES ('northwind', 'X-1', '2026-01-06T00:00:00Z', 'direct', 'direct', 1, 'USD', 'h', 1, 1)`))).rejects.toThrow(/row-level security/);
  const touched = await withTenant('lumen', (tx) => tx.query("UPDATE stg.orders SET gross = 0 WHERE tenant_id = 'northwind'"));
  expect(touched.rowCount).toBe(0);

  expect(await adminQuery('SELECT count(*)::int AS n FROM stg.orders')).toEqual([{ n: 1342 }]);
});

test('a renamed column is adapted and reported; an unknown header quarantines the file; an unmapped value quarantines the row (D4, F6)', async () => {
  const s = await runTenant(config, 'northwind', { source: 'ad_spend' });
  const versions = Object.fromEntries(s.ingest[0]!.files.map((f) => [path.basename(f.path), f.schemaVersion]));
  expect(versions).toEqual({ 'batch_01.csv': 'v1', 'batch_02.csv': 'v1', 'batch_03.csv': 'v1', 'batch_04.csv': 'spend=cost_usd', 'batch_05.csv': 'spend=cost_usd' });
  const events = await adminQuery<{ kind: string; detail: { field: string; alias: string } }>("SELECT kind, detail FROM ops.schema_events WHERE tenant_id = 'northwind' ORDER BY id");
  expect(events.filter((e) => e.kind === 'alias_used').map((e) => e.detail)).toEqual([{ field: 'spend', alias: 'cost_usd' }, { field: 'spend', alias: 'cost_usd' }]);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtc-fixtures-'));
  fs.cpSync(config.fixturesDir, tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'northwind/ad_spend/batch_06.csv'), 'date,campaign_id,platform,cost\n2026-02-05,cmp_100,facebook,1.00\n');
  fs.writeFileSync(path.join(tmp, 'northwind/ad_spend/batch_07.csv'), 'date,campaign_id,platform,spend\n2026-02-05,cmp_100,facebook,1.00\n2026-02-05,cmp_999,tiktok,2.00\n');
  process.env.DTC_FIXTURES_DIR = tmp;
  try {
    const s2 = await runTenant(loadConfig(), 'northwind', { source: 'ad_spend' });
    const files = Object.fromEntries(s2.ingest[0]!.files.map((f) => [path.basename(f.path), f]));
    expect(files['batch_06.csv']).toMatchObject({ status: 'quarantined', note: 'required fields not found: spend' });
    expect(files['batch_07.csv']).toMatchObject({ status: 'loaded', rowsSeen: 2 });
    expect(s2.stage[0]).toMatchObject({ inserted: 1, quarantined: 1 });
    expect(await adminQuery("SELECT reason, detail->>'value' AS value FROM ops.quarantine WHERE tenant_id = 'northwind' AND source = 'ad_spend'"))
      .toEqual([{ reason: 'unmapped_value', value: 'tiktok' }]);
    expect(await adminQuery("SELECT count(*)::int AS n FROM stg.ad_spend WHERE tenant_id = 'northwind'")).toEqual([{ n: 91 }]);

    // the onboarding fix: add the label to the tenant's map and rerun; the held row is staged and released, nothing else changes
    const fixed = loadConfig();
    fixed.tenants.northwind!.normalize.platform.tiktok = 'paid_social';
    const s3 = await runTenant(fixed, 'northwind', { source: 'ad_spend' });
    expect(s3.stage[0]).toMatchObject({ files: 0, released: 1, inserted: 1, quarantined: 0 });
    expect(await adminQuery("SELECT count(*)::int AS n FROM ops.quarantine WHERE tenant_id = 'northwind' AND source = 'ad_spend'")).toEqual([{ n: 0 }]);
    expect(await adminQuery("SELECT platform, spend::text FROM stg.ad_spend WHERE tenant_id = 'northwind' AND campaign_id = 'cmp_999'"))
      .toEqual([{ platform: 'paid_social', spend: '2.00' }]);
  } finally {
    delete process.env.DTC_FIXTURES_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a batch that never arrived is named, its days carry NULL spend, and orphan refunds are unattributed, not lost (D8, D9, F1, F9)', async () => {
  const s = await runTenant(config, 'lumen');
  expect(s.missingDeliveries).toMatchObject([{ source: 'ad_spend', batch: 3, covers: '2026-01-18 to 2026-01-23' }]);
  expect(s.missingDeliveries![0]!.overdue).toMatch(/^\d+ days$/);   // how long past the window it was meant to cover
  const gap = await withTenant('lumen', (tx) => tx.query<{ day: string; spend: string | null; complete: boolean }>(
    "SELECT day::text AS day, spend, complete FROM mart.daily_marketing WHERE day BETWEEN '2026-01-18' AND '2026-01-23' ORDER BY day"));
  expect(gap.rows).toHaveLength(6);
  expect(gap.rows.every((r) => r.spend === null && r.complete === false)).toBe(true);
  const known = await withTenant('lumen', (tx) => tx.query("SELECT count(*)::int AS n, bool_and(complete) AS complete FROM mart.daily_marketing WHERE day = '2026-01-17'"));
  expect(known.rows[0]).toEqual({ n: 3, complete: true });

  expect(s.marts?.orphanRefunds).toBe(6);
  expect(await adminQuery("SELECT sum(refunds)::text AS refunds FROM mart.daily_revenue WHERE tenant_id = 'lumen' AND channel = 'unattributed'"))
    .toEqual([{ refunds: '1434.06' }]);   // rf-orphan-01..06 in the lumen refund batches
  expect(await adminQuery("SELECT count(*)::int AS n FROM ops.quarantine WHERE tenant_id = 'lumen' AND reason = 'unresolvable_reference'")).toEqual([{ n: 6 }]);
});

test('under late_arrivals: freeze a reported day is never rebuilt; late records post to their arrival day (D18)', async () => {
  const frozen = loadConfig();
  frozen.tenants.northwind!.policies.late_arrivals = 'freeze';
  const early = await runTenant(frozen, 'northwind', { batches: '1-4' });
  expect(early.marts?.restatements).toBe(0);
  const before = await adminQuery<Record<string, string>>(
    "SELECT day::text AS day, channel, orders::text, gross::text, refunds::text, net::text FROM mart.daily_revenue WHERE tenant_id = 'northwind' AND day <= '2026-01-29' ORDER BY day, channel");
  const emailBefore = await adminQuery<Record<string, string>>(
    "SELECT day::text AS day, campaign_id, delivered::text, opens::text FROM mart.daily_email WHERE tenant_id = 'northwind' AND day <= '2026-01-29' ORDER BY day, campaign_id");

  const late = await runTenant(frozen, 'northwind');   // batch 5 arrives: 24 email events for 12-17 Jan, refunds for days already closed
  const today = new Date().toISOString().slice(0, 10);
  expect(late.stage.find((s) => s.source === 'email_events')!.postedLate).toBe(24);
  expect(late.stage.find((s) => s.source === 'refunds')!.postedLate).toBeGreaterThan(0);

  // a closed day (batches 1-4 cover 6 to 29 Jan for every source) never moves; open days may still fill in
  expect(await adminQuery("SELECT count(*)::int AS n FROM ops.restatements WHERE tenant_id = 'northwind' AND day <= '2026-01-29'")).toEqual([{ n: 0 }]);
  expect(await adminQuery("SELECT count(*)::int AS n FROM ops.restatements WHERE tenant_id = 'northwind' AND mart = 'daily_email'")).toEqual([{ n: 0 }]);

  // every closed day is byte-for-byte what it was
  expect(await adminQuery("SELECT day::text AS day, channel, orders::text, gross::text, refunds::text, net::text FROM mart.daily_revenue WHERE tenant_id = 'northwind' AND day <= '2026-01-29' ORDER BY day, channel")).toEqual(before);
  expect(await adminQuery("SELECT day::text AS day, campaign_id, delivered::text, opens::text FROM mart.daily_email WHERE tenant_id = 'northwind' AND day <= '2026-01-29' ORDER BY day, campaign_id")).toEqual(emailBefore);

  // the late records exist, on today's row, and the audit view says where each one came from
  const posted = await adminQuery<{ source: string; n: number; days: number }>(
    "SELECT source, count(*)::int AS n, count(DISTINCT event_day)::int AS days FROM mart.late_postings WHERE tenant_id = 'northwind' GROUP BY source ORDER BY source");
  expect(posted.find((p) => p.source === 'email_events')).toMatchObject({ n: 24, days: 6 });
  expect(await adminQuery(`SELECT bool_and(posting_day = '${today}') AS today, min(event_day)::text AS first, max(event_day)::text AS last FROM mart.late_postings WHERE tenant_id = 'northwind' AND source = 'email_events'`))
    .toEqual([{ today: true, first: '2026-01-12', last: '2026-01-17' }]);
  expect(await adminQuery(`SELECT sum(delivered + opens + clicks + unsubscribes)::int AS events FROM mart.daily_email WHERE tenant_id = 'northwind' AND day = '${today}'`)).toEqual([{ events: 24 }]);

  // the totals are the same under both policies; only the day they sit on differs
  expect(await adminQuery("SELECT sum(net)::text AS net, sum(gross)::text AS gross FROM mart.daily_revenue WHERE tenant_id = 'northwind'")).toEqual([{ net: '75838.14', gross: '79303.38' }]);
});

test('under unknown_schema: fail a file whose header matches no declared field set stops the run, loading nothing from it (D4)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtc-fixtures-'));
  fs.cpSync(config.fixturesDir, tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'northwind/ad_spend/batch_06.csv'), 'date,campaign_id,platform,cost\n2026-02-05,cmp_100,facebook,1.00\n');
  process.env.DTC_FIXTURES_DIR = tmp;
  try {
    const strict = loadConfig();
    strict.tenants.northwind!.policies.unknown_schema = 'fail';
    const failure = await runTenant(strict, 'northwind', { source: 'ad_spend' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RunFailed);
    expect((failure as RunFailed).cause.message).toMatch(/batch_06\.csv: required fields spend not found in columns \[date, campaign_id, platform, cost\] \(policy: fail\)/);
    expect(await adminQuery("SELECT status FROM ops.runs WHERE tenant_id = 'northwind' ORDER BY id DESC LIMIT 1")).toEqual([{ status: 'failed' }]);
    expect(await adminQuery("SELECT count(*)::int AS n FROM raw.file_loads WHERE tenant_id = 'northwind' AND path LIKE '%batch_06%'")).toEqual([{ n: 0 }]);
    expect(await adminQuery("SELECT count(*)::int AS n FROM raw.file_loads WHERE tenant_id = 'northwind' AND status = 'loaded'")).toEqual([{ n: 5 }]);   // the five good files before it
  } finally {
    delete process.env.DTC_FIXTURES_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
