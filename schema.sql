CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS patients (
  patnum BIGINT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  birthdate DATE,
  phone TEXT,
  email TEXT,
  guarantor BIGINT
);

CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patnum BIGINT REFERENCES patients(patnum) ON DELETE CASCADE,
  total_fee_cents INT NOT NULL,
  plan_count INT NOT NULL,
  last_txp_date DATE,
  days_since_plan INT GENERATED ALWAYS AS (
    CASE WHEN last_txp_date IS NULL THEN NULL ELSE (CURRENT_DATE - last_txp_date) END
  ) STORED,
  top_codes TEXT[],
  status TEXT NOT NULL DEFAULT 'new',
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS opportunity_procedures (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  opportunity_id UUID REFERENCES opportunities(id) ON DELETE CASCADE,
  code TEXT,
  description TEXT,
  fee_cents INT,
  tooth TEXT,
  surface TEXT
);

CREATE TABLE IF NOT EXISTS contact_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  opportunity_id UUID REFERENCES opportunities(id) ON DELETE CASCADE,
  channel TEXT,
  template_key TEXT,
  result TEXT,
  vendor_msg_id TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opps_patnum ON opportunities(patnum);
CREATE INDEX IF NOT EXISTS idx_opps_status ON opportunities(status);
CREATE INDEX IF NOT EXISTS idx_opps_days ON opportunities(days_since_plan);