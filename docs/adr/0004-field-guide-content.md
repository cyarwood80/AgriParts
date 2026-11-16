# ADR-0004: Field-guide content: sourcing, licensing and ingestion

**Status:** Proposed
**Date:** 2026-11-16
**Deciders:** Chris, pilot dealer principal (licence route), pilot dealer workshop foreman (accuracy sign-off)

## Context

The field guide is our clearest differentiator: an engineer at a machine, maybe without signal, gets the **manufacturer's procedure for the exact part they're swapping on that exact machine**, with specs quoted word for word and the page they came from. The demo proved the experience on invented data. Production needs **real content**, and real content raises two hard problems:

1. **Rights.** Manuals are copyright works. Dealer agreements with OEMs typically restrict how service information is used and shared. Scraping is off the table (UK database right, site terms; see `DATA-ACCESS.md`). We need a lawful, written basis for every document.
2. **Accuracy.** A wrong torque or the wrong step order damages machines and hurts people. Extraction must be checkable, and checked, before anything reaches an engineer.

What we found in research:

- **UK short-line manufacturers publish manuals openly.** McConnel and Spearhead, for example, host operator and parts manuals as PDFs on their own sites, and McConnel offers a serial-number parts database. Open access is not a licence to republish, but it shows the content isn't treated as secret, so a formal licence is a short conversation.
- **The big OEMs sell service information.** Deere sells Operations Center PRO Service (replacing Customer Service ADVISOR): reported at about $195 per machine per year for owners and $5,995 per year for independent shops, with the full dealer version held back. CNH, AGCO and CLAAS run their own dealer portals. A franchised dealer already pays for and has this access; reuse inside a third-party tool depends on the dealer agreement.
- **Regulation.** GB-retained Regulation (EU) 167/2013, Chapter XV (Article 53) and Delegated Regulation 1322/2014, Annex V, require tractor manufacturers to give independent operators access to repair and maintenance information. This sets a floor for *access*. It does not grant redistribution rights, so we treat it as a backstop route, not a content source we can copy.

## Decision

### 1. Content is licensed per source, and scoped per tenant

