CREATE TYPE "public"."batch_status" AS ENUM('running', 'loaded', 'dry_run', 'failed');--> statement-breakpoint
CREATE TYPE "public"."crossref_kind" AS ENUM('oem_equivalent', 'pattern_for', 'rebadge');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'done', 'dead');--> statement-breakpoint
CREATE TYPE "public"."movement_type" AS ENUM('opening', 'receipt', 'sale', 'sale_return', 'transfer_out', 'transfer_in', 'adjustment', 'workshop_issue');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('draft', 'sent', 'part_received', 'received', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sales_order_status" AS ENUM('quote', 'confirmed', 'part_invoiced', 'invoiced', 'cancelled');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"channel" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_special_prices" (
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"price_pence" integer NOT NULL,
	"valid_until" date,
	CONSTRAINT "customer_special_prices_customer_id_part_id_pk" PRIMARY KEY("customer_id","part_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_code" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"postcode" text,
	"price_band" text DEFAULT 'RETAIL' NOT NULL,
	"on_stop" boolean DEFAULT false NOT NULL,
	"credit_limit_pence" integer,
	"accounting_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "depots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discount_matrix" (
	"tenant_id" uuid NOT NULL,
	"price_band" text NOT NULL,
	"discount_code" text NOT NULL,
	"discount_bps" integer NOT NULL,
	CONSTRAINT "discount_matrix_tenant_id_price_band_discount_code_pk" PRIMARY KEY("tenant_id","price_band","discount_code")
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fanned_out_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "event_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" integer NOT NULL,
	"target" text NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"last_response_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "ingest_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"source_name" text NOT NULL,
	"checksum" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"row_count" integer,
	"status" "batch_status" DEFAULT 'running' NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ingest_issues" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_no" integer,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_types" text[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"description" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_net_pence" integer NOT NULL,
	"line_net_pence" integer NOT NULL,
	"vat_rate_bps" integer NOT NULL,
	"line_vat_pence" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"net_pence" integer NOT NULL,
	"vat_pence" integer NOT NULL,
	"gross_pence" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_date" date NOT NULL,
	"accounting_ref" text
);
--> statement-breakpoint
CREATE TABLE "number_sequences" (
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"next_value" integer NOT NULL,
	CONSTRAINT "number_sequences_tenant_id_name_pk" PRIMARY KEY("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "part_crossrefs" (
	"tenant_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"ref_part_id" uuid NOT NULL,
	"kind" "crossref_kind" NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"verified_by" text,
	"batch_id" uuid,
	CONSTRAINT "part_crossrefs_part_id_ref_part_id_kind_pk" PRIMARY KEY("part_id","ref_part_id","kind")
);
--> statement-breakpoint
CREATE TABLE "part_supersessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"make" text NOT NULL,
	"from_part_number_norm" text NOT NULL,
	"to_part_number_norm" text NOT NULL,
	"qty_ratio" integer DEFAULT 1 NOT NULL,
	"interchangeable" boolean DEFAULT true NOT NULL,
	"effective_date" date,
	"note" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"make" text NOT NULL,
	"part_number" text NOT NULL,
	"part_number_norm" text NOT NULL,
	"description" text NOT NULL,
	"uom" text DEFAULT 'EA' NOT NULL,
	"discount_code" text,
	"list_price_pence" integer DEFAULT 0 NOT NULL,
	"cost_price_pence" integer DEFAULT 0 NOT NULL,
	"vat_code" text DEFAULT 'S' NOT NULL,
	"pack_qty" integer DEFAULT 1 NOT NULL,
	"barcode" text,
	"supplier_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"price_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"qty_ordered" integer NOT NULL,
	"qty_received" integer DEFAULT 0 NOT NULL,
	"unit_cost_pence" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"depot_id" uuid NOT NULL,
	"status" "purchase_order_status" DEFAULT 'draft' NOT NULL,
	"order_type" text DEFAULT 'stock' NOT NULL,
	"external_ref" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"part_id" uuid NOT NULL,
	"requested_part_number" text NOT NULL,
	"qty" integer NOT NULL,
	"qty_allocated" integer DEFAULT 0 NOT NULL,
	"qty_backordered" integer DEFAULT 0 NOT NULL,
	"qty_invoiced" integer DEFAULT 0 NOT NULL,
	"unit_list_pence" integer NOT NULL,
	"unit_net_pence" integer NOT NULL,
	"unit_cost_pence" integer NOT NULL,
	"vat_rate_bps" integer NOT NULL,
	"line_net_pence" integer NOT NULL,
	"price_explanation" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"depot_id" uuid NOT NULL,
	"status" "sales_order_status" DEFAULT 'quote' NOT NULL,
	"customer_ref" text,
	"channel" text DEFAULT 'counter' NOT NULL,
	"notes" text,
	"net_pence" integer DEFAULT 0 NOT NULL,
	"vat_pence" integer DEFAULT 0 NOT NULL,
	"gross_pence" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"tenant_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"depot_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"allocated" integer DEFAULT 0 NOT NULL,
	"on_order" integer DEFAULT 0 NOT NULL,
	"bin" text,
	"min_qty" integer,
	"max_qty" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_levels_part_id_depot_id_pk" PRIMARY KEY("part_id","depot_id")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"depot_id" uuid NOT NULL,
	"type" "movement_type" NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_pence" integer DEFAULT 0 NOT NULL,
	"reference_type" text,
	"reference_id" text,
	"note" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"ordering_adapter" text DEFAULT 'manual' NOT NULL,
	"adapter_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lead_time_days" integer DEFAULT 7 NOT NULL,
	"account_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_call_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"principal" text NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"ok" boolean NOT NULL,
	"result_summary" text,
	"duration_ms" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"event_types" text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_special_prices" ADD CONSTRAINT "customer_special_prices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_special_prices" ADD CONSTRAINT "customer_special_prices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_special_prices" ADD CONSTRAINT "customer_special_prices_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depots" ADD CONSTRAINT "depots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_matrix" ADD CONSTRAINT "discount_matrix_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_batches" ADD CONSTRAINT "ingest_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_issues" ADD CONSTRAINT "ingest_issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_issues" ADD CONSTRAINT "ingest_issues_batch_id_ingest_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."ingest_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_runs" ADD CONSTRAINT "integration_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_crossrefs" ADD CONSTRAINT "part_crossrefs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_crossrefs" ADD CONSTRAINT "part_crossrefs_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_crossrefs" ADD CONSTRAINT "part_crossrefs_ref_part_id_parts_id_fk" FOREIGN KEY ("ref_part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_crossrefs" ADD CONSTRAINT "part_crossrefs_batch_id_ingest_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."ingest_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_supersessions" ADD CONSTRAINT "part_supersessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_supersessions" ADD CONSTRAINT "part_supersessions_batch_id_ingest_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."ingest_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_price_batch_id_ingest_batches_id_fk" FOREIGN KEY ("price_batch_id") REFERENCES "public"."ingest_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_depot_id_depots_id_fk" FOREIGN KEY ("depot_id") REFERENCES "public"."depots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_depot_id_depots_id_fk" FOREIGN KEY ("depot_id") REFERENCES "public"."depots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_depot_id_depots_id_fk" FOREIGN KEY ("depot_id") REFERENCES "public"."depots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_depot_id_depots_id_fk" FOREIGN KEY ("depot_id") REFERENCES "public"."depots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_log" ADD CONSTRAINT "tool_call_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_uq" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "audit_tenant_time_idx" ON "audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_account_uq" ON "customers" USING btree ("tenant_id","account_code");--> statement-breakpoint
CREATE UNIQUE INDEX "depots_tenant_code_uq" ON "depots" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "events_tenant_id_idx" ON "domain_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "events_fanout_idx" ON "domain_events" USING btree ("fanned_out_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_event_target_uq" ON "event_deliveries" USING btree ("event_id","target");--> statement-breakpoint
CREATE INDEX "deliveries_due_idx" ON "event_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "ingest_batches_lookup_idx" ON "ingest_batches" USING btree ("tenant_id","kind","source","checksum");--> statement-breakpoint
CREATE INDEX "ingest_issues_batch_idx" ON "ingest_issues" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "integration_runs_tenant_idx" ON "integration_runs" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_number_uq" ON "invoices" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "crossrefs_ref_idx" ON "part_crossrefs" USING btree ("ref_part_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supersessions_from_uq" ON "part_supersessions" USING btree ("tenant_id","make","from_part_number_norm");--> statement-breakpoint
CREATE UNIQUE INDEX "parts_tenant_make_pn_uq" ON "parts" USING btree ("tenant_id","make","part_number_norm");--> statement-breakpoint
CREATE INDEX "parts_tenant_pn_idx" ON "parts" USING btree ("tenant_id","part_number_norm");--> statement-breakpoint
CREATE INDEX "parts_tenant_barcode_idx" ON "parts" USING btree ("tenant_id","barcode");--> statement-breakpoint
CREATE INDEX "po_lines_po_idx" ON "purchase_order_lines" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_tenant_number_uq" ON "purchase_orders" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "so_lines_order_idx" ON "sales_order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "so_lines_part_idx" ON "sales_order_lines" USING btree ("part_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_tenant_number_uq" ON "sales_orders" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "sales_orders_customer_idx" ON "sales_orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "stock_levels_tenant_depot_idx" ON "stock_levels" USING btree ("tenant_id","depot_id");--> statement-breakpoint
CREATE INDEX "movements_part_depot_time_idx" ON "stock_movements" USING btree ("part_id","depot_id","created_at");--> statement-breakpoint
CREATE INDEX "movements_tenant_type_time_idx" ON "stock_movements" USING btree ("tenant_id","type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_tenant_code_uq" ON "suppliers" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "tool_call_log_tenant_idx" ON "tool_call_log" USING btree ("tenant_id","at");