-- 001_init: schemas, application role, tables, row-level security.
-- Applied with the admin connection (DATABASE_URL). Idempotent where Postgres allows it.

CREATE SCHEMA IF NOT EXISTS raw;   -- files as they arrived, one JSONB row per line
CREATE SCHEMA IF NOT EXISTS stg;   -- typed, normalised, one row per natural key
CREATE SCHEMA IF NOT EXISTS mart;  -- what a client queries
CREATE SCHEMA IF NOT EXISTS ops;   -- runs, expectations, quarantine, restatements

-- The application role. It cannot bypass row-level security, so every policy below applies to it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw LOGIN PASSWORD 'app_rw' NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA raw, stg, mart, ops TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA raw, stg, mart, ops GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA raw, stg, mart, ops GRANT USAGE, SELECT ON SEQUENCES TO app_rw;

-- ---------------------------------------------------------------- registry (no tenant data, no RLS)
CREATE TABLE ops.tenants (
  id            text PRIMARY KEY,
  display_name  text NOT NULL,
  currency      text NOT NULL,
  config_hash   text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- operations
CREATE TABLE ops.runs (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES ops.tenants(id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  args        jsonb NOT NULL DEFAULT '{}',
  stats       jsonb NOT NULL DEFAULT '{}',
  error       text
);

-- The manifest, loaded: what the set is supposed to contain.
CREATE TABLE ops.expected_deliveries (
  tenant_id   text NOT NULL REFERENCES ops.tenants(id),
  source      text NOT NULL,
  batch       int  NOT NULL,
  path        text NOT NULL,
  covers_from date NOT NULL,
  covers_to   date NOT NULL,
  PRIMARY KEY (tenant_id, source, batch)
);

-- ---------------------------------------------------------------- raw
CREATE TABLE raw.file_loads (
  id                bigserial PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES ops.tenants(id),
  source            text NOT NULL,
  path              text NOT NULL,
  sha256            text NOT NULL,
  byte_size         bigint NOT NULL,
  batch             int,
  columns           text[],
  schema_version    text,
  status            text NOT NULL CHECK (status IN ('loading', 'loaded', 'quarantined', 'failed')),
  quarantine_reason text,
  rows_seen         int NOT NULL DEFAULT 0,
  rows_committed    int NOT NULL DEFAULT 0,
  attempts          int NOT NULL DEFAULT 1,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  loaded_at         timestamptz,
  staged_at         timestamptz,
  run_id            bigint REFERENCES ops.runs(id),
  UNIQUE (tenant_id, sha256)          -- the same content arriving twice is one load
);

CREATE TABLE raw.records (
  file_load_id bigint NOT NULL REFERENCES raw.file_loads(id) ON DELETE CASCADE,
  tenant_id    text NOT NULL REFERENCES ops.tenants(id),
  source       text NOT NULL,
  line_no      int  NOT NULL,           -- 1-based data line; the resume point after a crash
  payload      jsonb NOT NULL,
  PRIMARY KEY (file_load_id, line_no)
);
CREATE INDEX records_tenant_source ON raw.records (tenant_id, source);

-- ---------------------------------------------------------------- staging
CREATE TABLE stg.orders (
  tenant_id          text NOT NULL REFERENCES ops.tenants(id),
  order_id           text NOT NULL,
  created_at         timestamptz NOT NULL,
  channel            text NOT NULL,
  channel_raw        text NOT NULL,
  gross              numeric(14,2) NOT NULL,
  currency           text NOT NULL,
  customer_email     text,
  content_hash       text NOT NULL,
  first_file_load_id bigint NOT NULL,
  last_file_load_id  bigint NOT NULL,
  times_seen         int NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, order_id)
);
CREATE INDEX orders_tenant_created ON stg.orders (tenant_id, created_at);

CREATE TABLE stg.email_events (
  tenant_id          text NOT NULL REFERENCES ops.tenants(id),
  event_id           text NOT NULL,
  occurred_at        timestamptz NOT NULL,
  type               text NOT NULL,
  email              text,
  campaign_id        text,
  content_hash       text NOT NULL,
  first_file_load_id bigint NOT NULL,
  last_file_load_id  bigint NOT NULL,
  times_seen         int NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id)
);
CREATE INDEX email_events_tenant_occurred ON stg.email_events (tenant_id, occurred_at);

CREATE TABLE stg.ad_spend (
  tenant_id          text NOT NULL REFERENCES ops.tenants(id),
  spend_date         date NOT NULL,
  campaign_id        text NOT NULL,
  platform           text NOT NULL,
  platform_raw       text NOT NULL,
  spend              numeric(14,2) NOT NULL,
  currency           text NOT NULL,
  schema_version     text NOT NULL,
  content_hash       text NOT NULL,
  first_file_load_id bigint NOT NULL,
  last_file_load_id  bigint NOT NULL,
  times_seen         int NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, spend_date, campaign_id)
);

