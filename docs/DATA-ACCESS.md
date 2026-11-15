# Real parts data: what we can connect to (research, Nov 2026)

**Short answer:** there is no public, open API for UK manufacturer parts prices and stock. Real data comes through **the dealer's own accounts**. The dealer authorises AgriParts to act on their account, as they already do for Ibcos. The best route differs for each supplier tier. One allmakes supplier (Kramp) publishes a real, documented dealer API today.

## Why not scrape the manufacturers' parts pages

- Dealer portals sit behind the dealer's login and are covered by the dealer agreement. Automating them without the OEM's consent risks the dealer's franchise and breaches portal terms.
- Public catalogues (e.g. Deere's) are protected by **UK database right** (Copyright and Rights in Databases Regulations 1997, which still apply after Brexit). Extracting or reusing *a substantial part* without consent infringes; looking up individual facts generally doesn't.
- Scrapers break whenever a page changes. That fails our "faultless execution" bar.

Single lookups on behalf of a dealer, using their own access, are a different matter from bulk-copying a catalogue. Even so, the official routes below are better.

## Connectability by tier

| Tier | Examples | Route to real data | What you get | Access needed |
|---|---|---|---|---|
| **Allmakes, with an open dealer API** | **Kramp** (now also carries the Vapormatic range) | REST API at `api.kramp.com`: auth with the dealer's Kramp webshop credentials → bearer token. **Prices**, **gross prices**, **ATP stock** (quantity and delivery schedule), **Sales Order** APIs. Max 100 articles per price request. Plus EDI for orders, confirmations, delivery notes and invoices | Live dealer-specific price, availability and ordering | A Kramp customer number for each dealer, plus registration as a DMS/ERP vendor via Kramp's regional Business Solution Consultant |
| **Allmakes, portal/EDI only** | Sparex (trade portal, credit-checked; EDI via third parties: X12/EDIFACT/XML), Bepco (closed trade portal, 150k items, no public integration docs) | Price/product files through our importer now; EDI or API by agreement | Prices and product data; orders by EDI or CSV | A trade account for each dealer, plus a conversation with each supplier's e-business team |
| **Major OEMs** | John Deere, CNH (Case IH/New Holland), AGCO (Massey/Fendt/Valtra), CLAAS, Kubota, JCB | Only through **OEM-certified DMS integrations**. In the US, vendors like HBS and Charter submit parts orders, query OEM warehouse stock, upload dealer inventory and download suggested stock orders and price books. Deere has a developer program (Dealer Syndication API for parts carts) but **no public price/stock API** | Order submission, OEM stock, price books, parts locator | **Become a certified DMS for each OEM.** This is a commercial and technical accreditation, usually needing a sponsoring dealer. It's the real moat, and why Ibcos has "36 manufacturers" |
| **Shortline makers** | Hedge cutters, balers, implements | Spreadsheet/PDF price lists through our price-file mappings | Prices, supersessions | Ask each maker; most will email the file |
| **Machine data** | Deere, CNH FieldOps, JCB LiveLink (ISO 15143-3), Leaf, agrirouter | Official APIs with farmer consent | Hours and fault codes → predicted parts (v1 `predict_parts`) | OEM developer approval, plus consent from each farmer |

## Recommended sequence

1. **Kramp connector first.** It's the only documented live API, it's allmakes (relevant to every dealer), and it now carries Vapormatic. With one pilot dealer's Kramp account we'd have live price and availability in the counter and over MCP within days. Blocker in this session: `developer.kramp.com` isn't on this environment's network allowlist, so I could read search snippets but not the full spec.
2. **Price files for everyone else** (already built, with provenance and dry-run diffs). This covers Sparex, Bepco and shortlines on day one, with each dealer's own files.
3. **One OEM certification**, chosen by the pilot dealer's main franchise. Start the application now; it is the long pole (months).
4. **EDI** (EDIFACT ORDERS/ORDRSP/DESADV/INVOIC) as a generic adapter. It unlocks the long tail of suppliers that won't build APIs.

## Using your supplier list

Send the list (CSV/XLSX: name, website, type if known). For each supplier I'll classify the route (open API / EDI / portal only / price file / OEM-certified only), record the evidence, and flag who to contact. That gives you a target list for the reseller conversation and a build order. Every row will be checked against a source, not assumed.

## Sources

- [Kramp Developers](https://developer.kramp.com/), [API introduction](https://developer.kramp.com/api-intro), [Product Prices API](https://developer.kramp.com/product-prices-api-specification), [ATP API](https://developer.kramp.com/product-atp-api), [Kramp Connect (UK)](https://www.kramp.com/shop-gb/en/i/services/business-solutions/connect), [TRASER × Kramp setup](https://docs.traser-software.de/en-US/aptean-equipment-dms-x-kramp/xkramp-documentation/xkramp-setup/xkramp-setup-product-information)
- [Farmers Weekly: Vapormatic Exeter closure, range moving to Kramp](https://www.fwi.co.uk/news/john-deere-confirms-closure-of-vapormatic-exeter-parts-arm)
- [Develop with Deere – dev docs](https://developer.deere.com/dev-doc-landing)
- CNH via certified DMS: [HBS Systems](https://hbssystems.com/hbs-systems-dms-cnh-industrial-integrations/), [Charter eParts setup](https://customer.chartersoftware.com/knowledgeBase/12332284)
- AGCO: [Charter AGCO API](https://www.powerequipmenttrade.com/charter-makes-agco-api-integration-available/), [HBS AGCO](https://hbssystems.com/hbs-systems-dms-agco-integration/)
- CLAAS: [HBS CLAAS](https://hbssystems.com/hbs-systems-dms-claas-integration/), [Charter CLAAS](https://chartersoftware.com/claas/)
- Sparex: [UK trade registration](https://gb.sparex.com/trade-registration.html), [TrueCommerce EDI listing](https://www.truecommerce.com/trading-partner/sparex-inc/). Bepco: [bepcoparts.com](https://www.bepcoparts.com/en-xx)
- UK database right: [legislation.gov.uk SI 1997/3032](https://www.legislation.gov.uk/uksi/1997/3032/note), [Bird & Bird on scraping](https://www.twobirds.com/en/insights/2021/global/legal-weapons-in-the-fight-against-data-scraping)
