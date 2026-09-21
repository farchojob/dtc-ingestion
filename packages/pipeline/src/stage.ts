/**
 * Staging: raw rows into typed, normalised tables, one row per natural key.
 *
 * - Each loaded file is staged once (raw.file_loads.staged_at) inside one transaction.
 * - A record seen before with the same content only bumps times_seen (the overlapping export).
 * - A record seen before with different content wins as the newer version, and the older one is
 *   kept in ops.conflicts. Nothing is overwritten silently.
 * - A row that cannot be typed, or carries a raw value with no entry in the tenant's normalisation
 *   map, goes to ops.quarantine with the reason and is skipped. The file still completes.
 * - Every inserted or changed row marks its UTC day dirty for the mart build.
 */
import type { Tx } from './db.ts';
import { withTenant } from './db.ts';
import type { SourceSpec, TenantSpec } from './config.ts';
import { coerce, sha256Json, utcDay } from './parse.ts';
import type { RunCtx } from './run.ts';

interface TableSpec { table: string; key: string[]; columns: string[] }

/** The one place that knows the shape of each staging table. Tenant-agnostic. */
const TABLES: Record<string, TableSpec> = {
  orders: { table: 'stg.orders', key: ['order_id'], columns: ['order_id', 'created_at', 'channel', 'channel_raw', 'gross', 'currency', 'customer_email'] },
  email_events: { table: 'stg.email_events', key: ['event_id'], columns: ['event_id', 'occurred_at', 'type', 'email', 'campaign_id'] },
  ad_spend: { table: 'stg.ad_spend', key: ['spend_date', 'campaign_id'], columns: ['spend_date', 'campaign_id', 'platform', 'platform_raw', 'spend', 'currency', 'schema_version'] },
  refunds: { table: 'stg.refunds', key: ['refund_id'], columns: ['refund_id', 'refunded_at', 'order_id', 'amount', 'currency'] },
};

export interface StageStats {
  source: string;
  files: number;
  inserted: number;
  updated: number;
  unchanged: number;
  quarantined: number;
  conflicts: number;
  dirtyDays: number;
}

type Mapped = Record<string, string | null>;
type RowOutcome = { ok: true; row: Mapped; day: string } | { ok: false; reason: string; detail: unknown; ref: string };

export async function stageSource(ctx: RunCtx, spec: SourceSpec): Promise<StageStats> {
  const tenant = ctx.tenant;
  const table = TABLES[spec.source];
  if (!table) throw new Error(`no staging table declared for source ${spec.source}`);
  const stats: StageStats = { source: spec.source, files: 0, inserted: 0, updated: 0, unchanged: 0, quarantined: 0, conflicts: 0, dirtyDays: 0 };
  const pending = await withTenant(tenant.id, async (tx) => (await tx.query<{ id: string; schema_version: string }>(
    "SELECT id, schema_version FROM raw.file_loads WHERE tenant_id = $1 AND source = $2 AND status = 'loaded' AND staged_at IS NULL ORDER BY id",
    [tenant.id, spec.source])).rows);

  for (const file of pending) {
    const fileLoadId = Number(file.id);
    const dirty = new Set<string>();
    await withTenant(tenant.id, async (tx) => {
      const records = (await tx.query<{ line_no: number; payload: Record<string, unknown> }>(
        'SELECT line_no, payload FROM raw.records WHERE file_load_id = $1 ORDER BY line_no', [fileLoadId])).rows;
      const existing = await existingHashes(tx, tenant.id, table);
      for (const rec of records) {
        const outcome = mapRow(spec, tenant, file.schema_version, rec.payload, `${fileLoadId}:${rec.line_no}`);
        if (!outcome.ok) {
          await quarantineRow(tx, tenant.id, spec.source, fileLoadId, rec.line_no, outcome.ref, outcome.reason, outcome.detail);
          stats.quarantined += 1;
          continue;
        }
        const key = table.key.map((k) => outcome.row[k]).join('|');
        const hash = sha256Json(table.columns.map((c) => outcome.row[c]));
        const prior = existing.get(key);
        if (prior === undefined) {
          await upsert(tx, tenant.id, table, outcome.row, hash, fileLoadId);
          existing.set(key, hash);
          stats.inserted += 1;
          dirty.add(outcome.day);
        } else if (prior === hash) {
          await touch(tx, tenant.id, table, outcome.row, fileLoadId);
          stats.unchanged += 1;
        } else {
          await recordConflict(tx, tenant.id, spec.source, key, fileLoadId, table, outcome.row);
          await upsert(tx, tenant.id, table, outcome.row, hash, fileLoadId);
          existing.set(key, hash);
          stats.updated += 1;
          stats.conflicts += 1;
          dirty.add(outcome.day);
        }
      }
      for (const day of dirty) {
        await tx.query(
          `INSERT INTO ops.dirty_days (tenant_id, day, sources) VALUES ($1, $2, ARRAY[$3]::text[])
           ON CONFLICT (tenant_id, day) DO UPDATE
           SET sources = (SELECT array_agg(DISTINCT x) FROM unnest(ops.dirty_days.sources || EXCLUDED.sources) AS x), marked_at = now()`,
          [tenant.id, day, spec.source]);
      }
      await tx.query('UPDATE raw.file_loads SET staged_at = now() WHERE id = $1', [fileLoadId]);
    });
    stats.files += 1;
    stats.dirtyDays += dirty.size;
  }
  return stats;
}

