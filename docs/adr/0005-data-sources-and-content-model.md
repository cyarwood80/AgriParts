# ADR-0005: Data sources and content model for parts and manuals

**Status:** Proposed
**Date:** 2026-11-16
**Deciders:** Chris (product), pilot dealer parts manager and workshop foreman (accuracy), reseller (Ibcos exports)

## Context

The two front-end offerings now need real data (see [REAL-DATA-PLAN](../REAL-DATA-PLAN.md)):

- **Linchpin Parts** (the AI parts finder) needs:
  - the dealer's parts master, prices, supersessions and stock;
  - **which machines each customer owns** (serial, model);
  - **what fits what** (fitment, with serial breaks);
  - **what each customer bought before**, the strongest prior the counter uses today.
- **Linchpin Field** (the field guide) needs licensed manuals turned into verified, page-referenced procedures. The original page stays one tap away.

Today's schema covers the parts master, stock and supersessions (via price files and the Ibcos bridge) and the *shape* of field guidance (licences, documents, procedures, steps, packs). It's missing five things:

1. A registry of **where each dataset comes from**. Today `ingest_batches.source` is free text.
2. **Machines** and **sales history** imports from Ibcos.
3. **Fitment** with provenance, serial ranges and the parts-book page it came from.
4. **The pages of the manual** (text per page, plus a page image), which the verbatim check and the "show me the original" view both depend on.
5. A **lifecycle** for procedures: extracted, checked, verified by the foreman, published. Engineers must never see an unverified procedure (ADR-0004 go-live bar).

## Decision

### 1. Every dataset has a registered source; every row knows its batch

New `data_sources` table, one row per feed per dealer.

| Column | Meaning |
|---|---|
| `code` | `ibcos-gold`, `kramp-prices`, `mcconnel-parts-books`, `dealer-uploads`… |
| `kind` | `dms_export`, `supplier_price_file`, `parts_book`, `manual`, `dealer_upload`, `oem_portal` |
| `licence_id` | For licensed content, the licence that governs it |
| `precedence` | Which source wins when two disagree (lower wins). Default order: dealer DMS > supplier file > parts book > inferred |
| `config` | Column mappings, depot map, schedule |
| `last_loaded_at` | When this source last loaded data |

`ingest_batches` gets a `data_source_id`. Imported rows keep pointing at their batch, as parts and supersessions already do, so any fact can answer "where did this come from, and when?"

### 2. Dealer data from Ibcos: two more entities in the bridge

The existing `importLegacyFile` (customers, parts, stock) gains:

- **`machines`** (the wholegoods register): serial, make, model, customer account, year, hours, reg. Machine models are created on first sight. A machine that changes owner is updated, not duplicated.
- **`sales_history`**: invoice ref and date, customer, optional machine serial, make, part number, qty. Stored in a new `part_sales_history` table, with idempotency on `(tenant, invoice_ref, line_no)`.

Sales history is used three ways:
- (a) the parts finder's "what they bought last time";
- (b) **inferred fitment**: a part repeatedly sold against a model is a candidate fitment, `source = 'sales_inferred'`, always shown as unverified;
- (c) the eval set (ADR-0003).

### 3. Fitment carries provenance and serial breaks

`part_fitment` gains:

| Column | Meaning |
|---|---|
| `source` | `parts_book`, `oem_epc`, `sales_inferred` or `manual` |
| `batch_id` | The import batch it came from |
| `document_id` + `page` + `figure_ref` | The parts-book page and diagram callout ("Fig 12, item 7") |
| `serial_from` / `serial_to` | The serial break. In ag machinery the same model changes parts mid-run, so a fitment line without a serial range is incomplete |
| `confidence` | 0–100 |
| `verified_by` | Who verified it. `NULL` means unverified |

A **parts-book fitment importer** loads CSVs produced from licensed parts books, either EPC exports or pages extracted by the pipeline below.

The fitment primary key stays `(model, make, part)` for now. Two serial ranges for the same part on the same model are rare. When that happens we keep the widest range and log an issue. **Revisit** (switch to a surrogate key) if a real parts book shows it's common.

### 4. Manuals: file, pages, procedures with a lifecycle

- **`content_licences`** gains:
  - `kind`: `dealer_owned`, `manufacturer_licence`, `oem_consent` or `link_only`.
  - `scope`: `tenant` or `platform`. Platform is reserved, not yet served (see below).
  - `permission_ref`: where the signed letter or email lives.
  - `source_url`, `contact`.
- **`service_documents`** gains:
  - `file_key`: blob-store key (local disk in dev, R2 in production; ADR-0001).
  - `file_sha256`, `page_count`, `source_url`, `language`.
  - `status`: `uploaded` → `paged` → `extracting` → `in_review` → `live`, or `withdrawn`.
- **`document_pages`** (new): `(document_id, page)` with the text layer, its hash, the printed page label (manuals print "4-12" on PDF page 87) and an optional image key. It's the ground truth for the verbatim check and the source of the "original page" view.
- **`procedures`** gain a lifecycle:

  | Field | Values |
  |---|---|
  | `status` | `draft` → `in_review` → `published`, or `rejected` / `withdrawn` |
  | `origin` | `extracted`, `manual_entry` or `seed` |
  | other | `extraction_run_id`, `check_report` (deterministic results), `version`, `verified_by`, `verified_at` |

  **Only `published` procedures are visible** to engineers, packs and agents. This is enforced in `services/guidance.ts`, not in the UI.
