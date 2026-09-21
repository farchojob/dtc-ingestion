# Plan: eight hours, two things done properly

Written before the first line of pipeline code, after profiling the fixtures (see `FINDINGS.md`). This is the plan I am holding myself to; `../TRADEOFFS.md` at the end says how it went.

## What gets done properly

1. Ingestion with real replay. Idempotent at the file level (content hash) and at the record level (natural key per source). A run that dies a third of the way through is resumed, not repeated. A file that arrives twice is recognised, not reloaded. The overlapping export in the fixtures counts once. Late records for days already built rebuild those days and leave an audit row saying what changed and why.
2. Tenant as configuration, isolation enforced by the database. Every table carries `tenant_id`; Postgres row-level security is on and forced; the application role cannot bypass it; the only way to run a query is inside `withTenant(id, fn)`, which sets the tenant for the transaction. No branch on a tenant name anywhere in the code. A third client is one YAML file.

## What gets sketched

- Marketing and email marts as thin views over staging.
- No attribution between email campaigns and ad spend: the ids do not join (F10) and inventing a mapping would be a guess dressed as a feature.
- A read-only console (Next.js) that shows deliveries, runs, restatements, quarantine and daily revenue per tenant. It exists to make the demo legible, not to earn points on its own; it reads through the same tenant-scoped connection as everything else.

## Architecture

```
fixtures/<tenant>/<source>/batch_NN.*   (csv | ndjson)
        │
        ▼  ingest: hash file, register load, stream rows in chunks → raw.records (JSONB)
      raw ──▶ stage: map columns by config (aliases = declared drift), normalise, validate,
        │            upsert by natural key → stg.<source>; unknown shapes → ops.quarantine
        ▼
      stg ──▶ marts: rebuild only the (tenant, day) pairs touched since the last build;
        │            a day that already had numbers keeps its previous version in ops.restatements
        ▼
     mart.daily_revenue (day × channel)  ·  mart.daily_marketing  ·  mart.daily_email
```

Operational tables: `ops.runs`, `raw.file_loads`, `ops.expected_deliveries` (the manifest, loaded), `ops.dirty_days`, `ops.restatements`, `ops.quarantine`, `ops.schema_events`.

## How each fixture failure is handled

| Failure (FINDINGS) | Mechanism | Outcome |
|---|---|---|
| F2 overlapping export | upsert by `(tenant_id, order_id)`; raw keeps both copies | counted once; run report shows re-delivered rows |
| same file twice | sha256 on `raw.file_loads` | second load is a no-op marked `duplicate_delivery` |
| a run dies mid-file | `--crash-after-rows N` reproduces it; chunked transactions; `(file_load_id, line_no)` unique | rerun resumes; a test asserts the counts equal a clean run |
| F6 column rename | alias declared in the source config; unknown header set → quarantine; every alias hit is logged as a schema event | adapt what is declared, quarantine what is not, always say so |
| F3/F8 late events | both timestamp formats parse; upsert by `event_id`; touched days marked dirty | affected days rebuilt; previous numbers kept in `ops.restatements` with the causing file |
| F1 missing batch | `ops.expected_deliveries` vs `raw.file_loads` | `check deliveries` fails and names the batch; spend for those days is NULL with `complete = false`, never 0 |
| F9 orphan refunds | quarantine with reason `unresolvable_reference` | excluded from channel figures; reported as an unattributed line; a question for the client |
| F4 refund windows | windows drive expectations only, never filtering | a refund lands on its `refunded_at` day |
| F7/F11 casing and taxonomy | per-tenant normalisers in config | one canonical channel and event vocabulary |
| F10 campaign ids | `campaign_map` in tenant config, empty by default | no join until the client supplies the map |
| F13/F14 finance file | `check finance` compares marts to `finance_summary.csv` | gross ties; currency label and `net_reported` are questions |

## Stack

Node 20+, npm workspaces (`packages/pipeline`, `apps/console`), TypeScript, `pg` with plain SQL migrations and a small runner, `zod` for configuration, `yaml`, `csv-parse`, `commander`, `vitest` against the docker Postgres. No ORM: every query is readable and defensible live.

## Timeline

| Hour | Work | Commits |
|---|---|---|
| 0 to 1 | profile fixtures, write FINDINGS, PLAN, DECISIONS | docs |
| 1 to 2 | scaffold, docker, migrations with RLS, config loader, tenant YAMLs | scaffold, schema |
| 2 to 4 | raw loader (hash, chunks, crash flag), staging (aliases, normalisers, quarantine) | ingest, stage |
| 4 to 5.5 | daily revenue mart with restatements, delivery check, run report | marts, checks |
| 5.5 to 6.5 | tests: idempotent rerun, crash and resume, overlap, late arrival, isolation | tests |
| 6.5 to 8 | console, README, TRADEOFFS, ONBOARDING, walkthrough | docs, console |

Eight hours is the ceiling. Anything not reached by then is written up as not built, with the reason.
