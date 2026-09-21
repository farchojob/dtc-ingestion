# Decisions

One entry per decision that shaped the code, in the order they were taken. Each says what was chosen, what was rejected, and why. Later entries can supersede earlier ones; superseded entries stay, marked.

## D1. Depth on ingestion and replay, plus enforced tenancy; the rest sketched

Chosen: do two things to the end (idempotent ingestion with replay and restatement; tenant isolation enforced by the database) and sketch the marts beyond daily revenue.
Rejected: a thin slice of everything.
Why: the brief scores depth at 30% and pipeline judgment at 25%, and says outright that five half-built areas lose to two finished ones. Replay is where the fixtures are hardest (F2, F3), and tenancy is where "intended" and "enforced" diverge.

## D2. Plain SQL migrations and `pg`, no ORM

Chosen: numbered `.sql` files applied by a 40-line runner; queries written by hand.
Rejected: Prisma or Drizzle.
Why: the architecture has to be defended live, and row-level security policies, `ON CONFLICT` upserts and `SET LOCAL` are clearer in SQL than behind a query builder. An ORM also adds a generate step to a clean checkout.

## D3. Tenant isolation is row-level security, forced, with a non-bypassing role

Chosen: every table has `tenant_id`; `ENABLE` and `FORCE ROW LEVEL SECURITY`; policy `tenant_id = current_setting('app.tenant_id', true)`; the service connects as a role without `BYPASSRLS`; the only database entry point is `withTenant(tenantId, fn)`, which opens a transaction and runs `SET LOCAL app.tenant_id`.
Rejected: a `WHERE tenant_id = $1` convention; schema per tenant; database per tenant.
Why: a convention is exactly the "intended, not enforced" the brief warns about; one forgotten predicate leaks. A schema or database per tenant makes the third client a provisioning job instead of a config file. With RLS a query with no tenant context returns nothing and an insert for another tenant is refused, and a test proves both.

## D4. Sources and tenants are configuration; drift is a declared alias

Chosen: `config/sources/<source>.yaml` describes each source once (format, natural key, event time, fields with the list of accepted column names); `config/tenants/<tenant>.yaml` adds what differs per client (currency, paths, channel map, event-type normalisation, campaign map, expected deliveries). Both validated with zod at startup.
Rejected: per-tenant code paths; auto-detecting renames by position or fuzzy matching.
Why: a rename that is declared (`spend` or `cost_usd`) is adapted and logged as a schema event; a header set that matches no declared version is quarantined with the file named. Guessing a mapping would be silent adaptation, which is the one outcome the brief says is wrong.

## D5. Late arrivals restate the day, with an audit trail

Chosen: a record for a day that was already built marks the day dirty; the next mart build rewrites the day and inserts the previous numbers into `ops.restatements` with the run and file that caused the change.
Rejected: freezing reported days and booking late records on the day they arrived.
Why: these are analytics marts, not a ledger. A client comparing two exports wants the day to be right and wants to know it moved; the restatement row gives both. The freeze policy is the right one for a general ledger and is noted in TRADEOFFS as the alternative a finance team might ask for; making it a per-tenant policy flag is a config change, not a fork.

## D6. Replay is resumable at the row, idempotent at the record

Chosen: a file is identified by sha256; a load streams rows in chunks, each chunk a transaction, into `raw.records` with `(file_load_id, line_no)` unique; staging upserts by the source's natural key; a load interrupted mid-file is resumed from the last committed line. A `--crash-after-rows` flag exists so the failure is reproducible in a test, not hypothetical.
Rejected: load the whole file in one transaction (all or nothing).
Why: all-or-nothing is simpler and would also be correct for these file sizes, but it does not scale past memory and it hides the interesting part of the problem; the row-level design is what a real feed needs and it is small enough to build in the time.

## D7. Refunds are ingested as a fourth source

