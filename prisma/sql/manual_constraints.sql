-- Manual SQL migration: partial unique indexes, CHECK constraints, and partial indexes
-- These cannot be expressed in Prisma schema and must be applied separately.
-- Run against DATABASE_URL_DIRECT (not pooler).

-- ─── ai_credentials: exactly one default per (user, provider) ─────────────────
CREATE UNIQUE INDEX IF NOT EXISTS ai_credentials_user_provider_default_unique
  ON ai_credentials (user_id, provider)
  WHERE is_default = true;

-- ─── enrichment_runs: one active run per list ─────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS enrichment_runs_list_active_unique
  ON enrichment_runs (list_id)
  WHERE status IN ('queuing', 'processing');

-- ─── contact_lists: index for user's non-deleted lists ────────────────────────
CREATE INDEX IF NOT EXISTS contact_lists_user_not_deleted
  ON contact_lists (user_id)
  WHERE deleted_at IS NULL;

-- ─── domain_classifications: three partial unique indexes ─────────────────────
-- 1. Stored prompt with resolved version
CREATE UNIQUE INDEX IF NOT EXISTS domain_classifications_snapshot_prompt_version_unique
  ON domain_classifications (snapshot_id, ai_provider, ai_model, prompt_id, prompt_version)
  WHERE prompt_id IS NOT NULL AND prompt_version IS NOT NULL;

-- 2. Stored prompt with NULL version (prevents unlimited NULL-version duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS domain_classifications_snapshot_prompt_null_version_unique
  ON domain_classifications (snapshot_id, ai_provider, ai_model, prompt_id)
  WHERE prompt_id IS NOT NULL AND prompt_version IS NULL;

-- 3. Text prompt (keyed on hash)
CREATE UNIQUE INDEX IF NOT EXISTS domain_classifications_snapshot_prompt_hash_unique
  ON domain_classifications (snapshot_id, ai_provider, ai_model, prompt_hash)
  WHERE prompt_hash IS NOT NULL;

-- ─── domain_classifications: CHECK constraint (prompt_id XOR prompt_hash) ─────
ALTER TABLE domain_classifications
  ADD CONSTRAINT domain_classifications_prompt_check
  CHECK (
    (prompt_id IS NOT NULL AND prompt_hash IS NULL)
    OR
    (prompt_id IS NULL AND prompt_hash IS NOT NULL)
  );

-- ─── enrichment_runs: CHECK constraints ───────────────────────────────────────

-- Prompt mode constraints
ALTER TABLE enrichment_runs
  ADD CONSTRAINT enrichment_runs_prompt_mode_prompt_id_check
  CHECK (
    prompt_mode != 'prompt_id'
    OR (prompt_id IS NOT NULL AND prompt_text IS NULL AND prompt_hash IS NULL)
  );

ALTER TABLE enrichment_runs
  ADD CONSTRAINT enrichment_runs_prompt_mode_text_check
  CHECK (
    prompt_mode != 'text'
    OR (prompt_text IS NOT NULL AND prompt_hash IS NOT NULL AND prompt_id IS NULL AND prompt_version IS NULL)
  );

-- Domain resolution constraints
ALTER TABLE enrichment_runs
  ADD CONSTRAINT enrichment_runs_combined_priority_required_check
  CHECK (
    domain_resolution_mode != 'combined'
    OR combined_priority IS NOT NULL
  );

ALTER TABLE enrichment_runs
  ADD CONSTRAINT enrichment_runs_combined_priority_null_check
  CHECK (
    domain_resolution_mode = 'combined'
    OR combined_priority IS NULL
  );

-- Billing constraints
ALTER TABLE enrichment_runs
  ADD CONSTRAINT enrichment_runs_billing_system_default_check
  CHECK (
    billing_source != 'system_default'
    OR ai_credential_id IS NULL
  );

ALTER TABLE enrichment_runs
  ADD CONSTRAINT enrichment_runs_billing_user_credential_check
  CHECK (
    billing_source != 'user_credential'
    OR ai_credential_id IS NOT NULL
  );

-- Scope constraints
ALTER TABLE enrichment_runs
  ADD CONSTRAINT enrichment_runs_scope_all_check
  CHECK (
    scope_type != 'all'
    OR (selected_contact_ids IS NULL AND filter_snapshot IS NULL)
  );

ALTER TABLE enrichment_runs
  ADD CONSTRAINT enrichment_runs_scope_selected_check
  CHECK (
    scope_type != 'selected'
    OR (
      selected_contact_ids IS NOT NULL
      AND array_length(selected_contact_ids, 1) BETWEEN 1 AND 10000
      AND filter_snapshot IS NULL
    )
  );

ALTER TABLE enrichment_runs
  ADD CONSTRAINT enrichment_runs_scope_filtered_check
  CHECK (
    scope_type != 'filtered'
    OR (filter_snapshot IS NOT NULL AND selected_contact_ids IS NULL)
  );
