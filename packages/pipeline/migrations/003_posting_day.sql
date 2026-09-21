-- 003: the day a record is booked on, decided at staging time by the tenant's late_arrivals policy.
--   restate: posting_day = the record's own day, always (a late record rebuilds its day, with a restatement).
--   freeze:  posting_day = the record's own day unless that day was already built, then the day it arrived.
-- The marts group by posting_day, so they never branch on the policy.

ALTER TABLE stg.orders       ADD COLUMN posting_day date;
ALTER TABLE stg.email_events ADD COLUMN posting_day date;
ALTER TABLE stg.ad_spend     ADD COLUMN posting_day date;
ALTER TABLE stg.refunds      ADD COLUMN posting_day date;

UPDATE stg.orders       SET posting_day = (created_at  AT TIME ZONE 'UTC')::date;
UPDATE stg.email_events SET posting_day = (occurred_at AT TIME ZONE 'UTC')::date;
UPDATE stg.ad_spend     SET posting_day = spend_date;
UPDATE stg.refunds      SET posting_day = (refunded_at AT TIME ZONE 'UTC')::date;

ALTER TABLE stg.orders       ALTER COLUMN posting_day SET NOT NULL;
ALTER TABLE stg.email_events ALTER COLUMN posting_day SET NOT NULL;
ALTER TABLE stg.ad_spend     ALTER COLUMN posting_day SET NOT NULL;
ALTER TABLE stg.refunds      ALTER COLUMN posting_day SET NOT NULL;

CREATE INDEX orders_tenant_posting       ON stg.orders (tenant_id, posting_day);
CREATE INDEX email_events_tenant_posting ON stg.email_events (tenant_id, posting_day);
CREATE INDEX ad_spend_tenant_posting     ON stg.ad_spend (tenant_id, posting_day);
CREATE INDEX refunds_tenant_posting      ON stg.refunds (tenant_id, posting_day);

-- Under freeze, this is the audit trail: every record booked on a day other than its own, and where.
CREATE VIEW mart.late_postings WITH (security_invoker = true) AS
SELECT tenant_id, 'orders' AS source, order_id AS natural_key, (created_at AT TIME ZONE 'UTC')::date AS event_day, posting_day, gross AS amount, channel AS dimension
FROM stg.orders WHERE posting_day <> (created_at AT TIME ZONE 'UTC')::date
UNION ALL
SELECT tenant_id, 'refunds', refund_id, (refunded_at AT TIME ZONE 'UTC')::date, posting_day, amount, order_id
FROM stg.refunds WHERE posting_day <> (refunded_at AT TIME ZONE 'UTC')::date
UNION ALL
SELECT tenant_id, 'email_events', event_id, (occurred_at AT TIME ZONE 'UTC')::date, posting_day, NULL, coalesce(campaign_id, '(none)')
FROM stg.email_events WHERE posting_day <> (occurred_at AT TIME ZONE 'UTC')::date
UNION ALL
SELECT tenant_id, 'ad_spend', campaign_id, spend_date, posting_day, spend, platform
FROM stg.ad_spend WHERE posting_day <> spend_date;
