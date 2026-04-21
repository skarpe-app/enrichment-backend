-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "list_status" AS ENUM ('pending', 'importing', 'import_failed', 'ready');

-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('queuing', 'processing', 'completed', 'stopped', 'failed');

-- CreateEnum
CREATE TYPE "run_item_status" AS ENUM ('pending', 'scraping', 'classifying', 'completed', 'failed', 'skipped', 'retrying');

-- CreateEnum
CREATE TYPE "domain_source" AS ENUM ('website', 'email');

-- CreateEnum
CREATE TYPE "domain_resolution_mode" AS ENUM ('email_only', 'website_only', 'combined');

-- CreateEnum
CREATE TYPE "combined_priority" AS ENUM ('email_first', 'website_first');

-- CreateEnum
CREATE TYPE "ai_provider" AS ENUM ('openai', 'anthropic');

-- CreateEnum
CREATE TYPE "prompt_mode" AS ENUM ('prompt_id', 'text');

-- CreateEnum
CREATE TYPE "scope_type" AS ENUM ('all', 'selected', 'filtered');

-- CreateEnum
CREATE TYPE "billing_source" AS ENUM ('system_default', 'user_credential');

-- CreateEnum
CREATE TYPE "field_type" AS ENUM ('text', 'number', 'date', 'boolean', 'url', 'select');

-- CreateEnum
CREATE TYPE "proxy_protocol" AS ENUM ('http', 'https', 'socks5');

-- CreateEnum
CREATE TYPE "scrape_status" AS ENUM ('success', 'failed', 'cached', 'skipped');

-- CreateEnum
CREATE TYPE "skip_reason" AS ENUM ('personal_email', 'invalid_domain', 'no_domain', 'non_html_content');

-- CreateEnum
CREATE TYPE "run_event_step" AS ENUM ('dns_check', 'scrape', 'classify', 'cache_hit', 'skip', 'error', 'retry');