- **`extraction_runs`** (new): one per Claude call or batch. It records the model, page range, token usage, status and the raw structured output, so every extracted step can be traced to the exact model call.
- **`content_reviews`** (new): the foreman's decision per procedure version (approve, reject, edit) with notes. It's append-only and audited.
- **`content_flags`** (new): engineers flag a step from the field ("doesn't match the machine"). An open flag on a published procedure puts it back in the review queue.
- **`document_links`** (new): OEM-portal deep links per make, model or part number. We store the link target, never the content: the day-one route for franchise content before OEM consent (ADR-0004).

### 5. The ingestion pipeline (implements ADR-0004 §3)

```
register   ─ licence + document metadata + PDF ─► blob store, sha256, status=uploaded
paginate   ─ per-page text layer (unpdf / pdf.js) ─► document_pages, status=paged
extract    ─ Claude (claude-opus-5-5, PDF document block, prompt-cached,
             structured output, one page window per call) ─► extraction_runs
check      ─ deterministic, in code:
               • every spec value appears VERBATIM on its cited page's text
                 (whitespace and dash variants normalised, nothing else)
               • every cited page exists in the document
               • every step has a page; units on the allowed list
               • part numbers normalise; unknown numbers are warnings, not errors
           ─► procedures(status=draft or in_review, check_report)
review     ─ foreman: step beside page; approve/reject ─► content_reviews
publish    ─ approve + check passed ─► status=published
```

- **Approval is blocked while the deterministic check has errors.** The foreman can fix a step, which re-runs the check, but can't wave a mismatched torque through.
- **Extraction is optional per document.** A licensed PDF with pages but no verified procedures is still useful as "view manual pages 214–216" (ADR-0004, option B).
- **Bulk back catalogues** use the Batch API (50% cost). Single uploads use the synchronous call.

### 6. Blob storage behind an interface

`BlobStore` has `put`, `get` and `delete`. In dev it's a local folder (`.data/blobs`); production uses Cloudflare R2 (S3 API). Keys are `tenant/{tenantId}/docs/{documentId}/source.pdf` and `.../pages/{n}.png`. Nothing licensed is ever public. The API streams it after a licence check.

## Options considered

### Option A: Extend the current Postgres model with sources, pages and lifecycle (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: a few tables, two importer entities, one service |
| Cost | Nothing new to run. Claude extraction is per manual (ADR-0004) |
| Scalability | Comfortable to millions of fitment rows and tens of thousands of pages per dealer. Page text is small |
| Team familiarity | Same patterns as the price-file and Ibcos importers |

**Pros:** one database, transactional with the rest; provenance and audit come free; same RLS story (ADR-0001).
**Cons:** page text in Postgres grows with the catalogue. Fine for the pilot; revisit full-text search (pgvector or `tsvector`) once there's a search need.

### Option B: Separate document store / search engine (e.g. Typesense or OpenSearch) for manuals

**Pros:** better text search out of the box.
**Cons:** another service to run and secure; licence checks split across two systems; not needed until "search the manual" exists. **Deferred.**

### Option C: Vector-only "RAG" store of manual chunks

**Rejected for specs** (ADR-0004, option C). A chunk store can't prove a torque value came from a page. `document_pages` plus the verbatim check can.

## Platform-scope content (reserved)

A short-line manual verified once should serve every dealer that sells that brand. That needs content rows owned by the platform, not one tenant, plus per-tenant entitlement. We add `content_licences.scope` now so the data is labelled correctly, but **only `tenant` scope is served** until a second dealer exists and RLS policies for shared rows are written (ADR-0001).

## Consequences

- **Easier:**
  - any fact can be traced to its file and batch;
  - re-loading a file is a no-op;
  - a foreman's sign-off is recorded per procedure version;
  - publishers get an audit trail (who saw what, offline until when).
- **Harder:** procedures now need a status transition before engineers see them. Seed and demo data are marked `published` explicitly.
- **Revisit:**
  - surrogate key for fitment if serial ranges multiply;
  - page images (render on the worker with pdf.js and a canvas, or let the client render the PDF page);
  - full-text search over pages;
  - platform-scope content.

## Action items

1. [x] Schema and migration: `data_sources`, `part_sales_history`, `document_pages`, `extraction_runs`, `content_reviews`, `content_flags`, `document_links`; new columns on licences, documents, procedures, fitment, ingest batches.
2. [x] Ibcos bridge: `machines` and `sales_history` entities (column names are placeholders until real exports arrive).
3. [x] Parts-book fitment importer.
4. [x] Content service: register document, store pages, submit extraction, deterministic check, review queue, approve/reject, flag, document links. Guidance shows only published procedures.
5. [x] Claude extractor (structured output over the PDF), behind `ANTHROPIC_API_KEY`; CLI for pilot operations.
6. [ ] R2 `BlobStore` implementation (production).
7. [x] Desk UI (`/app/#/review`): review queue, each step beside its cited page text with spec values highlighted, edit-and-recheck, approve/reject/withdraw, flags and history. Field: tap a page reference to read the page; flag a step.
8. [ ] Batch-API path for back catalogues.
9. [ ] Replace Ibcos placeholder column names with the real export layouts (HANDOVER item 4).
