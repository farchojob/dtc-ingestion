# Tradeoffs

What was prioritised and why, what was deliberately not built, how the third client gets added, what another week would go to, and the hardest thing I hit. The decisions themselves, each with what it rejected, are in `docs/DECISIONS.md`; the measured failures in the fixtures are in `docs/FINDINGS.md`.

## What I prioritised

Two things to the end, both tested against a real Postgres with the real fixtures:

1. Ingestion that survives the ordinary failures, with replay that does not double count. A file is identified by content, so the same export arriving twice is a no-op. Rows commit in chunks and the load records how far it got, so a run that dies mid-file is resumed from the last committed line on the next run (`--crash-after-rows` reproduces the death; the test asserts the resumed run ends identical to a clean one). Records are upserted by their natural key, so the overlapping export in the fixtures (14 rows of batch 2 re-sent in batch 3) counts once. Late records mark their day dirty; the day is rebuilt; every metric that moves is written to `ops.restatements` with the previous value, the new one, the run and the cause. The 24 late email events and the refunds that land in a batch weeks after their day both produce that trail, and the console shows it.
2. Tenancy enforced by the database. Every table carries `tenant_id`; row-level security is enabled and forced; the service and the console connect as a role that cannot bypass it and only ever query inside `withTenant()`. A query with no tenant context returns nothing; an insert for another tenant is refused; a `WHERE tenant_id = 'other'` under one tenant's context touches zero rows. A tenant is a YAML file, and the code has no branch on a tenant name.

I chose these because they are where the fixtures are hardest (F2, F3, F4 in the findings) and where "intended" and "enforced" diverge most quietly. Everything else was built to the point where it is honest, not finished.

## How deep each area went

| Area | Depth | Evidence |
|---|---|---|
| Raw ingestion | finished | file hash, chunked resumable loads, duplicate detection, schema events, file quarantine; test 2 |
| Staging | finished | declared aliases, typing, per-tenant normalisation, row quarantine with reasons, conflicts kept, dirty days; tests 3 and 6 |
| Replay and late arrivals | finished | restatements for two stored marts, dimension removal restated to zero, refunds that beat their order released later; both policies (`restate`, `freeze`) as one per-tenant switch decided at staging time; tests 1, 4 and 8 |
| Tenant isolation | finished | RLS on 15 tables, security_invoker views, one entry point, config-only onboarding; test 5 |
| Missing deliveries | finished | manifest as expectations, `check deliveries` exits non-zero, NULL spend with `complete = false`; test 7 |
| Daily revenue mart | finished | gross by order day, refunds by refund day attributed to the order's channel, unattributed line, completeness flag |
| Daily email mart | finished, thin | counts per campaign per day; no rates, no attribution |
| Marketing mart | a view | spend per campaign per day with completeness; no join to revenue or email (D10) |
| Finance reconciliation | a check | gross ties to the cent on 60 of 60 days; net and currency are questions for the client, not code |
| Schema drift | finished | declared aliases adapted and logged; unknown headers quarantined or, per tenant policy, the run stopped; tests 6 and 9 |
| Console | read-only | five views per tenant; no actions, no auth beyond the database role |
| Scheduling, watching a drop folder, alerting | not built | runs are invoked; the delivery check is the alert, on exit code |

## What I deliberately did not build

- Attribution between email campaigns and ad spend. The ids do not join (`cmp_100..111` in email for both tenants; `cmp_100..102` and `camp-400..402` in spend), and lumen's email campaigns carry northwind-looking ids. Joining on the three strings that happen to coincide would be a guess presented as a feature. `campaign_map` in the tenant config is where the client's answer goes.
- Currency conversion. Each tenant reports in its own currency. Lumen's finance file says USD over EUR figures; that is a question, and converting at a rate I invented would bury it.
- Streaming or incremental staging. Staging loads the tenant's existing keys per file (at most a few thousand rows here) and compares hashes in memory. At real volume that becomes a per-chunk lookup; the shape of the code does not change.
- An ORM, a job queue, an API. None of them would have made the two chosen areas deeper.
- Ingesting `finance_summary.csv`. It is the client's claim about the numbers, not a source of them; it is read by the reconciliation check and nowhere else.

