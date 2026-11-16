# ADR-0001: Production platform and hosting

**Status:** Proposed
**Date:** 2026-11-16
**Deciders:** Chris (product owner), reseller technical lead

## Context

AgriParts v2 runs as one Node/TypeScript process (Fastify REST + MCP + outbox dispatcher) on Postgres, with PGlite for tests and demos. It now needs to run for real for **one pilot dealer**, at **minimal or zero fixed cost**, without boxing us in when we add dealers.

Forces:

- **Two front-end offerings** (see ADR-0002): a customer-facing AI parts finder (ADR-0003) and an engineer field guide with real manufacturer content (ADR-0004). Both need photo/PDF storage, background jobs (manual ingestion, AI calls) and offline delivery.
- **The transactional core already depends on Postgres**: row locking on the stock ledger, `DISTINCT ON`, `pg_trgm` search, transactional outbox. Moving off Postgres means a rewrite.
- **UK customer data** (farm contacts, machine locations, photos). Prefer UK/EU hosting, and a processor list we can put in a DPA.
- **Tiny team.** Ops time is the scarcest resource, so managed services win over self-hosting.
- **Roadmap needs**: Postgres row-level security (RLS), OAuth for users, vector search over manuals.

## Decision

**Keep the modular monolith on Postgres, and run it on managed, usage-priced services:**

| Concern | Choice | Why |
|---|---|---|
| Database | **Supabase Postgres** (UK/EU region) | Real Postgres, so the existing migrations run unchanged. Includes `pgvector`, RLS, auth and storage. |
| Auth | **Supabase Auth** | Magic link and email OTP for farmers (no passwords to forget), plus SSO later for dealer staff. Issues JWTs that our `ServiceContext` maps to tenant + user. API keys stay for integrations and MCP. |
| API + MCP + workers | Existing Fastify app as a **container on Fly.io (London, `lhr`)**. Render or Railway are drop-in alternatives. | No rewrite. Small always-on VM, pay as you go. One image runs the `api` and `worker` process groups. |
| Background jobs | **Postgres-backed queue** (our outbox + `pg-boss`) | No extra infrastructure. Retries and dead-lettering already exist. |
| Files (photos, manual PDFs, page renders, offline packs) | **Cloudflare R2** | No egress fees, which matters because field packs and page images are downloaded repeatedly. S3-compatible. Signed URLs per tenant. |
| Front ends | **Cloudflare Pages** (static PWA builds) | Free, global CDN, preview deploys per branch. |
| Email / SMS | **Resend** (email) now. **Twilio** SMS only for urgent callbacks. | Free tier covers a pilot. SMS is pay per message. |
| AI | **Claude API** (see ADR-0003, ADR-0004) | Vision, PDF and citations in one API. Usage-priced. |
| Errors / logs | **Sentry** (free developer tier) + Fly logs | Enough for a pilot. |
| CI | **GitHub Actions**: typecheck, tests on PGlite **and** Postgres 16 service container, then deploy | Closes the `test:pg` gap from the handover. |

PGlite stays for tests, demos and the laptop-at-a-dealer scenario. It is never used in production.

## Options considered

### Option A: Managed Postgres + container PaaS + R2 + static PWAs (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low. Same code, a few managed services. |
| Cost | About **£0–10/month** for a proof of concept on free tiers. About **£40–60/month** once the pilot dealer is live (Supabase Pro so backups exist and the project never pauses, plus a small always-on VM). AI usage is extra (ADR-0003). |
| Scalability | Good to dozens of dealers. Postgres scales vertically and with read replicas. Tenants are isolated by RLS. |
| Team familiarity | High. It's what we already run. |

**Pros:** no rewrite; real Postgres features (ledger locks, RLS, pgvector) in one place; each piece can be swapped (Supabase → Neon/RDS, Fly → Render/ECS) because they are plain Postgres and a container.
**Cons:** several vendors to manage. Supabase's free tier pauses idle projects and has no backups, so it's fine for the concept but the pilot must be on Pro.

### Option B: Cloudflare-native (Workers + Hyperdrive→Postgres + R2 + Queues)

| Dimension | Assessment |
|---|---|
| Complexity | Medium–High. Fastify does not run on Workers, so routes move to Hono. The PGlite/Node dev story splits. |
| Cost | Cheapest at scale; near zero for a pilot. |
| Scalability | Excellent at the edge. |
| Team familiarity | Low. |

**Pros:** one vendor for compute, storage and CDN; scales to zero.
**Cons:** rewrite of the HTTP layer; long-running jobs (manual ingestion) fit awkwardly within Worker CPU limits; MCP Streamable HTTP needs rework. **Revisit** once traffic justifies it. Keeping R2 and Pages now makes the later move smaller.

### Option C: Hyperscaler (Azure UK South: App Service + Postgres Flexible Server + Blob)

| Dimension | Assessment |
|---|---|
| Complexity | Medium. More configuration and IAM. |
| Cost | Roughly £80–200/month minimum before traffic. |
| Scalability | Excellent. |
| Team familiarity | Medium. |

**Pros:** enterprise procurement comfort for big dealer groups; one DPA; UK region.
**Cons:** cost and ops are out of proportion to a one-dealer pilot. **Revisit** if a large group or OEM asks for it. The container and Postgres move across unchanged.

### Option D: Firebase / Firestore or another NoSQL backend

Rejected. Losing SQL transactions and row locks breaks the stock ledger guarantees (`reconcileLedger()` must stay empty) and forces a rewrite of every service.

## Trade-off analysis

The deciding factor is **don't rewrite what works**. The business rules, the ledger and the tests are the asset. Option A puts the existing code into production in days, at near-zero fixed cost, and every component has a like-for-like exit. Option B is the better long-term cost curve but costs us weeks now. We can move to it later behind the same Postgres. Option C buys enterprise comfort we don't need until a dealer group asks.

## Consequences

- **Easier:** RLS (Supabase has first-class support), user login for farmers and staff, vector search for manuals, per-branch preview environments.
- **Harder:** we now own a multi-vendor bill and a DPA listing each sub-processor (Supabase, Fly.io, Cloudflare, Anthropic, Resend, Sentry).
- **Must do before real data:** enable RLS on every tenant table (second line of defence behind service-layer scoping); daily backups plus point-in-time recovery (Supabase Pro); secrets in Fly/Supabase secret stores only; `AGRIPARTS_CONFIRM_SECRET` set.
- **Revisit:** Cloudflare-native compute at about 20+ dealers or when Fly costs exceed about £150/month; Azure if a dealer group's procurement requires it.

## Action items

1. [ ] Create Supabase project (UK/EU region); run migrations; enable RLS policies keyed on `tenant_id` from the JWT claim.
2. [ ] Map Supabase JWT → `ServiceContext` (tenant, user, role → scopes). Keep API keys for integrations/MCP.
3. [ ] Dockerfile + `fly.toml` with `api` and `worker` process groups in `lhr`.
4. [ ] R2 bucket per environment; signed-URL helper; tenant-prefixed object keys.
5. [ ] GitHub Actions: typecheck, PGlite tests, Postgres 16 tests, deploy on `main`.
6. [ ] Sentry and uptime check; backup restore drill before the pilot goes live.
7. [ ] Sub-processor list and DPA template for the pilot dealer.
