CREATE TABLE "content_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"procedure_id" uuid NOT NULL,
	"step_seq" integer,
	"flagged_by" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "content_reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"procedure_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"reviewer" text NOT NULL,
	"decision" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"licence_id" uuid,
	"precedence" integer DEFAULT 50 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_loaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"make" text NOT NULL,
	"machine_model_id" uuid,
	"part_number_norm" text,
	"label" text NOT NULL,
	"url_template" text NOT NULL,
	"portal" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_pages" (
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"label" text,
	"text" text NOT NULL,
	"text_sha256" text NOT NULL,
	"image_key" text,
	CONSTRAINT "document_pages_document_id_page_pk" PRIMARY KEY("document_id","page")
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"model" text NOT NULL,
	"mode" text DEFAULT 'sync' NOT NULL,
	"page_from" integer,
	"page_to" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"output" jsonb,
	"error" text,
	"actor" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "part_sales_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_ref" text NOT NULL,
	"line_no" integer DEFAULT 1 NOT NULL,
	"invoiced_on" date NOT NULL,
	"customer_id" uuid,
	"machine_id" uuid,
	"make" text NOT NULL,
	"part_number" text NOT NULL,
	"part_number_norm" text NOT NULL,
	"qty" integer NOT NULL,
	"net_pence" integer,
	"batch_id" uuid
);
--> statement-breakpoint
ALTER TABLE "content_licences" ADD COLUMN "kind" text DEFAULT 'manufacturer_licence' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_licences" ADD COLUMN "scope" text DEFAULT 'tenant' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_licences" ADD COLUMN "permission_ref" text;--> statement-breakpoint
ALTER TABLE "content_licences" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "content_licences" ADD COLUMN "contact" text;--> statement-breakpoint
ALTER TABLE "ingest_batches" ADD COLUMN "data_source_id" uuid;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD COLUMN "page" integer;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD COLUMN "figure_ref" text;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD COLUMN "serial_from" text;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD COLUMN "serial_to" text;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD COLUMN "confidence" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD COLUMN "verified_by" text;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
-- Hand-added: procedures that existed before the lifecycle were already visible; keep them so.
UPDATE "procedures" SET "status" = 'published';--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN "origin" text DEFAULT 'manual_entry' NOT NULL;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN "extraction_run_id" uuid;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN "check_report" jsonb;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN "verified_by" text;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "service_documents" ADD COLUMN "file_key" text;--> statement-breakpoint
ALTER TABLE "service_documents" ADD COLUMN "file_sha256" text;--> statement-breakpoint
ALTER TABLE "service_documents" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "service_documents" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "service_documents" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_documents" ADD COLUMN "status" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_flags" ADD CONSTRAINT "content_flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_flags" ADD CONSTRAINT "content_flags_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reviews" ADD CONSTRAINT "content_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reviews" ADD CONSTRAINT "content_reviews_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_licence_id_content_licences_id_fk" FOREIGN KEY ("licence_id") REFERENCES "public"."content_licences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_machine_model_id_machine_models_id_fk" FOREIGN KEY ("machine_model_id") REFERENCES "public"."machine_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_document_id_service_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."service_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_document_id_service_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."service_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_sales_history" ADD CONSTRAINT "part_sales_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_sales_history" ADD CONSTRAINT "part_sales_history_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_sales_history" ADD CONSTRAINT "part_sales_history_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_sales_history" ADD CONSTRAINT "part_sales_history_batch_id_ingest_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."ingest_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_flags_tenant_status_idx" ON "content_flags" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "content_reviews_proc_idx" ON "content_reviews" USING btree ("procedure_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_sources_tenant_code_uq" ON "data_sources" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "document_links_lookup_idx" ON "document_links" USING btree ("tenant_id","make");--> statement-breakpoint
CREATE INDEX "extraction_runs_doc_idx" ON "extraction_runs" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "part_sales_history_line_uq" ON "part_sales_history" USING btree ("tenant_id","invoice_ref","line_no");--> statement-breakpoint
CREATE INDEX "part_sales_history_customer_idx" ON "part_sales_history" USING btree ("tenant_id","customer_id","invoiced_on");--> statement-breakpoint
CREATE INDEX "part_sales_history_part_idx" ON "part_sales_history" USING btree ("tenant_id","make","part_number_norm");--> statement-breakpoint
CREATE INDEX "part_sales_history_machine_idx" ON "part_sales_history" USING btree ("machine_id");--> statement-breakpoint
ALTER TABLE "ingest_batches" ADD CONSTRAINT "ingest_batches_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD CONSTRAINT "part_fitment_batch_id_ingest_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."ingest_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD CONSTRAINT "part_fitment_document_id_service_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."service_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedures" ADD CONSTRAINT "procedures_extraction_run_id_extraction_runs_id_fk" FOREIGN KEY ("extraction_run_id") REFERENCES "public"."extraction_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "procedures_tenant_status_idx" ON "procedures" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "service_documents_sha_idx" ON "service_documents" USING btree ("tenant_id","file_sha256");