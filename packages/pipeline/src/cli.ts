#!/usr/bin/env tsx
/** dtc: the command line for the pipeline. Every command is safe to run again. */
import { Command } from 'commander';
import { loadConfig, parseTenant, requireTenant } from './config.ts';
import { closePools } from './db.ts';
import { migrate } from './migrate.ts';
import { registerTenant, startRun, finishRun } from './run.ts';
import { ingestSource, SimulatedCrash, type IngestStats } from './ingest.ts';
import { stageSource, type StageStats } from './stage.ts';
import { buildMarts } from './marts.ts';
import { checkDeliveries, checkFinance } from './checks.ts';
import { formatRunReport, table, type RunStats } from './report.ts';

const program = new Command().name('dtc').description('Ingestion and modelling for DTC brands: raw → staging → marts, per tenant.');

program.command('migrate').description('apply migrations/*.sql (idempotent)').action(async () => {
  const r = await migrate();
  console.log(`applied: ${r.applied.join(', ') || 'nothing'}${r.skipped.length ? ` · already applied: ${r.skipped.join(', ')}` : ''}`);
});

const tenant = program.command('tenant').description('tenant configuration');
tenant.command('validate <file>').description('validate a tenant YAML against the schema and the declared sources').action((file: string) => {
  const config = loadConfig();
  const t = parseTenant(file, config.sources);
  console.log(`ok: tenant "${t.id}" (${t.display_name}, ${t.currency}), sources: ${Object.keys(t.sources).join(', ')}`);
});
tenant.command('list').description('tenants the config knows about').action(() => {
  const config = loadConfig();
  console.log(table(Object.values(config.tenants).map((t) => ({ id: t.id, name: t.display_name, currency: t.currency, sources: Object.keys(t.sources).join(', ') }))));
});

interface RunOpts { tenant: string; source?: string; crashAfterRows?: string; skipMarts?: boolean; only?: string }

async function runPipeline(opts: RunOpts, phases: { ingest: boolean; stage: boolean; marts: boolean }): Promise<void> {
  const started = Date.now();
  const config = loadConfig();
  const t = requireTenant(config, opts.tenant);
  await registerTenant(config, t);
  const runId = await startRun(t, { ...opts, phases });
  const sources = Object.values(config.sources).filter((s) => s.source in t.sources && (!opts.source || s.source === opts.source));
  const stats: RunStats = { tenant: t.id, runId, ingest: [], stage: [], durationMs: 0 };
  try {
    if (phases.ingest) {
      for (const s of sources) {
        const r: IngestStats = await ingestSource({ config, tenant: t, runId }, s, {
          crashAfterRows: opts.crashAfterRows === undefined ? undefined : Number(opts.crashAfterRows), only: opts.only,
        });
        stats.ingest.push(r);
      }
    }
    if (phases.stage) {
      for (const s of sources) {
        const r: StageStats = await stageSource({ config, tenant: t, runId }, s);
        stats.stage.push(r);
      }
    }
    if (phases.marts && !opts.skipMarts) stats.marts = await buildMarts({ config, tenant: t, runId });
    const deliveries = await checkDeliveries(config, [t.id]);
    stats.missingDeliveries = deliveries.rows.filter((d) => d.status === 'missing').map((d) => ({ source: d.source, batch: d.batch, covers: d.covers }));
    stats.durationMs = Date.now() - started;
    await finishRun(t, runId, 'succeeded', stats);
    console.log(formatRunReport(stats));
  } catch (err) {
    stats.durationMs = Date.now() - started;
    await finishRun(t, runId, 'failed', stats, (err as Error).message);
    console.log(formatRunReport(stats));
    if (err instanceof SimulatedCrash) {
      console.error(`\nrun #${runId} FAILED: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

const runOptions = (c: Command) => c
  .requiredOption('-t, --tenant <id>', 'tenant id (config/tenants/<id>.yaml)')
  .option('-s, --source <name>', 'only this source')
  .option('--only <path>', 'only this file (path relative to the fixtures dir)')
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
    console.log(table(r.rows.map((x) => ({ tenant: x.tenant, source: x.source, batch: x.batch, covers: x.covers, status: x.status, rows: x.rows ?? '', schema: x.schema ?? '', expected_path: x.expected_path }))));
    console.log(`\n${r.rows.length} expected · ${r.rows.length - r.notLoaded} loaded · ${r.missing} missing`);
    if (r.missing) process.exitCode = 1;
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
