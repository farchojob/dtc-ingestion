/**
 * Configuration: what a source looks like (config/sources/*.yaml) and what differs per tenant
 * (config/tenants/*.yaml). Both are validated with zod at load time, so a typo in a YAML fails
 * before any file is touched. There is no per-tenant code anywhere else in the pipeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';
import dotenv from 'dotenv';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

export const CANONICAL_CHANNELS = ['paid_social', 'paid_search', 'email', 'direct', 'affiliate', 'other'] as const;
export const CANONICAL_EVENT_TYPES = ['delivered', 'open', 'click', 'unsubscribe', 'bounce'] as const;

const FieldSchema = z.object({
  from: z.array(z.string().min(1)).min(1),
  type: z.enum(['string', 'timestamp', 'date', 'money']),
  required: z.boolean().default(false),
  normalize: z.enum(['lowercase', 'uppercase', 'channel', 'platform', 'event_type']).optional(),
}).strict();

const SourceSchema = z.object({
  source: z.string().regex(/^[a-z_]+$/),
  format: z.enum(['csv', 'ndjson']),
  natural_key: z.array(z.string()).min(1),
  event_time: z.string(),
  fields: z.record(FieldSchema),
}).strict().superRefine((s, ctx) => {
  for (const k of [...s.natural_key, s.event_time]) {
    if (!(k in s.fields)) ctx.addIssue({ code: 'custom', message: `field "${k}" is named but not declared in fields` });
  }
});

const lowerKeys = z.record(z.string()).refine(
  (m) => Object.keys(m).every((k) => k === k.toLowerCase()),
  { message: 'normalize keys must be lowercase (raw values are lowercased before lookup)' },
);

const TenantSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/, 'lowercase letters, digits, - or _'),
  display_name: z.string().min(1),
  currency: z.string().length(3).toUpperCase(),
  sources: z.record(z.object({ path: z.string().min(1) }).strict()),
  normalize: z.object({
    channel: lowerKeys.refine((m) => Object.values(m).every((v) => (CANONICAL_CHANNELS as readonly string[]).includes(v)),
      { message: `channel values must be one of ${CANONICAL_CHANNELS.join(', ')}` }),
    platform: lowerKeys.refine((m) => Object.values(m).every((v) => (CANONICAL_CHANNELS as readonly string[]).includes(v)),
      { message: `platform values must be one of ${CANONICAL_CHANNELS.join(', ')}` }),
    event_type: lowerKeys.refine((m) => Object.values(m).every((v) => (CANONICAL_EVENT_TYPES as readonly string[]).includes(v)),
      { message: `event_type values must be one of ${CANONICAL_EVENT_TYPES.join(', ')}` }),
  }).strict(),
  campaign_map: z.record(z.string()).default({}),
  expected_deliveries: z.object({ manifest: z.string() }).strict().optional(),
  policies: z.object({
    late_arrivals: z.enum(['restate']),
    unknown_schema: z.enum(['quarantine', 'fail']),
  }).strict(),
}).strict();

export type FieldSpec = z.infer<typeof FieldSchema>;
export type SourceSpec = z.infer<typeof SourceSchema>;
export type TenantSpec = z.infer<typeof TenantSchema>;

export interface Config {
  configDir: string;
  fixturesDir: string;
  sources: Record<string, SourceSpec>;
  tenants: Record<string, TenantSpec>;
}

function readYaml(file: string): unknown {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

export function parseTenant(file: string, knownSources: Record<string, SourceSpec>): TenantSpec {
  const parsed = TenantSchema.safeParse(readYaml(file));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`invalid tenant config ${file}:\n${issues}`);
  }
  const t = parsed.data;
  const unknown = Object.keys(t.sources).filter((s) => !(s in knownSources));
  if (unknown.length) throw new Error(`invalid tenant config ${file}: unknown sources ${unknown.join(', ')} (declared sources: ${Object.keys(knownSources).join(', ')})`);
  return t;
}

export function loadConfig(): Config {
  const configDir = path.resolve(REPO_ROOT, process.env.DTC_CONFIG_DIR ?? 'config');
  const fixturesDir = path.resolve(REPO_ROOT, process.env.DTC_FIXTURES_DIR ?? 'fixtures');
  const sources: Record<string, SourceSpec> = {};
  for (const f of fs.readdirSync(path.join(configDir, 'sources')).filter((f) => f.endsWith('.yaml')).sort()) {
    const parsed = SourceSchema.safeParse(readYaml(path.join(configDir, 'sources', f)));
    if (!parsed.success) throw new Error(`invalid source config ${f}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    sources[parsed.data.source] = parsed.data;
  }
  const tenants: Record<string, TenantSpec> = {};
  for (const f of fs.readdirSync(path.join(configDir, 'tenants')).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')).sort()) {
    const t = parseTenant(path.join(configDir, 'tenants', f), sources);
    tenants[t.id] = t;
  }
  return { configDir, fixturesDir, sources, tenants };
}

/** A stable hash of a tenant's config, stored in ops.tenants so a run can be tied to the config it ran under. */
export function tenantConfigHash(t: TenantSpec): string {
  return crypto.createHash('sha256').update(JSON.stringify(t)).digest('hex').slice(0, 16);
}

export function requireTenant(config: Config, id: string): TenantSpec {
  const t = config.tenants[id];
  if (!t) throw new Error(`unknown tenant "${id}" (configured: ${Object.keys(config.tenants).join(', ')})`);
  return t;
}