## How the third client gets added

One file: `config/tenants/<id>.yaml`, copied from `_template.yaml`, validated with `npm run dtc -- tenant validate`, then `npm run ingest -- --tenant <id>`. It declares currency, where the files are, how their labels map to the canonical vocabulary, and two policies. No code, no migration, no table. `docs/ONBOARDING.md` is written for someone who has never opened the repo.

Where it is actually enforced rather than intended: the tenant id lands on every row; the policies on 15 tables compare it to the transaction's `app.tenant_id`; the application role has no `BYPASSRLS`; views are `security_invoker`, so they cannot leak either; the test suite proves read, write, no-context and view isolation. A grep for `northwind` or `lumen` in `packages/pipeline/src` returns nothing.

What a new client can break: a raw label not in their normalisation map quarantines those rows (named in the run report) rather than mis-bucketing them; a column name not declared for a source quarantines the file. Both are the intended failure mode. What they cannot do from their own file is affect another tenant.

I did it rather than asserting it. Acme (GBP, its own labels) is commit `7238662`: one YAML, its files, eight manifest entries, no code. The first run held 12 spend rows because I had left `tiktok` out of the platform map; fixing the map and rerunning released them, and two `Pinterest` orders stay held because nobody has said what Pinterest is. Following my own onboarding guide exposed two defects I would not have found otherwise (rerunning after a config fix did not retry quarantined rows; the validator resolved paths from the wrong directory), both fixed in `39c5f5d` with a test.

## With another week

1. A `freeze` variant that also freezes the channel split of refunds resolved later (today the hold is released but the day is left alone), and a per-source policy where a tenant wants orders restated but spend frozen.
2. Turn the delivery check into freshness monitoring: expected cadence per source, hours since the last file, an alert when a day closes without its batch, and the console showing it.
3. Attribution once the client supplies the campaign map, and ROAS in the marketing mart with the completeness flag propagated (NULL spend stays NULL through the ratio).
4. Staging at volume: per-chunk existence checks, `COPY` into raw, an index on `(tenant_id, day)` for the marts, and a benchmark on a million-row month.
5. A restatement report for the client: per day, what moved, by how much, caused by which file, so a number they already used in a meeting comes with its correction attached.
6. Ask the client the seven questions in `docs/FINDINGS.md` (what the refund batch windows mean, what the six placeholder refunds are, whether `cost_usd` is a currency change for a EUR tenant, which campaign is which, what `net_reported` is, and why lumen's finance file says USD) and turn each answer into config or a one-line change.

## The hardest thing I hit

Refunds arrive in batches whose windows mean nothing (a batch "covering" 6 to 11 January holds refunds dated in February), so in a batch-by-batch replay a refund can land before the order it belongs to. My first version handled the obvious half: the refund counts as `unattributed` and is quarantined until the order shows up. The replay test then exposed three things in sequence. The quarantine entry stayed after the order arrived (fixed: released on the next rebuild). The `unattributed` row stayed in the mart next to the newly attributed one and double counted 358.96 of refunds (fixed: a dimension that leaves a day is removed and every metric restated to zero). And the refund's own day was never rebuilt, because the order's arrival dirties the order's day, not the refund's (fixed: releasing a refund dirties the day it was refunded on). None of the three would have shown up with a single full run; they only appear when deliveries are replayed in the order they actually arrive, which is why `--batches` exists and why the test replays 1 to 4 and then 5.

## Time

About seven and a half hours, in this order: one hour profiling the fixtures and writing the plan and the decisions before any code; two and a half on ingestion, staging and the migration; one and a half on marts, checks and the replay bugs above; one on tests; one on the console; the rest on this write-up. The console was time-boxed to an hour and stayed inside it because it only reads; it later got a separate design pass (tokens, two themes, a delivery matrix, grouped restatements) that touched no pipeline code. I stopped with the marketing side thin on purpose: the brief said depth beats breadth, and the replay bugs were worth more than a ROAS column.
