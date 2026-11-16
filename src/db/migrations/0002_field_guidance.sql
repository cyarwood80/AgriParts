CREATE TABLE "content_licences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"publisher" text NOT NULL,
	"title" text NOT NULL,
	"reference" text,
	"allow_offline" boolean DEFAULT false NOT NULL,
	"allow_ai" boolean DEFAULT false NOT NULL,
	"offline_days" integer DEFAULT 14 NOT NULL,
	"valid_from" date,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guidance_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pack_ref" text NOT NULL,
	"issued_to" text NOT NULL,
	"machine_id" uuid,
	"job_ref" text,
	"part_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"procedure_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "machine_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"make" text NOT NULL,
	"model" text NOT NULL,
	"series" text,
	"kind" text,
	"year_from" integer,
	"year_to" integer
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid,
	"machine_model_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"reg_no" text,
	"year" integer,
	"engine_hours" integer,
	"site" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "part_fitment" (
	"tenant_id" uuid NOT NULL,
	"machine_model_id" uuid NOT NULL,
	"make" text NOT NULL,
	"part_number_norm" text NOT NULL,
	"assembly" text,
	"qty_per_machine" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "part_fitment_machine_model_id_make_part_number_norm_pk" PRIMARY KEY("machine_model_id","make","part_number_norm")
);
--> statement-breakpoint
CREATE TABLE "procedure_parts" (
	"tenant_id" uuid NOT NULL,
	"procedure_id" uuid NOT NULL,
	"make" text NOT NULL,
	"part_number_norm" text NOT NULL,
	"role" text DEFAULT 'replaced' NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "procedure_parts_procedure_id_make_part_number_norm_pk" PRIMARY KEY("procedure_id","make","part_number_norm")
);
--> statement-breakpoint
CREATE TABLE "procedure_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"procedure_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"instruction" text NOT NULL,
	"page" integer,
	"specs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"caution" text
);
--> statement-breakpoint
CREATE TABLE "procedures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"machine_model_id" uuid,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"est_minutes" integer,
	"skill" text DEFAULT 'competent' NOT NULL,
	"page_from" integer,
	"page_to" integer,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"safety" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"licence_id" uuid NOT NULL,
	"make" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"doc_ref" text NOT NULL,
	"revision" text,
	"published_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_licences" ADD CONSTRAINT "content_licences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_packs" ADD CONSTRAINT "guidance_packs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_packs" ADD CONSTRAINT "guidance_packs_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_models" ADD CONSTRAINT "machine_models_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_machine_model_id_machine_models_id_fk" FOREIGN KEY ("machine_model_id") REFERENCES "public"."machine_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD CONSTRAINT "part_fitment_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_fitment" ADD CONSTRAINT "part_fitment_machine_model_id_machine_models_id_fk" FOREIGN KEY ("machine_model_id") REFERENCES "public"."machine_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_parts" ADD CONSTRAINT "procedure_parts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_parts" ADD CONSTRAINT "procedure_parts_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD CONSTRAINT "procedure_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD CONSTRAINT "procedure_steps_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedures" ADD CONSTRAINT "procedures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedures" ADD CONSTRAINT "procedures_document_id_service_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."service_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedures" ADD CONSTRAINT "procedures_machine_model_id_machine_models_id_fk" FOREIGN KEY ("machine_model_id") REFERENCES "public"."machine_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_documents" ADD CONSTRAINT "service_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_documents" ADD CONSTRAINT "service_documents_licence_id_content_licences_id_fk" FOREIGN KEY ("licence_id") REFERENCES "public"."content_licences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guidance_packs_tenant_ref_uq" ON "guidance_packs" USING btree ("tenant_id","pack_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_models_tenant_make_model_uq" ON "machine_models" USING btree ("tenant_id","make","model");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_tenant_serial_uq" ON "machines" USING btree ("tenant_id","serial");--> statement-breakpoint
CREATE INDEX "procedure_parts_lookup_idx" ON "procedure_parts" USING btree ("tenant_id","make","part_number_norm");--> statement-breakpoint
CREATE UNIQUE INDEX "procedure_steps_proc_seq_uq" ON "procedure_steps" USING btree ("procedure_id","seq");--> statement-breakpoint
CREATE INDEX "procedures_tenant_doc_idx" ON "procedures" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "service_documents_tenant_idx" ON "service_documents" USING btree ("tenant_id","make");