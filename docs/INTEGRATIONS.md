# Integrations

Status key: **Built** = implemented and tested. **Built (needs access)** = code done, but a real connection needs credentials or an agreement. **Planned** = designed, not built.

## Inbound data

| Source | Route | Status |
|---|---|---|
| Supplier / OEM price files | `POST /v1/integrations/price-files` with a JSON mapping. CSV or fixed-width, prices in £ or pence, skip rules, supersession columns. Dry run returns a diff (new parts, price moves, big-move warnings) | **Built** |
| Ibcos Gold | `POST /v1/integrations/ibcos/import` for customers, parts and stock. Stock `opening` posts opening balances; `sync` resets to Gold's figure nightly via auditable adjustments | **Built, with placeholder column names** (see below) |
| Allmakes suppliers (Kramp etc.) | Product/price feeds through the price-file importer; ordering through an adapter | Planned (commercial account) |
| Telematics (Deere, CNH, JCB via ISO 15143-3; Leaf; agrirouter) | Port v1 `predict_parts` and add an ISO 15143-3 poller | Planned (farmer consent + OEM approval) |

### Ibcos Gold: what we need from the reseller

The bridge works end to end, but **the default column names are guesses** (`IBCOS_PLACEHOLDER_MAPPINGS` in `src/integrations/legacy-import/ibcos-bridge.ts`). Mappings are configuration, so real exports only need a mapping change, not code. Ask the reseller or partner dealer for:

1. Sample exports (anonymised is fine): customer list, parts master with prices, stock by depot including bins and min/max.
2. How exports are produced: a scheduled report, a manual export, or ODBC/DB access with the dealer's agreement.
3. Depot naming in Gold, which fills `depotMap`.
4. Whether quantities can be fractional (hose by the metre, oil by the litre). We currently reject fractional quantities with a clear issue; see ROADMAP.

The coexistence pattern: **Gold stays the system of record for stock and accounts during a pilot.** AgriParts runs the counter, quoting, backorders and purchasing intelligence. A nightly Gold stock export keeps on-hand aligned, and every difference is a visible adjustment movement.

## Outbound

| Target | Route | Status |
|---|---|---|
| Supplier ordering | `SupplierOrderingAdapter` per supplier: `manual`, `csv-export` (universal fallback: email or portal upload), `mock-oem` (simulates an OEM API for demos) | **Built** |
| OEM dealer ordering (Deere, CNH, AGCO, CLAAS…) | One adapter each behind the same interface | Planned (needs each OEM's dealer programme access) |
| Xero | `invoice.created` → ACCREC invoice, UK tax types, `xero-tenant-id`, `Idempotency-Key`, DRAFT by default | **Built (needs access)**: token from env for a pilot; OAuth connect flow planned |
| Sage 50 / Sage 200 | Same `AccountingAdapter` interface | Planned |
| Ibcos Gold (write-back) | Export files for Gold import (e.g. invoices) | Planned, once Gold's import formats are known |
| Webhooks | `POST /v1/webhooks`. HMAC-SHA256 `AgriParts-Signature: t=…,v1=…`, at-least-once delivery, retries with backoff, dead-letter | **Built** |
| Event feed | `GET /v1/events?after=<cursor>`, for systems that prefer polling | **Built** |

### Event types

`quote.created`, `order.confirmed`, `order.cancelled`, `invoice.created`, `backorder.allocated`, `stock.adjusted`, `stock.transferred`, `purchase_order.sent`, `goods.received`, `price_file.loaded`, `legacy_import.loaded`.

`backorder.allocated` is the one dealers will feel most: a part arrives and the customer can be texted straight away.

## Adding an integration

1. Implement the interface: `SupplierOrderingAdapter` (`src/integrations/ordering/types.ts`) or `AccountingAdapter` (`src/integrations/accounting/types.ts`).
2. Keep it pure apart from an injected `fetch`, so it's testable with a fake (see the Xero tests).
3. Register it (`defaultOrderingRegistry()` or the accounting map in `src/main.ts`).
4. Outbound event consumers get an `integration_connections` row listing the event types they consume. The dispatcher handles retries.
