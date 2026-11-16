# Roadmap

## Segment strategy

Don't fight Ibcos for the whole platform. Win the **parts department**: it's high-frequency, high-margin, measurable, and the place where Gold's age shows most. Sell it through the reseller as a module that sits beside Gold:

- **Day 1 value without migration:** faster counter lookup (any number format, typos, supersessions with fitting warnings), customer-specific pricing with reasons, cross-depot availability, and backorders that allocate themselves when goods arrive.
- **Purchasing intelligence:** reorder suggestions with reasons, rebalancing before buying, dead stock, VOR handling.
- **Open by default:** REST, webhooks and MCP, which Gold doesn't offer.
- **Later**, Gold's other modules are replaced one at a time, starting with workshop (parts issued to jobs are already a movement type).

## Phase 1: pilot-ready (next)

| Item | Why |
|---|---|
| Real Ibcos export mappings from the reseller's partner dealer | Bridge column names are placeholders today |
| Counter UI (web, keyboard-first) on the REST API | Staff won't use curl; the agent isn't the only user |
| OAuth 2.1 for users and MCP clients; per-user identity at the counter | Shared keys are fine for a demo, not for audit |
| Postgres row-level security on `tenant_id` | Second line of tenant isolation |
| Decimal units of measure (hose by the metre, oil by the litre) | Quantities are whole units today; fractional rows are rejected with a clear issue |
| Sell down superseded stock first when the swap is interchangeable | Today resolution always picks the newest active number |
| Xero OAuth connect flow, token refresh, contact sync | Pilot uses an injected token |
| Hosting: managed Postgres (UK region), backups/PITR, secrets, CI running both PGlite and Postgres, error tracking | Operational basics |
| Streaming price-file parser | Big OEM files (hundreds of thousands of rows) |

## Phase 2: differentiate

- Field guidance is in (fitment, licensed procedures, offline job packs). Next: manual ingestion pipeline, first publisher licence, revocation UI, encrypt packs at rest on device.
- Port the remaining v1 differentiators: consented-telematics `predict_parts` and multi-supplier offers.
- First real OEM or allmakes ordering adapter (whichever the pilot dealer uses most).
- Sage 50/200 accounting adapter.
- Demand forecasting (seasonality: harvest, silage, hedge-cutting) behind the existing reorder contract.
- Customer notifications on `backorder.allocated` (SMS/email).
- Barcode stock-take and goods-in on mobile.

## Phase 3: expand the wedge

- Workshop jobs (parts issue, labour, warranty claims).
- Wholegoods (new/used machines, trade-ins, deal chains).
- Hire and fleet.
- Full accounts, or a deliberate decision to integrate (Xero/Sage) rather than own the ledger.

## Known gaps (be honest with the reseller)

- Web UI is a demo front end (no build step, API key sign-in). Needs per-user login (OAuth) before a pilot.
- Field-guidance content is invented. Real manuals need a licence from each publisher, and an ingestion pipeline (PDF → procedures/steps/specs with page refs) that doesn't exist yet.
- Ibcos column mappings are unconfirmed.
- No real OEM integrations yet. Each needs that OEM's dealer programme access.
- Single currency (GBP). VAT covers standard, reduced and zero rates only (no reverse charge, margin scheme, etc.).
- API keys only; no SSO.
