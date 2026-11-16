# Real data plan

How we get **real** data for both offerings, lawfully, for one pilot dealer first. It builds on `DATA-ACCESS.md` (supplier and OEM routes) and ADR-0004 (field-guide content). **Rule unchanged: no scraping, no unlicensed manual text, ever.**

## 1. What each offering needs

| Data | Parts finder | Field guide | Source (pilot) |
|---|---|---|---|
| Parts master, prices, supersessions | ✔ core | ✔ parts lists | Dealer's Ibcos export + supplier price files |
| Stock by depot | ✔ | ✔ (van/depot stock on the job) | Ibcos nightly export |
| Customers | ✔ | ✔ (job context) | Ibcos export |
| **Machines with serials and owners** | ✔ (identify machine) | ✔ (pick model-specific procedures) | Ibcos **wholegoods register** + service history |
| Fitment (part ↔ model/assembly) | ✔ core | ✔ | Licensed parts books (short-line PDFs), OEM EPC access, dealer sales history (what sold for which machine) |
| Sales history (part sold → customer/machine) | ✔ (strong prior: "what they bought last time") | – | Ibcos export |
| Procedures, specs, page images | – | ✔ core | Dealer-owned docs, licensed manufacturer manuals (ADR-0004) |
| Product images/diagrams | ✔ (evidence cards) | ✔ | Licensed manufacturer/supplier assets |

## 2. Sources and how to unlock each

### A. The pilot dealer's own data (week 1, no third party)
- **Ibcos Gold exports** via the reseller: parts, stock, customers, wholegoods/machines, sales history. Replace `IBCOS_PLACEHOLDER_MAPPINGS` with the real column layouts (HANDOVER item 4).
- **Workshop knowledge:** torque sheets, PDI checklists, job sheets, photos. Uploaded through the desk app, verified by the foreman, `tenant` scope.
- **Counter history for the eval set:** 200 enquiries → part supplied.

### B. Short-line manufacturers (weeks 2–6)
Manufacturers whose operator and parts manuals are already public (e.g. McConnel and Spearhead host PDFs and a serial-number parts database). Ask for a simple written **content licence**:
- what we do: ingest their manuals, verify with dealer foremen, serve to that manufacturer's dealers' engineers, offline with expiry and audit;
- what they get: usage analytics by model and job, fewer botched repairs and warranty claims, a "Verified with [manufacturer]" badge, a channel for service bulletins;
- what we don't do: redistribute PDFs publicly, or use content for anything else.

Target list: every short-line brand the pilot dealer sells. Start with hedgecutters/flails, mowers, balers, cultivators, loaders.

### C. Franchise OEM (in parallel; don't block on it)
- The dealer already holds OEM portal access (service information, EPC). The dealer asks their **area manager for written consent** to use it in a tenant-only, watermarked, audited, expiring tool for their own technicians. We supply the consent letter and a one-page controls summary.
- Until consent: **deep links** from the field guide and parts finder into the OEM portal (we store the link target, not the content).
- Longer term: OEM data feeds via accredited-DMS programmes (`DATA-ACCESS.md`).
- Regulatory backstop: GB-retained Reg. 167/2013, Chapter XV, requires tractor manufacturers to provide repair and maintenance information access to independent operators. That's useful leverage and an allmakes route, but it gives **access, not redistribution**.

### D. Allmakes suppliers (as access is granted)
- **Kramp**: prices, availability, ordering, product data (HANDOVER item 2). Fitting guides and spec sheets where licensed.
- Other wholesalers via price files and EDI (`DATA-ACCESS.md` classification task).

## 2a. How each source lands in the system (built, ADR-0005)

| Source | Endpoint / command | Lands in | Notes |
|---|---|---|---|
| Ibcos customers, parts, stock | `POST /v1/integrations/ibcos/import` (`entity` customers / parts / stock) | `customers`, `parts`, stock ledger | Dry run by default. Column names are **placeholders** until we see real exports |
| Ibcos wholegoods register | same, `entity: machines` | `machines`, `machine_models` | New models created on first sight; hours never go down; blanks don't wipe data |
| Ibcos parts sales history | same, `entity: sales_history` | `part_sales_history` | UK dates; idempotent per invoice line; links customer and machine |
| Supplier price files | `POST /v1/integrations/price-files` | `parts`, supersessions | Unchanged |
| Parts books / EPC exports | `POST /v1/integrations/fitment` | `part_fitment` with page, figure, **serial breaks** | Verified lines aren't overwritten by another source |
| Repeat sales (no parts book yet) | `POST /v1/integrations/fitment/infer` | `part_fitment` (`sales_inferred`, ≤70% confidence) | Always shown as unverified |
| Licensed manuals | `npm run manuals:ingest -- --pdf … --licence … [--extract]` or `POST /v1/documents` | `service_documents`, `document_pages`, draft `procedures` | Licence must have a permission reference. Claude extraction is local and optional |
| Foreman verification | `GET /v1/content/review-queue`, `PATCH /v1/procedures/:id/steps/:seq`, `POST /v1/procedures/:id/review` | `content_reviews`, `procedures.status` | Can't approve while the verbatim check fails |
| OEM portal (pre-consent) | `POST /v1/content/links` | `document_links` | Link only, never content |

Every load is a batch tied to a registered source (`GET /v1/integrations/sources`).

## 3. Outreach sequence (first 6 weeks)

| Week | Action | Owner |
|---|---|---|
| 1 | Pilot kickoff; data export request to reseller; collect franchise list, top machines, top 30 jobs | Chris + dealer principal |
| 1 | Dealer sends consent request to OEM area manager (our template) | Dealer principal |
| 2 | Content-licence emails to the top 3 short-line manufacturers (our template; dealer introduces) | Chris |
| 2–3 | Load Ibcos data; parts manager spot-check | Us + parts manager |
| 3–6 | Ingest dealer-owned procedures + first licensed manuals; foreman verification | Us + foreman |
| 4 | Eval set built from counter history | Us + parts manager |

## 4. Templates to prepare (next)
- [ ] Short-line manufacturer content licence (one page + schedule of controls)
- [ ] Dealer → OEM consent request letter + controls summary
- [ ] DPA + sub-processor list (ADR-0001)
- [ ] Data export request to the reseller (fields per table)
