/**
 * Ingestion: files into raw storage, exactly once, resumable.
 *
 * - A file is identified by its sha256. The same content arriving again (any path) is a duplicate
 *   delivery: counted, never reloaded.
 * - Rows go into raw.records in chunks, each chunk its own transaction, and raw.file_loads keeps
 *   rows_committed. A load that dies mid-file is resumed from that line on the next run; the
 *   primary key (file_load_id, line_no) makes a re-read of an already committed row a no-op.
 * - The file's columns are matched against the source's declared names before any row is read.
 *   A declared alias is adapted and recorded as a schema event; a required field with no column
 *   quarantines the file (or fails the run, per tenant policy).
 */
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { Tx } from './db.ts';
import { withTenant } from './db.ts';
import type { SourceSpec } from './config.ts';
import { readColumns, readRows, sha256File, type RawRow } from './parse.ts';
import { resolveMapping } from './mapping.ts';
import type { RunCtx } from './run.ts';

const CHUNK = 100;   // rows per transaction; small for the fixtures so a resume point is visible, a knob for real feeds

export class SimulatedCrash extends Error {
  constructor(file: string, rows: number) {
    super(`simulated crash after ${rows} rows of ${file} (the chunk in flight was not committed)`);
  }
}

export interface FileResult {
  path: string;
  status: 'loaded' | 'resumed' | 'duplicate' | 'quarantined' | 'crashed';
  fileLoadId?: number;
  rowsSeen: number;
  rowsInserted: number;
  schemaVersion?: string;
  note?: string;
}

export interface IngestStats {
  source: string;
  files: FileResult[];
  rowsInserted: number;
}

export interface IngestOptions {
  crashAfterRows?: number;   // throw after this many rows in this run; reproduces "a run dies a third of the way through"
  only?: string;             // restrict to one file path (relative to fixtures)
  batches?: string;          // restrict to batch numbers, e.g. "1-4" or "2,5" (parsed from the file name)
  counter?: { rows: number }; // shared across sources so crashAfterRows counts rows of the whole run
}

export function batchAllowed(spec: string | undefined, batch: number | null): boolean {
  if (!spec) return true;
  if (batch === null) return false;
  return spec.split(',').some((part) => {
    const [lo, hi] = part.split('-').map(Number);
    return hi === undefined ? batch === lo : batch >= lo! && batch <= hi;
  });
}

export async function ingestSource(ctx: RunCtx, spec: SourceSpec, opts: IngestOptions = {}): Promise<IngestStats> {
  const src = ctx.tenant.sources[spec.source];
  const stats: IngestStats = { source: spec.source, files: [], rowsInserted: 0 };
  if (!src) return stats;
  const files = (await fg(src.path, { cwd: ctx.config.fixturesDir, absolute: true })).sort();
  const counter = opts.counter ?? { rows: 0 };
  for (const file of files) {
    const rel = path.relative(ctx.config.fixturesDir, file);
    if (opts.only && rel !== opts.only) continue;
    const batchNo = /batch_(\d+)/.exec(path.basename(file))?.[1];
    if (!batchAllowed(opts.batches, batchNo ? Number(batchNo) : null)) continue;
    const result = await ingestFile(ctx, spec, file, rel, () => {
      counter.rows += 1;
      if (opts.crashAfterRows !== undefined && counter.rows > opts.crashAfterRows) throw new SimulatedCrash(rel, opts.crashAfterRows);
    });
    stats.files.push(result);
    stats.rowsInserted += result.rowsInserted;
  }
  return stats;
}

