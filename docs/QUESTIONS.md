# Questions for the client

Seven things the fixtures cannot settle. Each is written as it would be sent, with what is at stake and what changes when it is answered. Numbers reference `FINDINGS.md`.

**1. The six placeholder refunds.** Each tenant has six refunds (`rf-orphan-01` to `06`) whose `order_id` is `NO-00000000` or `LU-00000000`, worth $1,467.86 (Northwind) and €1,434.06 (Lumen). What are they: goodwill credits, chargebacks, a placeholder your system writes when the order is deleted, or bad exports? Until you say, they count against revenue as "unattributed" and are held in quarantine.
Answer turns into: a channel of their own, an exclusion, or a fix on your side. Config or nothing; no code.

**2. What a refund batch "covers".** Your manifest says refund batch 1 covers 6 to 11 January, but it holds refunds dated up to 9 February for orders placed as late as 3 February. Is the window the day the export was cut, and if so, is the batch every refund issued up to that day or only new ones? We use the window only to know a file is missing; it never filters rows.
Answer turns into: the delivery check can also say "this batch is short", not only "this batch is absent".

**3. `spend` to `cost_usd` on Lumen.** From ad_spend batch 4 the column `spend` is named `cost_usd`. Lumen reports in EUR. Is `cost_usd` a rename, or did the platform start sending USD? The values are in the same range either way, so the file cannot tell us. Today it is treated as a rename and flagged on every affected file.
Answer turns into: a currency on the source config, and a conversion rate we would need from you.

**4. Which email campaign is which ad campaign.** Email events use campaign ids `cmp_100` to `cmp_111` in both brands; ad spend uses `cmp_100` to `cmp_102` (Northwind) and `camp-400` to `camp-402` (Lumen). Nothing joins them, and Lumen's email ids look like Northwind's. Can you give us the mapping, and confirm whose ids Lumen's email platform is emitting?
Answer turns into: `campaign_map` in each tenant's config; attribution appears in the marketing mart with no other change.

**5. Lumen's finance file says USD.** `lumen/finance_summary.csv` has `currency = USD`, and its `gross_reported` equals the EUR order totals to the cent on all 30 days. Is the label wrong, or is a 1.0 rate being applied somewhere? We report Lumen in EUR and treat the label as a question, not as a conversion.
Answer turns into: one field in the tenant config, or a correction in your export.

**6. What `net_reported` is.** In both finance files `net_reported` is above `gross_reported` on 17 of 30 days and does not move with refunds under any dating we tried. What is subtracted or added to get it? Our net is gross minus refunds on the day the refund was issued.
Answer turns into: a definition we can compute and reconcile daily, or a note that the two numbers are not comparable.

**7. Late records after a day has been reported.** When a refund or an event for an already-reported day arrives later, we rebuild that day and record what moved (previous, current, cause). Is that the behaviour you want for the numbers your finance team uses, or should a reported day stay frozen and the late record land on the day it arrived?
Answer turns into: `policies.late_arrivals` per tenant: `restate` (today) or `freeze` (to build).

With 1, 3, 4 and 5 answered the open items become configuration the same day. 2, 6 and 7 are about how you want the numbers to behave, and we would rather build what you choose than guess.
