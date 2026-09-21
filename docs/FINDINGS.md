# Findings: what is wrong with the fixtures, measured before building

Two tenants (northwind, lumen), four sources each (orders, email_events, ad_spend, refunds), five batches per source, 6 Jan to 4 Feb 2026, plus a `finance_summary.csv` per tenant with what the client says they earned. The brief names three sources; the fixture set ships four. Everything below was measured with a throwaway profiling script before any pipeline code existed; the numbers are the evidence for the decisions in `DECISIONS.md`.

## Delivery-level failures

| # | Failure | Where | Evidence |
|---|---|---|---|
| F1 | A batch the manifest promises never arrived | `lumen/ad_spend/batch_03.csv` (18 to 23 Jan) | manifest lists 40 batches, 39 files on disk |
| F2 | An export overlaps the previous one | `northwind/orders/batch_03.csv` | 14 rows dated 17 Jan sit inside the 18 to 23 Jan batch, byte-identical to rows in batch_02 (same order_id, timestamp, channel, gross). 694 rows, 680 unique orders |
| F3 | Records for already-processed days arrive later, in a different format | `northwind/email_events/batch_05.ndjson` | 24 events dated 12 to 17 Jan inside the 30 Jan to 4 Feb batch, all with millisecond timestamps (`2026-01-16T21:33:09.534Z`) while the other 1,483 events have none. New event_ids, no logical duplicates |
| F4 | The manifest window means nothing for refunds | all 10 refund batches | batch_01 "covers" 6 to 11 Jan and holds refunds dated up to 9 Feb; neither `refunded_at` nor the order's creation date falls inside the window for most rows |
| F5 | Refunds dated after the period ends | both tenants | `refunded_at` runs to 11 Feb; the period ends 4 Feb |

## Schema and format drift

| # | Failure | Where | Evidence |
|---|---|---|---|
| F6 | A column is renamed mid-series | `ad_spend` batches 4 and 5, both tenants | header `date,campaign_id,platform,spend` becomes `date,campaign_id,platform,cost_usd`. Values stay in the same range, so for lumen (a EUR tenant) a currency change cannot be told apart from a plain rename |
| F7 | Event type casing differs by tenant | `email_events` | northwind emits `open/click/delivered/unsubscribe`, lumen emits `OPEN/CLICK/DELIVERED/UNSUBSCRIBE` |
| F8 | Timestamp format drift | the 24 late events in F3 | `…:09.534Z` vs `…:00Z` |

## Reference and identity failures

| # | Failure | Where | Evidence |
|---|---|---|---|
| F9 | Refunds that point at no order | 6 per tenant | `order_id = NO-00000000` / `LU-00000000`, `refund_id = rf-orphan-01..06`, 95 to 337 each, all stamped at the time of the day's first order |
| F10 | Campaign ids do not join across sources | email_events vs ad_spend | email events use `cmp_100..cmp_111` in both tenants; ad_spend uses `cmp_100..102` (northwind) and `camp-400..402` (lumen); platform labels differ too (`facebook/email` vs `Meta/Newsletter`). At most 3 of 12 email campaigns could ever match spend, and lumen's email campaign ids look like northwind's |
| F11 | Channel taxonomy differs by tenant | orders | `facebook, email, direct, google` vs `Meta, Newsletter, Direct, Google` |

## The client's own numbers

| # | Finding | Evidence |
|---|---|---|
| F12 | `gross_reported` equals the sum of unique orders by UTC day, to the cent, for both tenants | 30 of 30 days tie in each tenant (the overlap in F2 is already deduplicated on the client side) |
| F13 | lumen's finance file says USD; its orders and refunds are EUR | the numbers are identical to the EUR sums, so either the label is wrong or the conversion rate is 1.0 |
| F14 | `net_reported` is not gross minus refunds under any dating | it exceeds gross on 17 of 30 days in both tenants; correlation with refunds by refund date is 0.04 and by order date 0.05; net/gross sits between 0.9755 and 1.0322 in both tenants, the same bounds, which reads as a generated number |

## What is clean

- No malformed JSON, no duplicated `event_id`, no negative or zero amounts, no refund larger than its order, no refund before its order (lag 1 to 9 days, median 4 to 5).
- Order ids increase with time and have no gaps.
- All 24 UTC hours have orders, so days are UTC days and no timezone shift is hiding anywhere.
- `event_id` embeds the epoch second of `occurred_at`; it agrees on all 1,507 northwind events.

## Oddities worth a check, not a fix

- Unsubscribes are as frequent as opens (364 vs 398 in northwind). A real list would be gone in a month.
- Only 29% of order emails appear in the email events at all.
- Refunds are always exactly 50% or 100% of the order.

## Which of these the data can settle

Settled by a rule the pipeline can apply: F2 (dedupe by order_id), F3 and F8 (idempotent by event_id, parse both timestamp formats, rebuild the affected days), F6 (a declared alias; the run still flags it), F7 and F11 (per-tenant normalisation), F4 (ignore the window for filtering; use it only for expectations).

Not settled by the data, and turned into questions or explicit gaps: F1 (the file has to be re-sent; until then those days carry no spend, not zero), F5 (dating policy for refunds after the period), F6 for lumen (is `cost_usd` a currency change?), F9 (what are the orphan refunds?), F10 (which email campaign maps to which spend campaign?), F13 (which currency is the finance file in?), F14 (what is `net_reported`?).