Chosen: `refunds` goes through the same generic path as the three sources the brief names.
Rejected: ignoring it because the brief says three.
Why: net revenue does not exist without refunds, the fixtures ship them, and adding a source through configuration is the same property the brief asks for tenants. Cost: one YAML and one staging table.

## D8. A missing batch produces NULL, never zero

Chosen: days whose expected delivery is missing (lumen ad_spend batch 3) carry `spend = NULL` and `complete = false` in the marts, and `check deliveries` exits non-zero naming the batch.
Rejected: zero-filling.
Why: zero spend with real revenue reads as infinite ROAS. NULL with a flag is what actually happened: nothing arrived.

## D9. Orphan refunds are quarantined and reported unattributed, not dropped and not guessed

Chosen: refunds whose `order_id` does not resolve go to `ops.quarantine` with reason `unresolvable_reference`; the tenant-level net includes them as an `unattributed` line; channel-level figures exclude them.
Rejected: dropping them (understates refunds by 5 to 6% per tenant) or spreading them pro rata over channels (a guess).
Why: the number the client sees stays honest at the total and clean at the channel, and the question of what those refunds are goes to the client with the six ids attached.

## D10. No attribution between email events and ad spend

Chosen: the marts keep email metrics by email campaign and spend by ad campaign; `campaign_map` in the tenant config is empty.
Rejected: matching `cmp_101` to `cmp_101` where the ids happen to coincide.
Why: 3 of 12 email campaigns share an id string with a spend campaign in northwind and none in lumen; lumen's email campaigns carry northwind-looking ids. A coincidence of strings is not a join key. The day the client provides the map, it is configuration.

## D11. A read-only console, to make the demo legible

Chosen: a small Next.js app that reads runs, deliveries, restatements, quarantine and daily revenue through the same `withTenant` helper.
Rejected: a console that triggers ingestion; or no console.
Why: the brief asks for a recorded demo of what works; a screen that shows a restatement row appearing after a late batch says more in ten seconds than a terminal. Triggering runs from a browser adds auth and job control that are out of scope. Time-boxed to one hour; if it overruns, it is cut and the CLI carries the demo.

## D12. npm workspaces, Node 20+, Docker only for Postgres

Chosen: one `npm install` at the root; `docker compose up -d` for Postgres 16; everything else is `npm run <script>`.
Rejected: pnpm or bun (one more tool to install on a clean machine); running Postgres outside Docker.
Why: the evaluators will run it from a clean checkout; the fewer prerequisites, the better.

## D13. A refund that arrives before its order is unattributed, then moves

Taken while building. Refund batches are not ordered by anything useful (F4), so in a batch-by-batch replay a refund can land before the order it belongs to. Chosen: it counts under `unattributed` for its day and is quarantined as `unresolvable_reference`; when the order arrives, the next rebuild re-attributes it to the order's channel, records the restatement, and releases the quarantine entry. Rejected: holding the refund out of the marts until the order shows up (the tenant total would be wrong in the meantime) or attributing it to the order's channel retroactively without a restatement row (the number would move without a trace). The six placeholder refunds (`rf-orphan-*`) never resolve and stay quarantined, which is the point: they are the ones to ask the client about.

## D14. Email metrics are a stored mart, not a view

Taken after the first end-to-end run. The 24 late events in northwind's batch 5 (F3) are the fixture's designed late-arrival case, and with `daily_email` as a view they would have changed the numbers silently. Chosen: `mart.daily_email` is a table rebuilt per dirty day with the same restatement mechanism as revenue. `daily_marketing` stays a view because spend has no derived metric to restate yet, and because as a view it can generate the NULL rows for days whose batch never arrived (D8). Cost: one migration and forty lines; the two stored marts share one rebuild function.

## D15. Commit chunks of 100 rows

The fixtures are small enough that a 500-row chunk commits most files whole, which makes a resumed load look like a restart. 100 keeps the resume point visible (the crash test resumes batch_02 from line 100) at no cost here. For a real feed this is a tuning knob, not a design choice.
