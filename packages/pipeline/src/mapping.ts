/**
 * Schema resolution: which of a field's declared column names a file actually offers.
 * A declared alias is adapted and reported; a required field with no matching column is the
 * signal to quarantine the file (or fail, per tenant policy). Nothing is guessed from position.
 */
import type { SourceSpec } from './config.ts';

export interface Mapping {
  fields: Record<string, string | null>;    // canonical field -> column present in the file (null: absent)
  missingRequired: string[];
  unknownColumns: string[];
  aliasesUsed: { field: string; alias: string }[];
  version: string;                          // 'v1' when every field uses its first name; else e.g. 'spend=cost_usd'
}

export function resolveMapping(spec: SourceSpec, columns: string[]): Mapping {
  const present = new Set(columns);
  const fields: Record<string, string | null> = {};
  const missingRequired: string[] = [];
  const aliasesUsed: { field: string; alias: string }[] = [];
  const claimed = new Set<string>();
  for (const [name, f] of Object.entries(spec.fields)) {
    const hit = f.from.find((c) => present.has(c)) ?? null;
    fields[name] = hit;
    if (hit) claimed.add(hit);
    if (!hit && f.required) missingRequired.push(name);
    if (hit && hit !== f.from[0]) aliasesUsed.push({ field: name, alias: hit });
  }
  const unknownColumns = columns.filter((c) => !claimed.has(c));
  const version = aliasesUsed.length ? aliasesUsed.map((a) => `${a.field}=${a.alias}`).join(',') : 'v1';
  return { fields, missingRequired, unknownColumns, aliasesUsed, version };
}
