PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS master_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_sources (
  source_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  update_cycle TEXT NOT NULL,
  authority_level TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  description TEXT,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS business_categories (
  category_code TEXT PRIMARY KEY,
  category_name TEXT NOT NULL,
  parent_category_code TEXT REFERENCES business_categories(category_code),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS administrative_regions (
  region_id TEXT PRIMARY KEY,
  region_key TEXT NOT NULL UNIQUE,
  parent_region_id TEXT REFERENCES administrative_regions(region_id),
  province_region_id TEXT REFERENCES administrative_regions(region_id),
  official_code TEXT,
  code5 TEXT,
  level TEXT NOT NULL,
  unit_type TEXT,
  official_unit_label TEXT,
  name TEXT NOT NULL,
  short_name TEXT,
  full_name TEXT NOT NULL,
  sido TEXT,
  sido_full TEXT,
  sigungu TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  selectable INTEGER NOT NULL DEFAULT 0 CHECK (selectable IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'complete',
  active_from TEXT,
  active_to TEXT,
  first_observed_at TEXT,
  last_observed_at TEXT,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_regions_parent ON administrative_regions(parent_region_id);
CREATE INDEX IF NOT EXISTS idx_regions_province ON administrative_regions(province_region_id);
CREATE INDEX IF NOT EXISTS idx_regions_official_code ON administrative_regions(official_code);
CREATE INDEX IF NOT EXISTS idx_regions_name ON administrative_regions(name);

CREATE TABLE IF NOT EXISTS region_aliases (
  region_id TEXT NOT NULL REFERENCES administrative_regions(region_id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (region_id, alias_key, source_id)
);

CREATE INDEX IF NOT EXISTS idx_region_alias_key ON region_aliases(alias_key);

CREATE TABLE IF NOT EXISTS tourism_region_codes (
  region_id TEXT NOT NULL REFERENCES administrative_regions(region_id) ON DELETE CASCADE,
  code_system TEXT NOT NULL,
  code_value TEXT NOT NULL,
  code_basis TEXT,
  status TEXT NOT NULL DEFAULT 'complete',
  raw_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (code_system, code_value)
);

CREATE INDEX IF NOT EXISTS idx_tourism_codes_region ON tourism_region_codes(region_id);

CREATE TABLE IF NOT EXISTS companies (
  company_id TEXT PRIMARY KEY,
  primary_name TEXT NOT NULL,
  name_key TEXT,
  loose_name_key TEXT,
  business_category_code TEXT REFERENCES business_categories(category_code),
  status TEXT NOT NULL DEFAULT 'complete',
  first_seen_at TEXT,
  last_seen_at TEXT,
  latest_run_id TEXT,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_companies_name_key ON companies(name_key);
CREATE INDEX IF NOT EXISTS idx_companies_loose_name_key ON companies(loose_name_key);

CREATE TABLE IF NOT EXISTS company_aliases (
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, alias_key, source_id)
);

CREATE INDEX IF NOT EXISTS idx_company_alias_key ON company_aliases(alias_key);

CREATE TABLE IF NOT EXISTS company_external_ids (
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  provider_code TEXT NOT NULL,
  external_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete',
  verified_at TEXT,
  raw_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_code, external_id)
);

CREATE INDEX IF NOT EXISTS idx_company_external_company ON company_external_ids(company_id);

CREATE TABLE IF NOT EXISTS company_match_candidates (
  candidate_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  candidate_type TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  match_status TEXT NOT NULL DEFAULT 'candidate',
  confidence_score REAL,
  raw_json TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (candidate_type, candidate_key, company_id)
);

CREATE INDEX IF NOT EXISTS idx_company_match_candidates_key ON company_match_candidates(candidate_type, candidate_key);

CREATE TABLE IF NOT EXISTS company_regions (
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  region_id TEXT REFERENCES administrative_regions(region_id),
  region_label TEXT NOT NULL DEFAULT '',
  relation_type TEXT NOT NULL DEFAULT 'observed',
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  confidence_status TEXT NOT NULL DEFAULT 'unverified',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, region_label, relation_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_company_regions_region ON company_regions(region_id);

CREATE TABLE IF NOT EXISTS company_addresses (
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  address_key TEXT NOT NULL,
  address TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, address_key, source_id)
);

CREATE TABLE IF NOT EXISTS company_urls (
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  channel_code TEXT NOT NULL,
  url TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'observed',
  status TEXT NOT NULL DEFAULT 'complete',
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  verified_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, channel_code, url)
);

CREATE TABLE IF NOT EXISTS keywords (
  keyword_id TEXT PRIMARY KEY,
  keyword TEXT NOT NULL,
  keyword_key TEXT NOT NULL UNIQUE,
  keyword_type TEXT,
  region_id TEXT REFERENCES administrative_regions(region_id),
  business_category_code TEXT REFERENCES business_categories(category_code),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_keywords_region ON keywords(region_id);

CREATE TABLE IF NOT EXISTS source_artifacts (
  artifact_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  run_id TEXT,
  artifact_type TEXT NOT NULL,
  file_role TEXT,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  modified_at TEXT,
  ingested_at TEXT NOT NULL,
  raw_json TEXT,
  UNIQUE (source_id, relative_path, sha256)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_run ON source_artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_path ON source_artifacts(relative_path);

CREATE TABLE IF NOT EXISTS collection_runs (
  run_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  run_label TEXT,
  keyword_id TEXT REFERENCES keywords(keyword_id),
  query_text TEXT,
  search_mode TEXT,
  product_mode TEXT,
  period_start TEXT,
  period_end TEXT,
  started_at TEXT,
  completed_at TEXT,
  status TEXT NOT NULL,
  status_rank INTEGER NOT NULL,
  source_artifact_id TEXT REFERENCES source_artifacts(artifact_id),
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_keyword ON collection_runs(keyword_id);
CREATE INDEX IF NOT EXISTS idx_runs_completed ON collection_runs(completed_at);

CREATE TABLE IF NOT EXISTS collection_tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES collection_runs(run_id) ON DELETE CASCADE,
  task_key TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL,
  region_id TEXT REFERENCES administrative_regions(region_id),
  company_id TEXT REFERENCES companies(company_id),
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  operation_code TEXT,
  channel_code TEXT,
  year_month TEXT,
  stay_date TEXT,
  task_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collection_tasks_run ON collection_tasks(run_id, task_status);

CREATE TABLE IF NOT EXISTS collection_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES collection_tasks(task_id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  attempt_status TEXT NOT NULL,
  external_call_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  raw_json TEXT,
  UNIQUE (task_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS company_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id),
  run_id TEXT REFERENCES collection_runs(run_id),
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  snapshot_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  status_rank INTEGER NOT NULL,
  source_artifact_id TEXT REFERENCES source_artifacts(artifact_id),
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (company_id, run_id, source_id, snapshot_type, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_company_snapshots_company ON company_snapshots(company_id, snapshot_type, observed_at);

CREATE TABLE IF NOT EXISTS company_snapshot_pointers (
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  snapshot_type TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES company_snapshots(snapshot_id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, source_id, snapshot_type)
);

CREATE TABLE IF NOT EXISTS company_channel_settings (
  setting_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  channel_code TEXT NOT NULL,
  exposure_status TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  inventory_mode TEXT NOT NULL DEFAULT 'unknown',
  url TEXT,
  collection_enabled INTEGER NOT NULL DEFAULT 0 CHECK (collection_enabled IN (0, 1)),
  verified_at TEXT,
  evidence_artifact_id TEXT REFERENCES source_artifacts(artifact_id),
  evidence_json TEXT,
  effective_from TEXT,
  effective_to TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_company_channel_settings ON company_channel_settings(company_id, channel_code, effective_from);

CREATE TABLE IF NOT EXISTS company_channel_setting_current (
  company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  channel_code TEXT NOT NULL,
  setting_id TEXT NOT NULL REFERENCES company_channel_settings(setting_id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, channel_code)
);

CREATE TABLE IF NOT EXISTS company_product_observations (
  product_observation_id TEXT PRIMARY KEY,
  snapshot_id TEXT REFERENCES company_snapshots(snapshot_id),
  run_id TEXT REFERENCES collection_runs(run_id),
  company_id TEXT NOT NULL REFERENCES companies(company_id),
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  channel_code TEXT NOT NULL,
  inventory_group TEXT NOT NULL DEFAULT 'unknown',
  observed_at TEXT NOT NULL,
  stay_date TEXT,
  day_type TEXT,
  product_key TEXT NOT NULL,
  product_name TEXT,
  product_type TEXT,
  quantity INTEGER,
  available INTEGER,
  sold INTEGER,
  price_num REAL,
  value_status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_artifact_id TEXT REFERENCES source_artifacts(artifact_id),
  raw_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_company_product_observations ON company_product_observations(company_id, stay_date, product_key, observed_at);

CREATE TABLE IF NOT EXISTS collection_receipts (
  receipt_id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES collection_runs(run_id),
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  region_id TEXT REFERENCES administrative_regions(region_id),
  company_id TEXT REFERENCES companies(company_id),
  observed_period_start TEXT,
  observed_period_end TEXT,
  status TEXT NOT NULL,
  status_rank INTEGER NOT NULL,
  quality_score REAL,
  reason_code TEXT,
  source_artifact_id TEXT REFERENCES source_artifacts(artifact_id),
  evidence_content_hash TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collection_receipts_lineage ON collection_receipts(run_id, company_id, source_id, evidence_content_hash);

CREATE TABLE IF NOT EXISTS region_metric_observations (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES collection_runs(run_id),
  region_id TEXT NOT NULL REFERENCES administrative_regions(region_id),
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  metric_code TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  value_num REAL,
  value_text TEXT,
  unit TEXT,
  status TEXT NOT NULL,
  status_rank INTEGER NOT NULL,
  collected_at TEXT NOT NULL,
  source_artifact_id TEXT REFERENCES source_artifacts(artifact_id),
  quality_score REAL,
  content_hash TEXT NOT NULL,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_region_metrics_period ON region_metric_observations(metric_code, period_end);
CREATE INDEX IF NOT EXISTS idx_region_metrics_region ON region_metric_observations(region_id, metric_code);
CREATE INDEX IF NOT EXISTS idx_region_metrics_natural ON region_metric_observations(region_id, source_id, metric_code, period_start, period_end);

CREATE TABLE IF NOT EXISTS region_metric_current (
  region_id TEXT NOT NULL REFERENCES administrative_regions(region_id),
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  metric_code TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES region_metric_observations(observation_id),
  status_rank INTEGER NOT NULL,
  has_value INTEGER NOT NULL CHECK (has_value IN (0, 1)),
  collected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (region_id, source_id, metric_code, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS keyword_metric_observations (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES collection_runs(run_id),
  keyword_id TEXT NOT NULL REFERENCES keywords(keyword_id),
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  metric_code TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  value_num REAL,
  value_text TEXT,
  unit TEXT,
  status TEXT NOT NULL,
  status_rank INTEGER NOT NULL,
  collected_at TEXT NOT NULL,
  source_artifact_id TEXT REFERENCES source_artifacts(artifact_id),
  content_hash TEXT NOT NULL,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_keyword_metrics_period ON keyword_metric_observations(metric_code, period_end);
CREATE INDEX IF NOT EXISTS idx_keyword_metrics_natural ON keyword_metric_observations(keyword_id, source_id, metric_code, period_start, period_end);

CREATE TABLE IF NOT EXISTS keyword_metric_current (
  keyword_id TEXT NOT NULL REFERENCES keywords(keyword_id),
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  metric_code TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES keyword_metric_observations(observation_id),
  status_rank INTEGER NOT NULL,
  has_value INTEGER NOT NULL CHECK (has_value IN (0, 1)),
  collected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (keyword_id, source_id, metric_code, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS company_observations (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES collection_runs(run_id),
  company_id TEXT NOT NULL REFERENCES companies(company_id),
  keyword_id TEXT REFERENCES keywords(keyword_id),
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  channel_code TEXT NOT NULL DEFAULT 'naver',
  collected_at TEXT NOT NULL,
  stay_date TEXT,
  lead_time_days INTEGER,
  rank_value INTEGER,
  product_key TEXT NOT NULL DEFAULT '',
  product_type TEXT,
  inventory_group TEXT NOT NULL DEFAULT 'unknown',
  supply INTEGER,
  available INTEGER,
  sold INTEGER,
  sale_rate REAL,
  price_num REAL,
  price_text TEXT,
  status TEXT NOT NULL,
  status_rank INTEGER NOT NULL,
  confidence_grade TEXT,
  confidence_score REAL,
  source_url TEXT,
  source_artifact_id TEXT REFERENCES source_artifacts(artifact_id),
  content_hash TEXT NOT NULL,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_company_observations_company_date ON company_observations(company_id, stay_date);
CREATE INDEX IF NOT EXISTS idx_company_observations_keyword ON company_observations(keyword_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_company_observations_natural ON company_observations(company_id, stay_date, product_key, channel_code, inventory_group, source_id);

CREATE TABLE IF NOT EXISTS company_observation_current (
  company_id TEXT NOT NULL REFERENCES companies(company_id),
  stay_date TEXT NOT NULL DEFAULT '',
  product_key TEXT NOT NULL DEFAULT '',
  channel_code TEXT NOT NULL,
  inventory_group TEXT NOT NULL DEFAULT 'unknown',
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  observation_id TEXT NOT NULL REFERENCES company_observations(observation_id),
  status_rank INTEGER NOT NULL,
  has_value INTEGER NOT NULL CHECK (has_value IN (0, 1)),
  collected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, stay_date, product_key, channel_code, inventory_group, source_id)
);

CREATE VIEW IF NOT EXISTS region_metric_current_values AS
SELECT observation.*
FROM region_metric_current pointer
JOIN region_metric_observations observation ON observation.observation_id = pointer.observation_id;

CREATE VIEW IF NOT EXISTS keyword_metric_current_values AS
SELECT observation.*
FROM keyword_metric_current pointer
JOIN keyword_metric_observations observation ON observation.observation_id = pointer.observation_id;

CREATE VIEW IF NOT EXISTS company_observation_current_values AS
SELECT observation.*
FROM company_observation_current pointer
JOIN company_observations observation ON observation.observation_id = pointer.observation_id;

CREATE TABLE IF NOT EXISTS derived_metric_observations (
  derived_metric_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  metric_code TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  value_num REAL,
  value_text TEXT,
  unit TEXT,
  value_status TEXT NOT NULL,
  formula_version TEXT NOT NULL,
  input_observation_ids_json TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_derived_metrics_entity ON derived_metric_observations(entity_type, entity_id, metric_code, period_end);

CREATE TABLE IF NOT EXISTS reference_records (
  record_id TEXT PRIMARY KEY,
  record_type TEXT NOT NULL,
  record_key TEXT NOT NULL,
  region_id TEXT REFERENCES administrative_regions(region_id),
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'complete',
  valid_from TEXT,
  valid_to TEXT,
  source_artifact_id TEXT REFERENCES source_artifacts(artifact_id),
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (record_type, record_key, source_id)
);

CREATE INDEX IF NOT EXISTS idx_reference_records_region ON reference_records(region_id, record_type);

CREATE TABLE IF NOT EXISTS legacy_import_ledger (
  ledger_id TEXT PRIMARY KEY,
  source_artifact_id TEXT NOT NULL REFERENCES source_artifacts(artifact_id),
  legacy_record_key TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_record_id TEXT,
  import_status TEXT NOT NULL,
  reason TEXT,
  imported_at TEXT NOT NULL,
  UNIQUE (source_artifact_id, legacy_record_key, target_table)
);

CREATE INDEX IF NOT EXISTS idx_legacy_import_target ON legacy_import_ledger(target_table, target_record_id);

CREATE TABLE IF NOT EXISTS manual_overrides (
  override_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  value_json TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'complete',
  effective_from TEXT,
  effective_to TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_manual_overrides_entity ON manual_overrides(entity_type, entity_id, status);

CREATE TABLE IF NOT EXISTS quality_reviews (
  review_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  review_status TEXT NOT NULL,
  issue_code TEXT,
  note TEXT,
  evidence_json TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_reviews_entity ON quality_reviews(entity_type, entity_id, reviewed_at);

CREATE TABLE IF NOT EXISTS internal_actuals (
  actual_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(company_id),
  stay_date TEXT NOT NULL,
  product_key TEXT NOT NULL DEFAULT '',
  booked_units INTEGER,
  available_units INTEGER,
  actual_revenue REAL,
  status TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES data_sources(source_id),
  imported_at TEXT NOT NULL,
  raw_json TEXT,
  UNIQUE (company_id, stay_date, product_key, source_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_actuals_company_date ON internal_actuals(company_id, stay_date);

CREATE TABLE IF NOT EXISTS ops_job_runs (
  job_run_id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  related_run_id TEXT REFERENCES collection_runs(run_id),
  started_at TEXT,
  ended_at TEXT,
  duration_seconds REAL,
  job_status TEXT NOT NULL,
  error_message TEXT,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_job_runs_type_time ON ops_job_runs(job_type, started_at);
