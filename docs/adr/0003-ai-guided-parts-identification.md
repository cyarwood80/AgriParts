# ADR-0003: AI-guided parts identification with human escalation

**Status:** Proposed
**Date:** 2026-11-16
**Deciders:** Chris, pilot dealer's parts manager (accuracy sign-off)

## Context

Customers rarely arrive with a correct, current part number. They arrive with a broken bit in their hand, a photo taken in a hedge, "the filter on the 6150 we bought off you", or a number off an old box that's been superseded twice. Today that's a phone call and a parts person's experience. We want the parts finder to do what the best parts person does:

1. Work out **which machine** (serial plate photo, reg, their registered fleet, or model + year).
2. Work out **which part** (photo of the part, numbers stamped or cast on it, what it does, where it fits).
3. **Resolve** that to what the dealer supplies today (supersessions, fitting changes, pattern alternatives), priced for that customer, with stock.
4. **Know when to stop guessing** and hand over to a human: quickly, with everything collected so far, so the customer never repeats themselves.

A wrong part costs a farmer a day in harvest. **A confident wrong answer is worse than "let me get someone to ring you".** The design must make the safe path the default.

## Decision

### Architecture

A **tool-using agent loop on the server** (Claude API + our own tools via the SDK tool runner), not a free-form chatbot. The model never invents part numbers. It can only *propose* parts that our tools return.

```
Customer (parts PWA)
  │  text / photos / voice-to-text / "my machines"
  ▼
POST /v1/parts-finder/sessions/:id/messages          (Fastify, rate-limited, tenant from auth)
  │
  ▼
Agent loop (claude-opus-5-5, tool runner)
  tools → identify_machine(serial|reg|model)          ← machines, Ibcos wholegoods register
        → read_serial_plate(image)                    ← vision, returns text only
        → search_parts(query, make, machine?)         ← existing pg_trgm search
        → parts_for_machine(machine, assembly?)        ← part_fitment + catalogue sections
        → resolve_part_number(pn, make)                ← supersessions, fitting warnings
        → get_price_and_stock(pn, customer)            ← pricing + stock services
        → show_candidates([...], question)             ← renders choice cards in the UI
        → request_callback(reason, urgency)            ← creates a case for the dealer team
  │
  ▼
Structured result: candidates[] with evidence + confidence band, or a callback case
```

- **Same service layer** as REST and MCP (ARCHITECTURE decision 1). Tools are thin wrappers, and tenant and identity come from auth, never from the model.
- **Ordering stays two-phase.** The agent can build a basket; the customer confirms the exact lines and prices on screen; only then does `createQuote`/`confirmOrder` run (the existing MCP rule).
- **Evidence-first answers.** Every candidate shown to the customer carries *why*: "matches the number on your photo (RE5048...)", "fits your 6150R per the parts list, section Engine > Lubrication", "superseded from X, straight swap". Shown alongside the dealer's product image or catalogue diagram where we hold one.

### Escalation: "know when to hand over"

Escalate to a **callback case** when any of these hold:

| Trigger | Rule |
|---|---|
| Low confidence after reasonable attempts | No candidate reaches the *high* band after **3 clarifying rounds**, or after **2 photo requests** |
| Safety-critical systems | Brakes, steering, hitch and linkage load parts, PTO guards, ROPS/cab structure, tyres/wheels: **always** human-verified before ordering, even at high confidence |
| Conflicting evidence | Photo number contradicts the stated machine, or fitment says "doesn't fit" |
| Not in the catalogue | Tools return nothing usable (obsolete, allmakes, fabricated part) |
| Customer asks | "Can I speak to someone" at any point: immediate, no friction |
| VOR (machine off road) | Customer says the machine is down mid-job → flagged **urgent**, SMS to the on-call parts phone |

A **callback case** bundles: customer + contact preference, machine (if identified), photos, the full transcript, candidates tried with their evidence, the escalation reason, and a requested time window. It appears in the Dealer desk queue with an SLA timer (pilot target: callback within 1 working hour; VOR within 15 minutes). The customer sees "Dave in parts will ring you before 3:15pm" (a real name and time), not "a ticket has been raised".

**Closing the loop:** when staff resolve a case they record the correct part. That becomes (a) a verified alias/cross-reference, (b) a fitment fact, and (c) an eval case. Each escalation makes the next automated answer better.

### Models and cost