Every document hangs off a `content_licences` row (already built) that records: publisher, written-permission reference, **scope** (`tenant` = only this dealer's users, or `platform` = all our dealers), and whether offline copies and AI use are allowed. The demo's rules become production rules: licensed or invisible; offline and AI only where allowed; packs expire, are audited and can be revoked.

### 2. Four sources, in order of speed to a working pilot

| # | Source | Rights route | Scope | Why it's first |
|---|---|---|---|---|
| **1** | **Dealer-owned knowledge**: workshop foremen's procedures, torque sheets, job-card photos, "how we actually do it" | Dealer owns it; consent in our terms | `tenant` | Available on day one; often the most practical content; no third party |
| **2** | **Short-line manufacturers** the pilot dealer sells (hedgecutters, mowers, balers, cultivators, loaders) | Written content licence: free, in exchange for usage analytics, fewer warranty failures and a "verified by" badge | `platform` (ideal) or `tenant` | Manuals already public as PDFs; manufacturers want fewer support calls and botched repairs |
| **3** | **Pilot dealer's franchise OEM** service information | The dealer requests **written consent from their OEM** (via area manager) to use their licensed service information inside a tenant-only, watermarked, audited, expiring tool for their own technicians | `tenant` only | The biggest content set and the highest value, but gated by the OEM |
| **4** | **Allmakes / parts suppliers** (Kramp etc.) fitting guides and spec sheets | Supplier API or data agreement | `platform` | Broad coverage of wear parts and consumables |

**Not used:** scraped portals, copies of manuals from third-party sites, or content behind a subscription we don't hold for that tenant. Where a dealer holds a portal subscription we can't ingest (no consent yet), the field guide shows a **deep link** to the right page or manual in the OEM portal instead of a copy ("Open in [OEM portal]"). The engineer still saves time, and we copy nothing.

### 3. Ingestion pipeline: machine-extracted, deterministically checked, human-verified

```
Upload PDF (desk app) ─► R2 (tenant-scoped)
        │
        ▼
1. Page split + render (each page → text layer + PNG image), stored per page
2. Structure extraction (Claude, PDF input + citations, structured output):
      document → procedures → steps {instruction, page, specs[{label, value, unit}], cautions}
      parts referenced → part numbers; machine models covered; tools; safety notes
3. Deterministic checks (code, not AI):
      • every spec value string must appear VERBATIM on its cited page's text layer
      • every page reference must exist; every part number normalises and is looked up
      • units are on the allowed list; no step without a page
      → any failure blocks publication and highlights the step
4. Human verification (desk app): the foreman sees each extracted step BESIDE the
   original page image; approves / edits / rejects. Edits are versioned.
5. Publish: procedure becomes visible to engineers under its licence rules.
```

- **Model:** `claude-opus-5-5` for extraction (long, dense technical PDFs; tables of torques; exploded diagrams with callouts). PDF input supports up to 600 pages per request, and **citations return page locations**, which feed the page references directly. Large back catalogues go through the **Batch API (50% cost)**.
- **Indicative cost:** a 300-page workshop manual is roughly 0.5–1M input tokens plus about 50k output tokens. At list price ($4 / $20 per million) that's about $2.50–5, **about $1.25–2.50 on Batch**. A whole short-line catalogue costs less than one engineer-hour.
- **The original page always travels with the step.** Engineers can tap any step to see the manufacturer's page image. That's the credibility moment ("it's the real manual, not an AI summary"), and the strongest guard against extraction error.
- **Offline packs** include the step text, specs and the cited page images, encrypted at rest, watermarked with the pack reference and engineer.

### 4. Accuracy sign-off for the pilot

The pilot dealer's workshop foreman verifies an agreed set of procedures, for example the 30 most common jobs across their top 5 machine models. Go-live bar:

- **100%** of specs match the source page (deterministic check plus human check),
- foreman signs off each procedure,
- **0** unverified procedures visible to engineers.

Engineers can flag any step from the field ("this doesn't match the machine"); flags go back to the verification queue.

## Options considered

### Option A: Licensed sources + extraction pipeline with deterministic checks + human verification (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Pennies to a few pounds per manual; foreman time is the real cost |
| Rights risk | Low: written basis per document |
| Accuracy | High: verbatim checks plus human sign-off, original page always visible |

### Option B: Show the PDFs as they are (search + jump to page), no extraction

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Very low |
| Rights risk | Same as A |
| Accuracy | High (it's the original), but slow to use at the machine |

**Kept as a mode.** It's the day-one fallback for any licensed PDF not yet verified ("view manual pages 214–216"), and it's how the original-page images are served anyway.

### Option C: RAG chatbot over manuals ("ask the manual")

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Accuracy | Risky for specs: paraphrase and blending across models |

**Later, constrained:** an "ask" box that answers only by *pointing to* verified steps and pages, never by generating a spec. The MCP `find_fitting_instructions` tool already follows that rule.

### Option D: Partner with an existing technical-data aggregator

Worth exploring commercially (some aggregators license OEM data to independents in automotive). No clear UK ag equivalent was found; revisit if one appears or an OEM offers a data feed.

## Trade-off analysis

Speed versus rights versus accuracy. Dealer-owned and short-line content gets a **real, licensed, verified** field guide in front of the pilot dealer's engineers within weeks. Franchise OEM content is the prize, but we shouldn't block the pilot on it. The pilot itself is our best evidence when asking the OEM ("here's the audit trail, watermarking and expiry"). Extraction makes content usable at the machine; deterministic verbatim checks plus the foreman make it trustworthy; the original page beside every step keeps us honest.

## Consequences

- **Easier:** onboarding any new licensed manual is an upload plus a review, not a data-entry project; the audit trail supports licence conversations with publishers.
- **Harder:** foreman verification time is a real cost to the dealer. We schedule it into the pilot plan and keep each review to minutes per procedure with side-by-side UI.
- **Revisit:** platform-wide licences (so a short-line manual verified once serves every dealer); OEM data feeds; constrained "ask the manual".

## Action items

1. [x] Add `scope`, `permission_ref`, `source_url` to `content_licences`; `document_pages` table (page no, text, image key). Done in [ADR-0005](0005-data-sources-and-content-model.md).
2. [~] Ingestion: page text, sync extraction and the deterministic checker are done (`services/content.ts`, `npm run manuals:ingest`). Page-image render and the Batch path are still to do.
3. [~] Desk app verification UI (`/app/#/review`): step beside the page **text** (values highlighted), approve/edit/reject, history. Page **images** wait on page rendering (item 2).
4. [~] Field app: tap a page reference → page text (online); flag-a-step is done. Pages inside offline packs and page images are still to do.
5. [ ] Licence letter templates: (a) short-line manufacturer content licence, (b) dealer→OEM consent request.
6. [ ] With the pilot dealer: list their top machine models and franchises → content target list (`docs/REAL-DATA-PLAN.md`).
