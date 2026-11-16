# Architecture decision records

| # | Decision | Status |
|---|---|---|
| [0001](0001-production-platform.md) | Production platform: Postgres monolith on Supabase + Fly.io + Cloudflare R2/Pages | Proposed |
| [0002](0002-frontend-architecture.md) | Front ends: React/Vite PWAs (parts finder, field guide, dealer desk) in one monorepo | Proposed |
| [0003](0003-ai-guided-parts-identification.md) | AI parts finder: tool-using agent grounded in our catalogue, with explicit callback escalation | Proposed |
| [0004](0004-field-guide-content.md) | Field-guide content: licensed sources, extraction + verbatim checks + foreman verification | Proposed |
| [0005](0005-data-sources-and-content-model.md) | Data sources and content model: source registry, Ibcos machines + sales history, fitment provenance, document pages, procedure lifecycle | Proposed |
| [0006](0006-3d-exploded-walkthrough.md) | 3D exploded walkthrough ("Teardown"): real scan for where, licensed or modelled assembly for what, published procedure for how; generated 3D is illustration only | Proposed (exploration) |

Earlier decisions (v1/v2 core) are recorded in `../ARCHITECTURE.md`. New ADRs: copy the format of 0001, next number, status `Proposed` until the deciders sign off.