CREATE TABLE stg.refunds (
  tenant_id          text NOT NULL REFERENCES ops.tenants(id),
  refund_id          text NOT NULL,
  refunded_at        timestamptz NOT NULL,
  order_id           text NOT NULL,
  amount             numeric(14,2) NOT NULL,
  currency           text NOT NULL,
  content_hash       text NOT NULL,
  first_file_load_id bigint NOT NULL,
  last_file_load_id  bigint NOT NULL,
  times_seen         int NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, refund_id)
);
CREATE INDEX refunds_tenant_refunded ON stg.refunds (tenant_id, refunded_at);

-- ---------------------------------------------------------------- what the pipeline noticed
CREATE TABLE ops.quarantine (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES ops.tenants(id),
  source       text NOT NULL,
  file_load_id bigint,
  line_no      int,
  ref          text NOT NULL,            -- the natural key or file path the row is about
  reason       text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, ref, reason)
);

CREATE TABLE ops.schema_events (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES ops.tenants(id),
  source       text NOT NULL,
  file_load_id bigint,
  kind         text NOT NULL,            -- alias_used | unknown_columns | missing_required
  detail       jsonb NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL DEFAULT now()
);

-- A record re-delivered with different content. The newer version wins in staging; the older is kept here.
CREATE TABLE ops.conflicts (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES ops.tenants(id),
  source       text NOT NULL,
  natural_key  text NOT NULL,
  file_load_id bigint,
  previous     jsonb NOT NULL,
  incoming     jsonb NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);

-- Days whose staging rows changed since the marts were last built.
CREATE TABLE ops.dirty_days (
  tenant_id text NOT NULL REFERENCES ops.tenants(id),
  day       date NOT NULL,
  sources   text[] NOT NULL DEFAULT '{}',
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day)
);

-- A number the client could already see, and what it became.
CREATE TABLE ops.restatements (
  id        bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES ops.tenants(id),
  day       date NOT NULL,
  channel   text NOT NULL,
  metric    text NOT NULL,
  previous  numeric(14,2),
  current   numeric(14,2),
  run_id    bigint,
  cause     text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- marts
CREATE TABLE mart.daily_revenue (
  tenant_id    text NOT NULL REFERENCES ops.tenants(id),
  day          date NOT NULL,
  channel      text NOT NULL,             -- canonical channel, or 'unattributed' for refunds with no order
  orders       int NOT NULL,
  gross        numeric(14,2) NOT NULL,
  refunds      numeric(14,2) NOT NULL,
  net          numeric(14,2) NOT NULL,
  currency     text NOT NULL,
  complete     boolean NOT NULL DEFAULT true,   -- false when an expected orders/refunds batch for this day is missing
  built_by_run bigint,
  built_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, channel)
);

-- Views run as the caller (security_invoker), so row-level security still applies through them.
CREATE VIEW mart.daily_marketing WITH (security_invoker = true) AS
SELECT s.tenant_id, s.spend_date AS day, s.platform, s.campaign_id, s.spend, s.currency, s.schema_version
FROM stg.ad_spend s;

CREATE VIEW mart.daily_email WITH (security_invoker = true) AS
SELECT tenant_id,
       (occurred_at AT TIME ZONE 'UTC')::date AS day,
       campaign_id,
       count(*) FILTER (WHERE type = 'delivered')   AS delivered,
       count(*) FILTER (WHERE type = 'open')        AS opens,
       count(*) FILTER (WHERE type = 'click')       AS clicks,
       count(*) FILTER (WHERE type = 'unsubscribe') AS unsubscribes
FROM stg.email_events
GROUP BY tenant_id, (occurred_at AT TIME ZONE 'UTC')::date, campaign_id;

-- ---------------------------------------------------------------- row-level security
-- Every table that holds tenant data: enabled and forced, one policy, both directions.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ops.runs', 'ops.expected_deliveries', 'raw.file_loads', 'raw.records',
    'stg.orders', 'stg.email_events', 'stg.ad_spend', 'stg.refunds',
    'ops.quarantine', 'ops.schema_events', 'ops.conflicts', 'ops.dirty_days', 'ops.restatements',
    'mart.daily_revenue'
  ] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s '
      'USING (tenant_id = current_setting(''app.tenant_id'', true)) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA raw, stg, mart, ops TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA raw, stg, mart, ops TO app_rw;
