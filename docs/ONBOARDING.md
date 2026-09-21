# Onboarding a new client

You have never seen this code. You do not need to. A tenant is one YAML file; the pipeline reads it and does the rest.

## 1. Get their files in

Put the exports under the fixtures directory (or point `DTC_FIXTURES_DIR` at wherever they land), one folder per source:

```
fixtures/acme/orders/batch_01.csv
fixtures/acme/email_events/batch_01.ndjson
fixtures/acme/ad_spend/batch_01.csv
fixtures/acme/refunds/batch_01.csv
```

File names must contain `batch_NN`; the number is how deliveries are matched to the manifest. If the client gives you a manifest of what they will send, add its entries (tenant, source, batch, path, covers_from, covers_to) to `fixtures/manifest.json`; the delivery check uses it to say what never arrived.

## 2. Write the tenant file

```bash
cp config/tenants/_template.yaml config/tenants/acme.yaml
```

Fill in:

| Key | What to put |
|---|---|
| `id` | short, lowercase, stable. It becomes `tenant_id` on every row this client will ever have |
| `currency` | what their orders and refunds are denominated in |
| `sources.*.path` | a glob per source, relative to the fixtures directory. Delete a source they do not send |
| `normalize.channel` | every value their storefront puts in the `channel` column, lowercased, mapped to a canonical channel. If they later invent a new one, rows with it are quarantined and named in the run report; add it here and rerun: the next run retries every held row against the current map, stages the ones that now pass and reports them as `released` |
| `normalize.platform` | same, for the ad platforms |
| `normalize.event_type` | same, for email event types |
| `campaign_map` | leave empty unless the client tells you which email campaign corresponds to which ad campaign |
| `policies.late_arrivals` | `restate` (a late record rebuilds its day and the previous numbers are kept in `ops.restatements`) or `freeze` (a day the manifest says was already delivered never changes; the late record is booked on the day it arrived and listed in `mart.late_postings`). `freeze` needs manifest entries for the source |
| `policies.unknown_schema` | `quarantine` (hold the file, keep going) or `fail` (stop the run) when a file's header matches no declared column names |

Check it before touching the database:

```bash
npm run dtc -- tenant validate config/tenants/acme.yaml
```

The validator rejects unknown keys, non-canonical values and sources that are not declared in `config/sources/`.

## 3. Run

```bash
npm run ingest -- --tenant acme
npm run check:deliveries -- --tenant acme
```

The run report lists every file, its status, the schema version it matched, how many rows were new, what was quarantined and why, and which expected batches never arrived. The console (`npm run console`) shows the same per tenant.

## What you never have to do

- Write code. There is no `if (tenant === ...)` anywhere; grep for it.
- Add tables or migrations. Every table already has `tenant_id`, and row-level security is enabled and forced on all of them, so the new tenant's rows are invisible from any other tenant's context from the first insert.
- Change another tenant's config. Files are independent; a mistake in `acme.yaml` fails validation for acme only.

## If their files look different

- A column with a new name for the same thing (say `amount` instead of `gross`): add the name to that field's `from` list in `config/sources/<source>.yaml`. That is a change to the shared source definition, so tell whoever owns the other tenants; the run report will show `gross=amount` as the schema version for the files that use it.
- A source in a format that is not csv or ndjson: not supported today. See `TRADEOFFS.md`.
- Timestamps that are not ISO-8601 UTC (`2026-01-06T14:07:00Z`): not supported today; rows are quarantined with `bad_value`, never guessed.
