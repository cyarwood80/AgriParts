# Handover: cloud session → desktop (15 Nov 2026)

Read this, then `CLAUDE.md`, `README.md` and `docs/`. Delete this file once the items below are picked up.

## Where things stand

- **AgriParts v2** = v1 (read-only parts master + MCP, the original `agriparts.zip`) evolved into a transactional parts platform: stock ledger, pricing, quotes/orders/backorders, purchasing, insights, REST API, and MCP with two-phase writes. Integrations: price files, Ibcos Gold bridge, Xero, webhooks.
- 45 tests pass on PGlite (`npm test`) and on Postgres 16 (`npm run test:pg`, needs `TEST_PG_URL`).
- Strategy: win the parts counter and purchasing *beside* Ibcos Gold, sold via the reseller. See `docs/ROADMAP.md`.
- Real-data research: `docs/DATA-ACCESS.md`. Kramp is the only documented live dealer API (prices, ATP stock, orders). OEMs (Deere/CNH/AGCO/CLAAS) only via certified-DMS accreditation. No scraping (UK database right, dealer terms).

## Open items (in priority order)

1. **Push to GitHub.** The cloud session couldn't (Claude GitHub App not granted on the repo). From here: `git push -u origin main`. Make sure `origin` is `https://github.com/cyarwood80/AgriParts.git`.
2. **Kramp access** (Chris to arrange): the pilot dealer's Kramp trade account and webshop credentials, plus AgriParts registered as a DMS vendor via Kramp UK's Business Solution Consultant. Then build `src/integrations/ordering/kramp.ts` (and a price/ATP lookup) **against the real spec at developer.kramp.com**. Don't guess endpoint paths. Credentials go in `.env`, never in code or git.
3. **Supplier list classification:** Chris has a list of UK stockists/suppliers/manufacturers. For each, classify the route (open API / EDI / portal only / price file / certified-DMS only) with a source, plus a contact. Output a sheet plus a summary in `docs/DATA-ACCESS.md`.
4. **Ibcos export samples** from the reseller → replace `IBCOS_PLACEHOLDER_MAPPINGS` in `src/integrations/legacy-import/ibcos-bridge.ts`.
5. **Draft an email to Kramp UK** requesting DMS-vendor API access, with the reseller's partner dealer as pilot (offered, not yet written).
6. Phase 1 roadmap items: counter UI, OAuth 2.1, Postgres RLS, decimal units of measure, Xero OAuth connect flow.

## Running on Windows

```powershell
npm install
npm test
$env:SEED_DEMO="true"; npm start    # http://localhost:3000/docs; demo API keys printed at start-up
```

The default DB is PGlite under `.data/` (gitignored). To reset the demo, delete `.data/`.

Connect Claude Desktop to the local MCP server (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agriparts": {
      "command": "npx",
      "args": ["tsx", "C:\\IBCOS\\AgriParts\\src\\mcp\\stdio.ts"],
      "env": { "DATABASE_URL": "pglite://C:/IBCOS/AgriParts/.data/agriparts", "AGRIPARTS_API_KEY": "ap_...counter key..." }
    }
  }
}
```

PGlite allows one process at a time. Stop `npm start` before Claude Desktop launches the stdio server, or run local Postgres and point both at it.

## Gotchas found along the way

- `npm install` needs `legacy-peer-deps` (set in `.npmrc`): npm 10 crashes on vitest 4's optional peers otherwise.
- Use `typescript` 5.9, not 7.x.
- The v1 folder (`C:\IBCOS\agriparts`) and this repo have case-insensitive name clashes on Windows. Keep them in different folders.
