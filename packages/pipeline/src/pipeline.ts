/** One tenant, one run: ingest → stage → marts → delivery check, recorded in ops.runs. Used by the CLI and the tests. */
import type { Config } from './config.ts';
import { requireTenant } from './config.ts';
import { registerTenant, startRun, finishRun } from './run.ts';
import { ingestSource } from './ingest.ts';
import { stageSource } from './stage.ts';
import { buildMarts } from './marts.ts';
import { checkDeliveries } from './checks.ts';
import type { RunStats } from './report.ts';

export interface RunOptions {
  source?: string;
  only?: string;
  batches?: string;
  crashAfterRows?: number;
  skipMarts?: boolean;
}

export interface Phases { ingest: boolean; stage: boolean; marts: boolean }
export const ALL_PHASES: Phases = { ingest: true, stage: true, marts: true };

/** Thrown when a run fails after its ops.runs row was closed; carries the partial stats for the report. */
export class RunFailed extends Error {
  constructor(public readonly stats: RunStats, public readonly cause: Error) {
    super(cause.message);
  }
}

export async function runTenant(config: Config, tenantId: string, opts: RunOptions = {}, phases: Phases = ALL_PHASES): Promise<RunStats> {
  const started = Date.now();
  const t = requireTenant(config, tenantId);
  await registerTenant(config, t);
  const runId = await startRun(t, { ...opts, phases });
  const ctx = { config, tenant: t, runId };
  const sources = Object.values(config.sources).filter((s) => s.source in t.sources && (!opts.source || s.source === opts.source));
  const stats: RunStats = { tenant: t.id, runId, ingest: [], stage: [], durationMs: 0 };
  try {
    if (phases.ingest) {
      const counter = { rows: 0 };
      for (const s of sources) stats.ingest.push(await ingestSource(ctx, s, { crashAfterRows: opts.crashAfterRows, only: opts.only, batches: opts.batches, counter }));
    }
    if (phases.stage) {
      for (const s of sources) stats.stage.push(await stageSource(ctx, s));
    }
    if (phases.marts && !opts.skipMarts) stats.marts = await buildMarts(ctx);
    const deliveries = await checkDeliveries(config, [t.id]);
    stats.missingDeliveries = deliveries.rows.filter((d) => d.status === 'missing').map((d) => ({ source: d.source, batch: d.batch, covers: d.covers }));
    stats.durationMs = Date.now() - started;
    await finishRun(t, runId, 'succeeded', stats);
    return stats;
  } catch (err) {
    stats.durationMs = Date.now() - started;
    await finishRun(t, runId, 'failed', stats, (err as Error).message);
    throw new RunFailed(stats, err as Error);
  }
}