-- CreateEnum
CREATE TYPE "run_event_status" AS ENUM ('success', 'failed', 'skipped', 'cached');

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "user_role" NOT NULL DEFAULT 'USER',
    "domain_cache_ttl_days" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "ai_provider" NOT NULL,
    "api_key_enc" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ai_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_fields" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "field_type" "field_type" NOT NULL,
    "select_options" TEXT[],
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "custom_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_lists" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "source_row_count" INTEGER NOT NULL DEFAULT 0,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "rejected_count" INTEGER NOT NULL DEFAULT 0,
    "status" "list_status" NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "original_headers" TEXT[],
    "column_mapping" JSONB,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contact_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "list_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "name" TEXT,
    "company_name" TEXT,
    "company_website" TEXT,
    "custom_fields" JSONB,
    "original_row" JSONB NOT NULL,
    "row_index" INTEGER NOT NULL,
    "website_domain" TEXT,
    "email_domain" TEXT,
    "resolved_domain" TEXT,
    "domain_source" "domain_source",
    "domain_mismatch" BOOLEAN NOT NULL DEFAULT false,
    "latest_result_id" UUID,
    "latest_successful_result_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrichment_runs" (
    "id" UUID NOT NULL,
    "list_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "run_status" NOT NULL DEFAULT 'queuing',
    "ai_provider" "ai_provider" NOT NULL DEFAULT 'openai',
    "ai_model" TEXT NOT NULL,
    "prompt_mode" "prompt_mode" NOT NULL,
    "prompt_id" TEXT,
    "prompt_version" TEXT,
    "prompt_text" TEXT,
    "prompt_hash" TEXT,
    "billing_source" "billing_source" NOT NULL DEFAULT 'system_default',
    "ai_credential_id" UUID,
    "domain_resolution_mode" "domain_resolution_mode" NOT NULL,
    "combined_priority" "combined_priority",
    "force_rescrape" BOOLEAN NOT NULL DEFAULT false,
    "domain_cache_ttl_days" INTEGER NOT NULL,
    "scope_type" "scope_type" NOT NULL,
    "selected_contact_ids" UUID[],
    "filter_snapshot" JSONB,
    "scope_materialized" BOOLEAN NOT NULL DEFAULT false,
    "total_items" INTEGER NOT NULL DEFAULT 0,
    "completed_items" INTEGER NOT NULL DEFAULT 0,
    "failed_items" INTEGER NOT NULL DEFAULT 0,
    "skipped_items" INTEGER NOT NULL DEFAULT 0,
    "total_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ,
    "stopped_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "enrichment_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrichment_run_items" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "run_item_status" NOT NULL DEFAULT 'pending',
    "domain" TEXT,
    "domain_source" "domain_source",
    "fallback_domain" TEXT,
    "fallback_attempted" BOOLEAN NOT NULL DEFAULT false,
    "fallback_source" "domain_source",
    "scrape_status" "scrape_status",
    "scrape_error" TEXT,
    "scrape_ms" INTEGER,
    "proxy_used" TEXT,
    "industry" TEXT,
    "sub_industry" TEXT,
    "confidence" INTEGER,
    "reasoning" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DECIMAL(10,6),
    "classify_ms" INTEGER,
    "skip_reason" "skip_reason",
    "error_message" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "enrichment_run_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domains" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "dns_valid" BOOLEAN,
    "dns_checked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_snapshots" (
    "id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "page_title" TEXT,
    "meta_description" TEXT,
    "headings" TEXT[],
    "cleaned_text" TEXT,
    "internal_pages" JSONB,
    "pages_scraped" INTEGER NOT NULL DEFAULT 1,
    "combined_digest" TEXT,
    "http_status" INTEGER,
    "scrape_success" BOOLEAN NOT NULL DEFAULT false,
    "scrape_error" TEXT,
    "content_length" INTEGER,
    "proxy_used" TEXT,
    "scraped_at" TIMESTAMPTZ NOT NULL,
    "invalidated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_classifications" (
    "id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "ai_provider" "ai_provider" NOT NULL,
    "ai_model" TEXT NOT NULL,
    "prompt_id" TEXT,
    "prompt_version" TEXT,
    "prompt_hash" TEXT,
    "industry" TEXT NOT NULL,
    "sub_industry" TEXT,
    "confidence" INTEGER NOT NULL,
    "reasoning" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_usd" DECIMAL(10,6) NOT NULL,
    "classify_ms" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "domain_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proxy_endpoints" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username_enc" TEXT,
    "password_enc" TEXT,
    "protocol" "proxy_protocol" NOT NULL DEFAULT 'http',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "total_requests" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "avg_response_ms" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "proxy_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proxy_attempt_events" (
    "id" UUID NOT NULL,
    "proxy_id" UUID,
    "proxy_name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "run_id" UUID,
    "phase" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "http_status" INTEGER,
    "response_ms" INTEGER NOT NULL,
    "error_message" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proxy_attempt_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_events" (
    "id" BIGSERIAL NOT NULL,
    "run_id" UUID NOT NULL,
    "run_item_id" UUID,
    "contact_id" UUID,
    "step" "run_event_step" NOT NULL,
    "status" "run_event_status" NOT NULL,
    "message" TEXT NOT NULL,
    "duration_ms" INTEGER,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "id" UUID NOT NULL,
    "instance_id" TEXT NOT NULL,
    "last_heartbeat" TIMESTAMPTZ NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "queues" TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_snapshots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "list_id" UUID NOT NULL,
    "list_name" TEXT NOT NULL,
    "total_runs" INTEGER NOT NULL,
    "total_items" INTEGER NOT NULL,
    "total_cost_usd" DECIMAL(10,6) NOT NULL,
    "total_input_tokens" INTEGER NOT NULL,
    "total_output_tokens" INTEGER NOT NULL,
    "deleted_at" TIMESTAMPTZ NOT NULL,
    "purged_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_email_key" ON "profiles"("email");

-- CreateIndex
CREATE INDEX "ai_credentials_user_id_provider_idx" ON "ai_credentials"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "custom_fields_user_id_field_key_key" ON "custom_fields"("user_id", "field_key");

-- CreateIndex
CREATE INDEX "contact_lists_user_id_idx" ON "contact_lists"("user_id");

-- CreateIndex
CREATE INDEX "contacts_list_id_idx" ON "contacts"("list_id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_list_id_email_key" ON "contacts"("list_id", "email");

-- CreateIndex
CREATE INDEX "enrichment_runs_list_id_idx" ON "enrichment_runs"("list_id");

-- CreateIndex
CREATE INDEX "enrichment_runs_user_id_idx" ON "enrichment_runs"("user_id");

-- CreateIndex
CREATE INDEX "enrichment_runs_status_idx" ON "enrichment_runs"("status");

-- CreateIndex
CREATE INDEX "enrichment_run_items_run_id_status_idx" ON "enrichment_run_items"("run_id", "status");

-- CreateIndex
CREATE INDEX "enrichment_run_items_contact_id_idx" ON "enrichment_run_items"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrichment_run_items_run_id_contact_id_key" ON "enrichment_run_items"("run_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "domains_domain_key" ON "domains"("domain");

-- CreateIndex
CREATE INDEX "domain_snapshots_domain_id_idx" ON "domain_snapshots"("domain_id");

-- CreateIndex
CREATE INDEX "domain_snapshots_domain_id_scraped_at_idx" ON "domain_snapshots"("domain_id", "scraped_at");

-- CreateIndex
CREATE INDEX "domain_classifications_domain_id_idx" ON "domain_classifications"("domain_id");

-- CreateIndex
CREATE INDEX "proxy_attempt_events_proxy_id_created_at_idx" ON "proxy_attempt_events"("proxy_id", "created_at");

-- CreateIndex
CREATE INDEX "proxy_attempt_events_run_id_idx" ON "proxy_attempt_events"("run_id");

-- CreateIndex
CREATE INDEX "run_events_run_id_id_idx" ON "run_events"("run_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "worker_heartbeats_instance_id_key" ON "worker_heartbeats"("instance_id");

-- CreateIndex
CREATE INDEX "billing_snapshots_user_id_idx" ON "billing_snapshots"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_snapshots_list_id_key" ON "billing_snapshots"("list_id");

-- AddForeignKey
ALTER TABLE "ai_credentials" ADD CONSTRAINT "ai_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_lists" ADD CONSTRAINT "contact_lists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "contact_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_latest_result_id_fkey" FOREIGN KEY ("latest_result_id") REFERENCES "enrichment_run_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_latest_successful_result_id_fkey" FOREIGN KEY ("latest_successful_result_id") REFERENCES "enrichment_run_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "enrichment_runs_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "contact_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "enrichment_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "enrichment_runs_ai_credential_id_fkey" FOREIGN KEY ("ai_credential_id") REFERENCES "ai_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_run_items" ADD CONSTRAINT "enrichment_run_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "enrichment_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_run_items" ADD CONSTRAINT "enrichment_run_items_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_snapshots" ADD CONSTRAINT "domain_snapshots_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_classifications" ADD CONSTRAINT "domain_classifications_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_classifications" ADD CONSTRAINT "domain_classifications_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "domain_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxy_attempt_events" ADD CONSTRAINT "proxy_attempt_events_proxy_id_fkey" FOREIGN KEY ("proxy_id") REFERENCES "proxy_endpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxy_attempt_events" ADD CONSTRAINT "proxy_attempt_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "enrichment_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "enrichment_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_item_id_fkey" FOREIGN KEY ("run_item_id") REFERENCES "enrichment_run_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_snapshots" ADD CONSTRAINT "billing_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
