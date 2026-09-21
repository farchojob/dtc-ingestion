/** File reading and value coercion. No business rules here: those live in config and stage.ts. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { parse as csvParse } from 'csv-parse';

export type Format = 'csv' | 'ndjson';

export interface RawRow {
  lineNo: number;                       // 1-based data line (header excluded for csv)
  payload: Record<string, unknown>;
  error?: string;                       // set when the line could not be parsed at all
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

export function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** The column names a file offers: the csv header, or the keys of the first ndjson object. */
export async function readColumns(file: string, format: Format): Promise<string[]> {
  for await (const row of readRows(file, format)) {
    if (row.error) continue;
    return Object.keys(row.payload);
  }
  return [];
}

export async function* readRows(file: string, format: Format): AsyncGenerator<RawRow> {
  if (format === 'csv') {
    const parser = fs.createReadStream(file).pipe(csvParse({ columns: true, bom: true, skip_empty_lines: true, relax_column_count: true }));
    let lineNo = 0;
    for await (const record of parser) {
      lineNo += 1;
      yield { lineNo, payload: record as Record<string, unknown> };
    }
    return;
  }
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    lineNo += 1;
    try {
      const parsed = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        yield { lineNo, payload: { __raw: line }, error: 'line is not a JSON object' };
      } else {
        yield { lineNo, payload: parsed as Record<string, unknown> };
      }
    } catch (err) {
      yield { lineNo, payload: { __raw: line }, error: `invalid JSON: ${(err as Error).message}` };
    }
  }
}

export type Coerced = { ok: true; value: string } | { ok: false; error: string };

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,6})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^-?\d+(\.\d{1,2})?$/;

/** Turn a raw value into the canonical string form the staging tables store. */
export function coerce(type: 'string' | 'timestamp' | 'date' | 'money', raw: unknown): Coerced {
  if (raw === undefined || raw === null) return { ok: false, error: 'missing' };
  const s = String(raw).trim();
  if (s === '') return { ok: false, error: 'empty' };
  switch (type) {
    case 'string':
      return { ok: true, value: s };
    case 'timestamp': {
      // Accepts both "2026-01-16T21:33:00Z" and "2026-01-16T21:33:09.534Z"; anything else is a bad value, not a guess.
      const m = TIMESTAMP.exec(s);
      if (!m || Number.isNaN(Date.parse(s))) return { ok: false, error: `not an ISO-8601 UTC timestamp: ${s}` };
      return { ok: true, value: s };
    }
    case 'date':
      if (!DATE.test(s) || Number.isNaN(Date.parse(s))) return { ok: false, error: `not a YYYY-MM-DD date: ${s}` };
      return { ok: true, value: s };
    case 'money':
      if (!MONEY.test(s)) return { ok: false, error: `not a money amount: ${s}` };
      return { ok: true, value: Number(s).toFixed(2) };
  }
}

/** The UTC calendar day of a timestamp or date string. */
export function utcDay(value: string): string {
  return value.slice(0, 10);
}