- **Default model: `claude-opus-5-5`** for the agent loop: strongest vision (worn, oily, part-obscured components; reading stampings) and tool judgement. Effort tuned per route (see below); server-side refusal fallback enabled (`fallbacks: "default"`) so a declined turn degrades gracefully rather than failing.
- **Cost levers, in order:** prompt caching of the system prompt and tool definitions (stable prefix); lower `effort` on simple text turns; downscaling photos client-side to about 1.5MP before upload. A cheaper model (`claude-sonnet-5-5` or `claude-haiku-5-5`) for triage is an **owner decision after measuring** on the eval set below, not a default.
- **Indicative cost** at list prices ($4 / $20 per million input/output tokens): a typical session (3 photos, 6 turns, about 30k input tokens with caching and about 2k output) is **about $0.10–0.20**, roughly 8–16p. At 300 sessions a month that's about £30–50. One avoided wrong-part return pays for months of it.
- **Privacy:** photos have EXIF/GPS stripped on device; retained 90 days, then deleted unless attached to an order or case; customers are told photos are processed by an AI provider (listed in the DPA).

### Accuracy: how the dealer proves it works

An **eval set built from the pilot dealer's real counter history**: 150 to 200 past enquiries (photo or description → the part actually supplied), including deliberately hard ones (superseded, pattern, wrong-machine stated). Run before every prompt or model change.

Pilot go-live bar, agreed with the dealer's parts manager:

- **≥ 85%** correct part in the top 3 candidates on answerable cases,
- **≥ 95%** of unanswerable cases correctly escalated,
- **0** confident wrong answers on safety-critical parts.

A weekly sample of real sessions is reviewed by the parts manager in the desk app (thumbs up/down + correct part).

## Options considered

### Option A: Tool-using agent on our services, with explicit escalation rules (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Usage-priced; about 8–16p per session |
| Accuracy | High: answers are grounded in our catalogue, and the model can't invent part numbers |
| Team familiarity | High; reuses the MCP tool layer |

### Option B: Image-similarity search (vector embeddings of part photos)

| Dimension | Assessment |
|---|---|
| Complexity | High: needs a large labelled photo library we don't have |
| Cost | Cheap per query |
| Accuracy | Poor for worn or dirty parts; many parts look alike (filters, bearings) and differ by a number |

Useful later as **one tool inside Option A** (`similar_parts(image)`), once escalated cases have built a labelled library.

### Option C: Rules-based wizard (choose make → model → assembly → part)

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | £0 |
| Accuracy | Fine if the customer knows the assembly; fails on "this bit fell off" |

Kept as the **fallback path inside the UI** ("browse by machine") and for when AI is unavailable.

### Option D: Generic chatbot with web search

Rejected: ungrounded answers, no tie to dealer stock and pricing, and a high risk of confident wrong part numbers.

## Trade-off analysis

Grounding plus escalation beats raw cleverness. The model's job is to *interpret* the customer (photos, words, half-remembered numbers) and *drive our tools*. The catalogue, fitment and supersession data decide what's correct. The escalation rules turn uncertainty into a well-briefed human call instead of a guess, and every human resolution becomes training data.

## Consequences

- **Easier:** a 24/7 front door for parts enquiries; the counter gets pre-qualified cases with photos instead of cold calls; measurable accuracy.
- **Harder:** answer quality is capped by catalogue and fitment data quality (ADR-0004 and `docs/REAL-DATA-PLAN.md`); we need an eval discipline from day one.
- **Revisit:** a cheaper-model triage split once we have 4 weeks of real traffic and eval results; WhatsApp Business as an intake channel (per-conversation fees) once the web flow is proven.

## Action items

1. [x] One `enquiries` table (the case, callback fields included) + `enquiry_messages`; desk queue UI with callback timers (`/app/#/desk`, `services/parts-finder.ts`). Stopped machines (VOR) sort first; callbacks 15 min VOR / 60 min otherwise.
2. [~] Tools over existing services: `find_machine`, `parts_for_machine`, `search_parts`, `check_part`, `customer_history`, `submit_answer` (`integrations/parts-agent/claude.ts`). Escalation is decided by the service, not a tool. `read_serial_plate` (photos) still to do.
3. [~] Manual tool loop (8-step cap, cached system prompt, refusal and max-token handling) with the offline rules matcher as fallback and as the no-key demo engine. Every proposed number is re-resolved; evidence, price, stock and guide come from our data; a draft reply naming an unchecked number is rewritten. Per-session token budget still to do.
4. [~] Safety-critical classification by keyword on description and assembly (always handed to a person). Dealer-editable list still to do.
5. [ ] Build the eval set with the pilot dealer; automate the run in CI (manual trigger; it costs money).
6. [ ] Notifications: email (Resend) for normal cases, SMS for VOR.
