# Pilot plan: one dealer, working system

**Goal:** a real, working system at one pilot dealer (via the reseller), used by real customers and engineers. The dealer confirms it is **accurate** and that the team behind it is **competent**. Their sign-off and case study then open the next ten dealers.

Decisions behind this plan: [ADR-0001](adr/0001-production-platform.md) (platform), [ADR-0002](adr/0002-frontend-architecture.md) (front ends), [ADR-0003](adr/0003-ai-guided-parts-identification.md) (AI parts finder), [ADR-0004](adr/0004-field-guide-content.md) (field-guide content). Brand: [BRAND.md](BRAND.md). Data: [REAL-DATA-PLAN.md](REAL-DATA-PLAN.md).

## What the pilot dealer gets

1. **Parts finder** on their website and in text/WhatsApp links: customers photograph or describe what they need; the right part comes back priced for them with stock; anything uncertain becomes a well-briefed callback.
2. **Field guide** for their engineers: verified manufacturer and in-house procedures for their most common jobs, offline, with the original manual page one tap away.
3. **Dealer desk**: callback queue with SLA timers, content verification, counter lookup.

## Phases

| Phase | Weeks | Outcome | Exit check |
|---|---|---|---|
| **0. Foundations** | 1–2 | Production stack live (Supabase, Fly.io London, R2, Pages, CI on PGlite + Postgres), RLS on, auth for staff and customers, monorepo with brand tokens | Restore-from-backup drill passes; RLS tests pass; preview deploy per PR |
| **1. Dealer data in** | 2–4 | Real Ibcos exports loaded (parts, stock, customers, **wholegoods/machines with serials**, 12–24 months of sales history); price files; nightly sync | Parts manager spot-checks 50 parts and 20 customer machines: all correct |
| **2. Field guide, real content** | 3–7 | Top 5 machine models × top 30 jobs: dealer-owned procedures + licensed short-line manuals ingested, checked and **foreman-verified**; offline packs on engineers' phones | Foreman sign-off on every live procedure; 100% verbatim spec check |
| **3. Parts finder** | 4–8 | Agent + tools + callback queue; eval set from dealer history | Eval: ≥85% right part in top 3, ≥95% correct escalation, 0 confident wrong safety-critical answers |
| **4. Live pilot** | 8–16 | Soft launch to 20 friendly customers and all engineers, then the dealer's whole customer base | Success metrics below, reviewed fortnightly with the dealer |

Phases overlap: content work (2) runs while the parts finder (3) is built.

## What we need from the pilot dealer

- [ ] **Named sponsors:** dealer principal (decisions), parts manager (parts finder accuracy), workshop foreman (content verification, ~2–3 hrs/week during phase 2).
- [ ] **Ibcos exports** via the reseller: parts master, stock by depot, customers, wholegoods register (machine, serial, owner), sales history, supersessions if held.
- [ ] **Franchise list and top machines** by service hours/jobs, and their **top 30 workshop jobs**.
- [ ] **In-house knowledge:** torque sheets, job sheets, checklists, photos the workshop already uses.
- [ ] **Introductions** to their short-line manufacturers' UK contacts (content licences), and to their OEM area manager (consent request, ADR-0004).
- [ ] **200 past parts enquiries** with the part actually supplied (for the eval set). Counter notes and emails are fine.
- [ ] **Callback rota:** who rings customers back, hours, and the VOR on-call number.
- [ ] Signed **DPA** (we're processor; sub-processors listed).

## Success metrics (pilot)

| Metric | Target |
|---|---|
| Parts finder: enquiries resolved without a call | ≥ 60% by week 16 |
| Parts finder: right part first time (orders not returned as wrong part) | ≥ 98% |
| Callback SLA met (1 working hour; VOR 15 min) | ≥ 90% |
| Field guide: weekly active engineers | ≥ 80% of the workshop |
| Field guide: verified procedures live | ≥ 150 |
| Spec errors reported from the field | 0 unresolved after 24h |
| Dealer NPS (principal, parts manager, foreman) | ≥ 50 |

## Running cost for the pilot

| Item | Monthly |
|---|---|
| Supabase Pro (Postgres, auth, backups, PITR) | ~£20 |
| Fly.io (API + worker, London, small always-on) | ~£10–25 |
| Cloudflare R2 + Pages | ~£0–5 |
| Resend email / Twilio SMS (VOR only) | ~£0–10 |
| Sentry (developer tier) | £0 |
| Claude API: parts finder (~300 sessions) | ~£30–50 |
| Claude API: manual ingestion (one-off, Batch) | ~£20–60 total for the pilot catalogue |
| **Total** | **~£60–110/month + one-off ingestion** |

The proof of concept before the pilot runs on free tiers (about £0–10/month plus AI usage).

## Risks

| Risk | Mitigation |
|---|---|
| OEM won't consent to franchise content use | Pilot launches on dealer-owned + short-line content; OEM portal deep links meanwhile; pilot audit trail strengthens the ask |
| Ibcos export formats differ from placeholders | Phase 1 is first; bridge mappings confirmed with real samples (HANDOVER item 4) |
| Parts finder accuracy below bar | Escalation-first design; eval-gated go-live; widen the safety-critical list; launch "browse by machine" fallback |
| Foreman time squeezed by the season | Schedule phase 2 outside harvest; keep each review under 3 minutes with side-by-side UI |
| AI cost overrun | Per-session token budget and turn cap; prompt caching; monthly spend alert |
| Customer photos and personal data | EXIF stripped on device; 90-day retention; DPA; UK/EU hosting |

## Sign-off

The pilot is complete when the dealer principal, parts manager and foreman each sign a one-page acceptance against the metrics above, and agree to a named case study.
