/** Plain-text tables for the terminal. The run report is the thing you look at after a run. */
import type { IngestStats } from './ingest.ts';
import type { StageStats } from './stage.ts';
import type { MartStats } from './marts.ts';

export interface RunStats {
  tenant: string;
  runId: number;
  ingest: IngestStats[];
  stage: StageStats[];
  marts?: MartStats;
  missingDeliveries?: { source: string; batch: number; covers: string; overdue?: string }[];
  durationMs: number;
}

export function table(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return '  (none)';
  const cols = columns ?? Object.keys(rows[0]!);
  const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => '  ' + vals.map((v, i) => v.padEnd(widths[i]!)).join('  ');
  return [line(cols), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join('\n');
}

export function formatRunReport(s: RunStats): string {
  const out: string[] = [];
  out.push(`run #${s.runId} · tenant ${s.tenant} · ${(s.durationMs / 1000).toFixed(1)}s`);
  out.push('', 'files');
  out.push(table(s.ingest.flatMap((i) => i.files.map((f) => ({
    source: i.source, file: f.path, status: f.status, rows: f.rowsSeen || '', inserted: f.rowsInserted || '', schema: f.schemaVersion ?? '', note: f.note ?? '',
  })))));
  out.push('', 'staging');
  out.push(table(s.stage.map((st) => ({
    source: st.source, files: st.files, inserted: st.inserted, unchanged: st.unchanged, updated: st.updated, conflicts: st.conflicts,
    quarantined: st.quarantined, released: st.released, posted_late: st.postedLate, dirty_days: st.dirtyDays,
  }))));
  if (s.marts) {
    out.push('', 'marts');
    out.push(table([{
      days_rebuilt: s.marts.daysRebuilt, rows_written: s.marts.rowsWritten, restatements: s.marts.restatements,
      orphan_refunds: s.marts.orphanRefunds, orphans_resolved: s.marts.orphansResolved, incomplete_days: s.marts.incompleteDays,
    }]));
  }
  if (s.missingDeliveries?.length) {
    out.push('', 'expected but not arrived');
    out.push(table(s.missingDeliveries));
  }
  return out.join('\n');
}