async function ingestFile(ctx: RunCtx, spec: SourceSpec, file: string, rel: string, tick: () => void): Promise<FileResult> {
  const tenantId = ctx.tenant.id;
  const sha = await sha256File(file);
  const size = fs.statSync(file).size;
  const batch = /batch_(\d+)/.exec(path.basename(file))?.[1];

  const existing = await withTenant(tenantId, async (tx) => {
    const r = await tx.query<{ id: string; status: string; rows_committed: number; path: string; loaded_at: Date | null }>(
      'SELECT id, status, rows_committed, path, loaded_at FROM raw.file_loads WHERE tenant_id = $1 AND sha256 = $2', [tenantId, sha]);
    return r.rows[0];
  });

  if (existing && (existing.status === 'loaded' || existing.status === 'quarantined')) {
    await withTenant(tenantId, (tx) => tx.query('UPDATE raw.file_loads SET attempts = attempts + 1, last_seen_at = now() WHERE id = $1', [existing.id]));
    const note = existing.path === rel ? `already ${existing.status}` : `same content as ${existing.path}, already ${existing.status}`;
    return { path: rel, status: 'duplicate', fileLoadId: Number(existing.id), rowsSeen: 0, rowsInserted: 0, note };
  }

  let fileLoadId: number;
  let resumeFrom = 0;
  let resumed = false;
  let schemaVersion: string | undefined;
  if (existing) {
    fileLoadId = Number(existing.id);
    resumeFrom = Number(existing.rows_committed);
    resumed = true;
    await withTenant(tenantId, (tx) => tx.query(
      "UPDATE raw.file_loads SET attempts = attempts + 1, last_seen_at = now(), status = 'loading', run_id = $2 WHERE id = $1", [fileLoadId, ctx.runId]));
  } else {
    const columns = await readColumns(file, spec.format);
    const mapping = resolveMapping(spec, columns);
    schemaVersion = mapping.version;
    const quarantine = mapping.missingRequired.length > 0;
    if (quarantine && ctx.tenant.policies.unknown_schema === 'fail') {
      throw new Error(`${rel}: required fields ${mapping.missingRequired.join(', ')} not found in columns [${columns.join(', ')}] (policy: fail)`);
    }
    fileLoadId = await withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO raw.file_loads (tenant_id, source, path, sha256, byte_size, batch, columns, schema_version, status, quarantine_reason, run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [tenantId, spec.source, rel, sha, size, batch ? Number(batch) : null, columns, mapping.version,
          quarantine ? 'quarantined' : 'loading',
          quarantine ? `required fields not found: ${mapping.missingRequired.join(', ')}` : null, ctx.runId]);
      const id = Number(r.rows[0]!.id);
      await recordSchemaEvents(tx, tenantId, spec.source, id, mapping);
      return id;
    });
    if (quarantine) {
      return { path: rel, status: 'quarantined', fileLoadId, rowsSeen: 0, rowsInserted: 0, schemaVersion, note: `required fields not found: ${mapping.missingRequired.join(', ')}` };
    }
  }

  let buffer: RawRow[] = [];
  let inserted = 0;
  let lastLine = resumeFrom;
  const flush = async () => {
    if (!buffer.length) return;
    const chunk = buffer;
    buffer = [];
    inserted += await withTenant(tenantId, async (tx) => {
      const n = await insertChunk(tx, tenantId, spec.source, fileLoadId, chunk);
      const last = chunk[chunk.length - 1]!.lineNo;
      await tx.query('UPDATE raw.file_loads SET rows_committed = $2, rows_seen = $2 WHERE id = $1', [fileLoadId, last]);
      return n;
    });
    lastLine = chunk[chunk.length - 1]!.lineNo;
  };

  for await (const row of readRows(file, spec.format)) {
    if (row.lineNo <= resumeFrom) continue;
    tick();                                 // may throw SimulatedCrash: the buffered chunk is lost, rows_committed stays
    buffer.push(row);
    if (buffer.length >= CHUNK) await flush();
  }
  await flush();
  await withTenant(tenantId, (tx) => tx.query(
    "UPDATE raw.file_loads SET status = 'loaded', loaded_at = now(), rows_seen = $2 WHERE id = $1", [fileLoadId, lastLine]));
  return {
    path: rel, status: resumed ? 'resumed' : 'loaded', fileLoadId, rowsSeen: lastLine, rowsInserted: inserted, schemaVersion,
    note: resumed ? `resumed from line ${resumeFrom}` : undefined,
  };
}

async function insertChunk(tx: Tx, tenantId: string, source: string, fileLoadId: number, rows: RawRow[]): Promise<number> {
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    const base = i * 5;
    values.push(fileLoadId, tenantId, source, r.lineNo, JSON.stringify(r.error ? { ...r.payload, __error: r.error } : r.payload));
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  });
  const r = await tx.query(
    `INSERT INTO raw.records (file_load_id, tenant_id, source, line_no, payload) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, values);
  return r.rowCount ?? 0;
}

async function recordSchemaEvents(tx: Tx, tenantId: string, source: string, fileLoadId: number, mapping: ReturnType<typeof resolveMapping>): Promise<void> {
  const events: { kind: string; detail: unknown }[] = [];
  for (const a of mapping.aliasesUsed) events.push({ kind: 'alias_used', detail: a });
  if (mapping.unknownColumns.length) events.push({ kind: 'unknown_columns', detail: { columns: mapping.unknownColumns } });
  if (mapping.missingRequired.length) events.push({ kind: 'missing_required', detail: { fields: mapping.missingRequired } });
  for (const e of events) {
    await tx.query('INSERT INTO ops.schema_events (tenant_id, source, file_load_id, kind, detail) VALUES ($1, $2, $3, $4, $5)',
      [tenantId, source, fileLoadId, e.kind, JSON.stringify(e.detail)]);
  }
}
