-- Trigram search on part numbers and descriptions (fuzzy counter search:
-- "flail hamer 80" still finds "Flail hammer, 80mm"). Requires pg_trgm,
-- which ships with Postgres and with PGlite's contrib bundle.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parts_pn_trgm" ON "parts" USING gin ("part_number_norm" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parts_desc_trgm" ON "parts" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
-- Ledger integrity: allocations and on-order can never go negative.
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_allocated_nonneg" CHECK ("allocated" >= 0);
--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_on_order_nonneg" CHECK ("on_order" >= 0);
--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "so_lines_qty_balance" CHECK ("qty" = "qty_invoiced" + "qty_allocated" + "qty_backordered" OR "qty_invoiced" + "qty_allocated" + "qty_backordered" = 0);
--> statement-breakpoint
ALTER TABLE "part_supersessions" ADD CONSTRAINT "supersession_not_self" CHECK ("from_part_number_norm" <> "to_part_number_norm");
