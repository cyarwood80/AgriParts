# Working on this repo

- Read `docs/ARCHITECTURE.md` and `src/db/schema.ts` before changing anything.
- Business rules live in `src/services/`. REST (`src/api`) and MCP (`src/mcp`) are thin adapters over them. Never put a rule in a route or a tool.
- Every part-number match goes through `normalisePartNumber()`. If you change it, add test cases.
- Stock changes only via `recordMovement()` / `adjustCommitments()`, inside a transaction. `reconcileLedger()` must stay empty.
- Money is integer pence, rates are basis points. No floats for money.
- Tenant and identity come from the API key / session (`ServiceContext`), **never from tool arguments or request bodies**.
- MCP write tools must be two-phase (`twoPhase()` in `src/mcp/server.ts`) and audited. Invoicing is not exposed to agents.
- Side effects that leave the building (webhooks, accounting, supplier APIs) go through the outbox or happen outside DB transactions. Never hold a lock across the network.
- Demo data is invented. Never add real manufacturer data or manual text unless it's licensed.
- Before finishing, run `npm run typecheck` and `npm test`. If you touched SQL, also run `npm run test:pg`.
- Schema change: edit `schema.ts`, then run `npm run db:generate -- --name <change>`, and commit the migration.