/** Apply the source's field specs and the tenant's normalisation to one raw payload. */
export function mapRow(spec: SourceSpec, tenant: TenantSpec, schemaVersion: string, payload: Record<string, unknown>, ref: string): RowOutcome {
  if (typeof payload.__error === 'string') return { ok: false, reason: 'unparseable', detail: { error: payload.__error }, ref };
  const row: Mapped = {};
  for (const [name, f] of Object.entries(spec.fields)) {
    const column = f.from.find((c) => c in payload);
    const rawValue = column === undefined ? undefined : payload[column];
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
      if (f.required) return { ok: false, reason: 'missing_required', detail: { field: name }, ref };
      row[name] = null;
      continue;
    }
    const c = coerce(f.type, rawValue);
    if (!c.ok) return { ok: false, reason: 'bad_value', detail: { field: name, value: String(rawValue), error: c.error }, ref };
    let value = c.value;
    if (f.normalize === 'lowercase') value = value.toLowerCase();
    else if (f.normalize === 'uppercase') value = value.toUpperCase();
    else if (f.normalize) {
      const mapped = tenant.normalize[f.normalize][value.toLowerCase()];
      if (!mapped) return { ok: false, reason: 'unmapped_value', detail: { field: name, value, map: f.normalize }, ref };
      row[`${name}_raw`] = value;
      value = mapped;
    }
    row[name] = value;
  }
  row.currency ??= tenant.currency;         // ad_spend carries no currency column: the tenant's applies
  row.schema_version = schemaVersion;
  const eventTime = row[spec.event_time];
  if (!eventTime) return { ok: false, reason: 'missing_required', detail: { field: spec.event_time }, ref };
  return { ok: true, row, day: utcDay(eventTime) };
}

async function existingHashes(tx: Tx, tenantId: string, table: TableSpec): Promise<Map<string, string>> {
  const keyExpr = table.key.map((k) => `${k}::text`).join(` || '|' || `);
  const r = await tx.query<{ k: string; content_hash: string }>(`SELECT ${keyExpr} AS k, content_hash FROM ${table.table} WHERE tenant_id = $1`, [tenantId]);
  return new Map(r.rows.map((x) => [x.k, x.content_hash]));
}

async function upsert(tx: Tx, tenantId: string, table: TableSpec, row: Mapped, hash: string, fileLoadId: number): Promise<void> {
  const cols = ['tenant_id', ...table.columns, 'content_hash', 'first_file_load_id', 'last_file_load_id'];
  const vals = [tenantId, ...table.columns.map((c) => row[c] ?? null), hash, fileLoadId, fileLoadId];
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const updates = [...table.columns.map((c) => `${c} = EXCLUDED.${c}`), 'content_hash = EXCLUDED.content_hash',
    'last_file_load_id = EXCLUDED.last_file_load_id', `times_seen = ${table.table}.times_seen + 1`, 'updated_at = now()'].join(', ');
  await tx.query(`INSERT INTO ${table.table} (${cols.join(', ')}) VALUES (${placeholders})
                  ON CONFLICT (tenant_id, ${table.key.join(', ')}) DO UPDATE SET ${updates}`, vals);
}

async function touch(tx: Tx, tenantId: string, table: TableSpec, row: Mapped, fileLoadId: number): Promise<void> {
  const where = table.key.map((k, i) => `${k} = $${i + 3}`).join(' AND ');
  await tx.query(`UPDATE ${table.table} SET times_seen = times_seen + 1, last_file_load_id = $2 WHERE tenant_id = $1 AND ${where}`,
    [tenantId, fileLoadId, ...table.key.map((k) => row[k])]);
}

async function recordConflict(tx: Tx, tenantId: string, source: string, key: string, fileLoadId: number, table: TableSpec, incoming: Mapped): Promise<void> {
  const where = table.key.map((k, i) => `${k} = $${i + 2}`).join(' AND ');
  const prev = await tx.query(`SELECT ${table.columns.join(', ')} FROM ${table.table} WHERE tenant_id = $1 AND ${where}`,
    [tenantId, ...table.key.map((k) => incoming[k])]);
  await tx.query('INSERT INTO ops.conflicts (tenant_id, source, natural_key, file_load_id, previous, incoming) VALUES ($1, $2, $3, $4, $5, $6)',
    [tenantId, source, key, fileLoadId, JSON.stringify(prev.rows[0] ?? {}), JSON.stringify(Object.fromEntries(table.columns.map((c) => [c, incoming[c]])))]);
}

async function quarantineRow(tx: Tx, tenantId: string, source: string, fileLoadId: number, lineNo: number, ref: string, reason: string, detail: unknown): Promise<void> {
  await tx.query(
    `INSERT INTO ops.quarantine (tenant_id, source, file_load_id, line_no, ref, reason, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, source, ref, reason) DO NOTHING`,
    [tenantId, source, fileLoadId, lineNo, ref, reason, JSON.stringify(detail)]);
}
