# Architecture and decisions

## The bet (unchanged from v1)

UK ag dealers run on Ibcos Gold (Constellation Software / Perseus). Gold has no public API: data moves in and out as files. Replacing the whole platform at once (around £20k/year per dealer, 45 years of workflow) is the wrong first move. Instead we **win one segment, the parts counter and purchasing, and run beside Gold**. We use API and MCP access as the wedge Gold can't match, then expand module by module.

## Shape

```
            ┌──────────── REST /v1 (OpenAPI) ────────────┐
 counter UI │                                            │  resellers, dealer tools
 & apps ────┤                                            ├──── webhooks / event feed
            │          src/services  (all rules)         │
 AI agents ─┤   parts · pricing · stock · orders ·       ├──── accounting (Xero …)
 (MCP)      │   purchasing · insights · customers        │
            └──────────── MCP /mcp + stdio ──────────────┘──── supplier ordering adapters
                                  │
                     Postgres (PGlite for dev/test)
                ledger · outbox · provenance · audit
```

One process today: API, MCP and the outbox dispatcher. They share only the database, so they can be split later without code changes.

## Decisions

1. **One service layer, two front doors.** REST and MCP build a `ServiceContext` (tenant, actor, scopes, channel) from the API key and call the same functions. A rule changes once, in one place.
2. **Identity from the transport, never from input** (v1 rule). No tool or endpoint accepts a tenant or user id.
3. **Stock is a ledger.** `stock_movements` is append-only. `stock_levels` is a balance updated in the same transaction, behind `SELECT … FOR UPDATE`, with rows locked in a stable order to avoid deadlocks. `reconcileLedger()` proves the two agree. Negative stock is blocked unless a tenant opts in.
4. **Money is integer pence; rates are basis points.** VAT is calculated per line, rounding half up (HMRC allows line or invoice level; line level matches Xero's default).
5. **Supersession is a graph keyed by part number**, not by part id. A manufacturer can supersede to a number the dealer has never stocked. Each hop carries `interchangeable`. If any hop changes fitting, the counter and the agent get a warning (v1 rule). The customer's requested number is kept on the order line.
6. **Provenance on every import** (v1 rule). Price files and Ibcos exports are `ingest_batches` with row-level `ingest_issues`, and parts record the batch that last set their price. Re-loading the same file with the same mapping does nothing; a corrected mapping is a new load. Dry-run is the API default.
7. **Transactional outbox.** Services write `domain_events` in the same transaction as the change. A dispatcher fans each event out to webhook subscriptions and integration connections, delivers on a lease (no locks held across the network), retries with backoff and dead-letters after 10 attempts. Delivery is at least once; receivers de-duplicate on delivery id, and Xero on an idempotency key.
8. **External calls never inside DB transactions.** Sending a PO calls the supplier adapter first, then commits with a conditional `status='draft'` update, so a double-send is detected. Adapters de-duplicate on our PO number.
9. **Insights are deterministic and explainable.** Every reorder line states its inputs and the rule. An ML demand forecast can replace the estimate later without changing the contract.
10. **Postgres everywhere, PGlite for zero-setup.** The same migrations run on PGlite (tests, demos, a laptop at a dealer) and on Postgres 16 (production). CI should run both.
11. **API keys now, OAuth 2.1 next.** Keys are `ap_<prefix>_<secret>`, stored as a SHA-256 hash and scoped. OAuth for MCP clients acting as named users will issue the same principal shape.

## Data model (summary)

`tenants` → `depots`, `suppliers`, `parts` (+ `part_supersessions`, `part_crossrefs`), `stock_levels` / `stock_movements`, `customers` (+ `discount_matrix`, `customer_special_prices`), `sales_orders` / `sales_order_lines`, `invoices` / `invoice_lines`, `purchase_orders` / `purchase_order_lines`. Platform tables: `domain_events`, `event_deliveries`, `webhook_subscriptions`, `integration_connections`, `integration_runs`, `ingest_batches` / `ingest_issues`, `api_keys`, `idempotency_keys`, `audit_log`, `tool_call_log`, `number_sequences`.

Every business table has `tenant_id`, and services always filter on it. **Postgres row-level security is the planned second line of defence. It is not yet enabled.**

## Field guidance (ported from v1, extended)

`machine_models`, `machines` (by serial, per customer), `part_fitment`, `content_licences`, `service_documents`, `procedures` (+ `procedure_steps`, `procedure_parts`) and `guidance_packs`. Rules:

- **Licensed or invisible.** Every document hangs off a licence. Expired licences hide their content; responses say how much was withheld and why.
- **Purpose-aware.** `allow_offline` gates job packs, `allow_ai` gates the MCP `find_fitting_instructions` tool. Online viewing needs only a live licence.
- **Keyed by part number**, like supersessions, and looked up across the whole supersession chain, so an engineer holding the old number still finds the right procedure.
- **Specs verbatim** with document ref and page. Never estimated.
- **Offline packs** (`POST /v1/guidance/packs`) bundle machine, parts and procedures. Expiry is the shortest licence window. Each issue is audited (`guidance.pack_issued`). Devices re-check `GET /v1/guidance/packs/:ref` when online; the server's expiry and revocation win.

Still to port from v1: consented telematics (`predict_parts`) and multi-supplier offers.
