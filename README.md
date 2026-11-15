# AgriParts v2

API-first, MCP-native **parts and stock platform for UK agricultural machinery dealers**. It's the first module of a challenger to Ibcos Gold: win the parts counter and purchasing first, running *alongside* Gold, then take on workshop, wholegoods and accounts one module at a time.

v1 was a read-only parts master with MCP tools. v2 keeps its rules (normaliser, supersession graph, provenance, identity never from tool arguments) and adds the transactional core a dealer actually runs on.

## What works today

| Area | What it does |
|---|---|
| **Parts master** | Multi-make parts, supersession chains with a fitting-change flag, cross-brand equivalents (verified/unverified), trigram search that tolerates typos and any brand's number format |
| **Stock ledger** | Append-only movements plus balances updated in the same transaction. Row locking stops two counters overselling the last unit (tested concurrently on real Postgres). Includes a reconciliation check |
| **Pricing** | Contract price, then discount matrix (price band × discount code), then list. Every price carries its reason. Integer pence, UK VAT per line |
| **Sales** | Quote, confirm (allocate or backorder), invoice (partial invoicing supported), cancel. Supersessions are applied, and the customer's requested number is kept for audit |
| **Purchasing** | Draft POs (stock or VOR), sent through pluggable supplier adapters. Goods received are **automatically allocated to waiting customer backorders** |
| **Insights** | Explainable reorder suggestions (demand, lead time, on-order, backorders, pack size), dead stock valued at cost, and inter-depot rebalancing |
| **Integrations** | Price-file import (CSV or fixed-width, dry-run diff, provenance, idempotent), Ibcos Gold bridge (opening load plus nightly stock sync), Xero invoices, signed webhooks, event feed |
| **REST API** | OpenAPI-documented (31 paths) at `/docs`, API keys with scopes, `Idempotency-Key` on POSTs |
| **MCP server** | 16 tools, 2 prompts and resources, over stdio and Streamable HTTP. Tools are filtered by key scope. **Write tools are two-phase**: a preview returns a confirmation code bound to the exact action and current state |

**Tests:** 45 tests (unit, service, HTTP and real MCP client) pass on both in-process Postgres (PGlite) and **PostgreSQL 16**.

## Quick start

No database server needed for a demo. PGlite runs Postgres in-process:

```bash
npm install
SEED_DEMO=true npm start            # API on :3000, docs at /docs, MCP at /mcp
```

The demo API keys are printed once at start-up. Then:

```bash
curl -s "localhost:3000/v1/parts/resolve?partNumber=acm%2010021&make=ACM" -H "Authorization: Bearer ap_..."
```

For production Postgres:

```bash
DATABASE_URL=postgres://user:pass@host:5432/agriparts AGRIPARTS_CONFIRM_SECRET=$(openssl rand -hex 32) npm start
```

Run the tests:

```bash
npm test
```

Or against a real Postgres server:

```bash
TEST_PG_URL=postgres://postgres@localhost:5432/postgres npm run test:pg
```

## Connect Claude (or any MCP client)

Claude Desktop / Claude Code over stdio:

```json
{
  "mcpServers": {
    "agriparts": {
      "command": "npx",
      "args": ["tsx", "/path/to/agriparts/src/mcp/stdio.ts"],
      "env": { "DATABASE_URL": "postgres://...", "AGRIPARTS_API_KEY": "ap_..." }
    }
  }
}
```

Remote clients use **Streamable HTTP**: `POST https://<host>/mcp` with `Authorization: Bearer ap_...`.

Try: *"Brook Lane want 2 of ACM-10021 and a box of grease from HQ. What do we supply, what's their price, and can we do it today?"* The agent resolves the supersession, prices it for their account, and checks every depot. It previews the order and confirms only after you say yes.

## Layout

```
src/db/schema.ts            data model (read first)
src/services/               business rules, shared by REST and MCP
src/integrations/           price files, Ibcos bridge, supplier ordering, accounting, webhooks/outbox
src/api/                    REST (Fastify + zod + OpenAPI)
src/mcp/                    MCP server, two-phase confirmation, prompts, stdio entry
fixtures/                   demo price files and mappings (invented data)
test/                       vitest suites
docs/                       ARCHITECTURE, INTEGRATIONS, MCP, ROADMAP
```

All makes, part numbers, prices, customers and farms in the demo data are invented.
