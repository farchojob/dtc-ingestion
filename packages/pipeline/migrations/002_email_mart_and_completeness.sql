-- 002: email metrics become a stored mart so late events leave restatements (D5), and the marketing
-- view says which days have no spend because nothing arrived (D8).

-- One restatements table for every mart: `dimension` is the channel (daily_revenue) or the campaign (daily_email).
ALTER TABLE ops.restatements RENAME COLUMN channel TO dimension;
ALTER TABLE ops.restatements ADD COLUMN mart text NOT NULL DEFAULT 'daily_revenue';

DROP VIEW mart.daily_email;
CREATE TABLE mart.daily_email (
  tenant_id    text NOT NULL REFERENCES ops.tenants(id),
  day          date NOT NULL,
  campaign_id  text NOT NULL,                -- '(none)' when the event carried no campaign
  delivered    int NOT NULL,
  opens        int NOT NULL,
  clicks       int NOT NULL,
  unsubscribes int NOT NULL,
  built_by_run bigint,
  built_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, campaign_id)
);
ALTER TABLE mart.daily_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE mart.daily_email FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mart.daily_email
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON mart.daily_email TO app_rw;

-- Every day an ad_spend delivery was expected to cover, joined to what arrived. A day whose batch
-- never came is a row with NULL spend and complete = false: not zero, because nothing is known.
DROP VIEW mart.daily_marketing;
CREATE VIEW mart.daily_marketing WITH (security_invoker = true) AS
WITH expected AS (
  SELECT e.tenant_id, d::date AS day, bool_and(f.id IS NOT NULL) AS complete
  FROM ops.expected_deliveries e
  CROSS JOIN LATERAL generate_series(e.covers_from, e.covers_to, interval '1 day') AS d
  LEFT JOIN raw.file_loads f
         ON f.tenant_id = e.tenant_id AND f.source = e.source AND f.batch = e.batch AND f.status = 'loaded'
  WHERE e.source = 'ad_spend'
  GROUP BY e.tenant_id, d
)
SELECT x.tenant_id, x.day, s.platform, s.campaign_id, s.spend, s.currency, s.schema_version, x.complete
FROM expected x
LEFT JOIN stg.ad_spend s ON s.tenant_id = x.tenant_id AND s.spend_date = x.day;
