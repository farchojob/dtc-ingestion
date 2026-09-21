#!/usr/bin/env tsx
/** dtc: the command line for the pipeline. Every command is safe to run again. */
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig, parseTenant, requireTenant, REPO_ROOT } from './config.ts';
import { closePools } from './db.ts';
import { migrate } from './migrate.ts';
import { SimulatedCrash } from './ingest.ts';
import { runTenant, RunFailed, type Phases } from './pipeline.ts';
import { checkDeliveries, checkFinance, checkFreshness, tenantStatus } from './checks.ts';
import { formatRunReport, table } from './report.ts';

const program = new Command().name('dtc').description('Ingestion and modelling for DTC brands: raw → staging → marts, per tenant.');

program.command('migrate').description('apply migrations/*.sql (idempotent)').action(async () => {
  const r = await migrate();
  console.log(`applied: ${r.applied.join(', ') || 'nothing'}${r.skipped.length ? ` · already applied: ${r.skipped.join(', ')}` : ''}`);
});

const tenant = program.command('tenant').description('tenant configuration');
tenant.command('validate <file>').description('validate a tenant YAML against the schema and the declared sources').action((file: string) => {
  const config = loadConfig();
  const t = parseTenant(resolveUserPath(file), config.sources);
  console.log(`ok: tenant "${t.id}" (${t.display_name}, ${t.currency}), sources: ${Object.keys(t.sources).join(', ')}`);
});

/** A path typed by the user resolves from where they ran `npm run`, not from the workspace the script lives in. */
function resolveUserPath(file: string): string {
  if (path.isAbsolute(file)) return file;
  for (const base of [process.env.INIT_CWD, process.cwd(), REPO_ROOT]) {
    if (base && fs.existsSync(path.resolve(base, file))) return path.resolve(base, file);
  }
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
}
tenant.command('list').description('tenants the config knows about').action(() => {
  const config = loadConfig();
  console.log(table(Object.values(config.tenants).map((t) => ({ id: t.id, name: t.display_name, currency: t.currency, sources: Object.keys(t.sources).join(', ') }))));
});

interface RunOpts { tenant: string; source?: string; crashAfterRows?: string; skipMarts?: boolean; only?: string; batches?: string }

async function runPipeline(opts: RunOpts, phases: Phases): Promise<void> {
  const config = loadConfig();
  try {
    const stats = await runTenant(config, opts.tenant, {
      source: opts.source, only: opts.only, batches: opts.batches, skipMarts: opts.skipMarts,
      crashAfterRows: opts.crashAfterRows === undefined ? undefined : Number(opts.crashAfterRows),
    }, phases);
    console.log(formatRunReport(stats));
  } catch (err) {
    if (!(err instanceof RunFailed)) throw err;
    console.log(formatRunReport(err.stats));
    console.error(`\nrun #${err.stats.runId} FAILED: ${err.cause.message}`);
    process.exitCode = 1;
    if (!(err.cause instanceof SimulatedCrash)) throw err.cause;
  }
}

const runOptions = (c: Command) => c
  .requiredOption('-t, --tenant <id>', 'tenant id (config/tenants/<id>.yaml)')
  .option('-s, --source <name>', 'only this source')
  .option('--only <path>', 'only this file (path relative to the fixtures dir)')
  .option('--batches <spec>', 'only these batch numbers, e.g. 1-4 or 2,5 (to replay arrivals in order)')
  .option('--crash-after-rows <n>', 'simulate a process that dies after n rows (for replay tests)')
  .option('--skip-marts', 'do not rebuild marts');

runOptions(program.command('run').description('ingest → stage → marts for one tenant, then the delivery check'))
  .action((opts: RunOpts) => runPipeline(opts, { ingest: true, stage: true, marts: true }));
runOptions(program.command('ingest').description('files into raw storage only'))
  .action((opts: RunOpts) => runPipeline(opts, { ingest: true, stage: false, marts: false }));
runOptions(program.command('stage').description('raw into staging only'))
  .action((opts: RunOpts) => runPipeline(opts, { ingest: false, stage: true, marts: false }));
runOptions(program.command('marts').description('rebuild dirty days only'))
  .action((opts: RunOpts) => runPipeline(opts, { ingest: false, stage: false, marts: true }));

const check = program.command('check').description('checks that say what did not happen');
check.command('deliveries').description('every batch the manifest promises vs what loaded; exit 1 if any is missing')
  .option('-t, --tenant <id>').action(async (opts: { tenant?: string }) => {
    const config = loadConfig();
    const r = await checkDeliveries(config, opts.tenant ? [opts.tenant] : undefined);
    console.log(table(r.rows.map((x) => ({ tenant: x.tenant, source: x.source, batch: x.batch, covers: x.covers, status: x.status, rows: x.rows ?? '', schema: x.schema ?? '',
      overdue: x.overdue_days === null ? '' : `${x.overdue_days} days`, expected_path: x.expected_path }))));
    console.log(`\n${r.rows.length} expected · ${r.rows.length - r.notLoaded} loaded · ${r.missing} missing`);
    if (r.missing) process.exitCode = 1;
  });
check.command('freshness').description('per source: the last day a loaded delivery covers vs the last day promised; exit 1 if any source is behind')
  .option('-t, --tenant <id>').action(async (opts: { tenant?: string }) => {
    const config = loadConfig();
    const rows = await checkFreshness(config, opts.tenant ? [opts.tenant] : undefined);
    console.log(table(rows.map((x) => ({ tenant: x.tenant, source: x.source, last_covered: x.last_covered ?? 'nothing loaded', expected_through: x.expected_through,
      behind: x.stale_days ? `${x.stale_days} days` : 'current', missing_batches: x.missing }))));
    if (rows.some((x) => x.missing > 0)) process.exitCode = 1;
  });

program.command('status').description('one line per tenant: last run, deliveries, restatements, holds, incomplete days, revenue')
  .option('-t, --tenant <id>').action(async (opts: { tenant?: string }) => {
    const config = loadConfig();
    const ids = opts.tenant ? [opts.tenant] : Object.keys(config.tenants);
    const rows = [];
    for (const id of ids) {
      const s = await tenantStatus(config, requireTenant(config, id));
      rows.push({
        tenant: s.tenant, currency: s.currency, last_run: s.last_run ? `#${s.last_run.id} ${s.last_run.status}` : 'never',
        deliveries: `${s.deliveries.loaded}/${s.deliveries.expected}${s.deliveries.missing ? ` (${s.deliveries.missing} missing)` : ''}`,
        restatements: s.restatements, held: s.held, incomplete_days: s.incomplete_days, late_postings: s.late_postings,
        days: s.days, net: s.net, gross: s.gross, refunds: s.refunds,
      });
    }
    console.log(table(rows));
  });
check.command('finance').description("the client's finance_summary.csv against the marts")
  .requiredOption('-t, --tenant <id>').action(async (opts: { tenant: string }) => {
    const config = loadConfig();
    const t = requireTenant(config, opts.tenant);
    const r = await checkFinance(config, t);
    console.log(table(r.lines.map((l) => ({ ...l }))));
    console.log(`\ngross ties on ${r.gross_ties} of ${r.days} days · finance file says ${r.finance_currency}, tenant is ${r.tenant_currency}`);
    if (r.finance_currency !== r.tenant_currency) console.log('currency label does not match the tenant currency: a question for the client, not a conversion');
  });

program.parseAsync(process.argv)
  .catch((err: Error) => { console.error(`error: ${err.message}`); process.exitCode = 1; })
  .finally(() => closePools());
