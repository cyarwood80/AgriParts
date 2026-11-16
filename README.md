# AgriParts v2

API-first, MCP-native **parts and stock platform for UK agricultural machinery dealers**. It's the first module of a challenger to Ibcos Gold: win the parts counter and purchasing first, running *alongside* Gold, then take on workshop, wholegoods and accounts one module at a time.

v1 was a read-only parts master with MCP tools. v2 keeps its rules (normaliser, supersession graph, provenance, identity never from tool arguments) and adds the transactional core a dealer actually runs on.

## What works today

| Area | What it does |
|---|---|
| **Find a part** (ADR-0003) | The parts desk at `/app`: a queue of customer enquiries (stopped machines first, callback timers), the conversation with a **draft reply**, the **best match with its evidence** (parts-book fitment, supersession chain, this customer's purchase history, what they described), price, stock, the fitting guide and what's usually needed with it. One question when two parts fit. Safety-critical parts, low confidence after 3 rounds, or no match go to a person with a named callback time. Resolving teaches fitment for that model. Claude agent with `ANTHROPIC_API_KEY`, offline matcher without |
| **Parts master** | Multi-make parts, supersession chains with a fitting-change flag, cross-brand equivalents (verified/unverified), trigram search that tolerates typos and any brand's number format |
| **Stock ledger** | Append-only movements plus balances updated in the same transaction. Row locking stops two counters overselling the last unit (tested concurrently on real Postgres). Includes a reconciliation check |
| **Pricing** | Contract price, then discount matrix (price band × discount code), then list. Every price carries its reason. Integer pence, UK VAT per line |
| **Sales** | Quote, confirm (allocate or backorder), invoice (partial invoicing supported), cancel. Supersessions are applied, and the customer's requested number is kept for audit |
| **Purchasing** | Draft POs (stock or VOR), sent through pluggable supplier adapters. Goods received are **automatically allocated to waiting customer backorders** |
| **Insights** | Explainable reorder suggestions (demand, lead time, on-order, backorders, pack size), dead stock valued at cost, and inter-depot rebalancing |
| **Integrations** | Price-file import (CSV or fixed-width, dry-run diff, provenance, idempotent), Ibcos Gold bridge (opening load plus nightly stock sync), Xero invoices, signed webhooks, event feed |
| **REST API** | OpenAPI-documented (31 paths) at `/docs`, API keys with scopes, `Idempotency-Key` on POSTs |
| **Field guidance** | Licensed manufacturer procedures aligned to the part being swapped and the machine (by serial). Found through supersessions, specs quoted verbatim with page references. Engineers save **offline job packs** that expire with the shortest licence window, are audited, and can be revoked. Licence rules decide what can go offline or to AI agents |
| **Real data in** (ADR-0005) | Registry of data sources, plus:<br>• Ibcos **machines** (wholegoods) and **sales-history** imports<br>• parts-book **fitment** with page, figure and serial breaks<br>• unverified fitment inferred from repeat sales<br>• manual pipeline: register the licensed PDF, extract per-page text, run Claude extraction (`npm run manuals:ingest`), check every spec **verbatim** against its cited page, then **foreman review** before anything is published<br>• **foreman review screen** (`/app/#/review`): each step beside its cited page, specs highlighted, edit and re-check, approve or reject<br>• engineer flags on steps, and the cited page one tap away in the field guide<br>• OEM-portal deep links |
| **Teardown** (prototype, ADR-0006) | `/app/#/field/explode/demo`: a 3D exploded view in workshop-manual line style (invented demo geometry), numbered callouts, tap a piece for its part number, and a walkthrough driven by the published procedure (step moves the parts it touches, spec and page as printed). three.js loads on demand from a CDN, so the rest of the app never depends on it |
| **Web UI** | `/app` in the Linchpin brand: **Find a part** (the desk above), the field guide with **job mode** (one step per screen, dark, glove-sized buttons, spec as printed with its page, hands-free next/back where the browser supports it, works from offline packs), content review for the foreman, and the older counter, orders and insights screens |
| **MCP server** | 16 tools, 2 prompts and resources, over stdio and Streamable HTTP. Tools are filtered by key scope. **Write tools are two-phase**: a preview returns a confirmation code bound to the exact action and current state |

**Tests:** 86 tests (unit, service, HTTP and real MCP client). All pass on in-process Postgres (PGlite). The PostgreSQL 16 run (`npm run test:pg`) hasn't been repeated since the field-guidance and data-source changes.

## Quick start

No database server needed for a demo. PGlite runs Postgres in-process:

```bash
npm install
SEED_DEMO=true npm start            # UI at /app, API on :3000, docs at /docs, MCP at /mcp
```

The demo API keys are printed once at start-up, plus a sign-in link for the web UI (a fresh demo key on every start). Then:

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
