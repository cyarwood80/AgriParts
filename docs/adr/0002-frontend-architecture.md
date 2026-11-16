# ADR-0002: Front-end architecture

**Status:** Proposed
**Date:** 2026-11-16
**Deciders:** Chris, design lead (when appointed)

## Context

We launch with **two offerings**, plus one internal surface that makes them work:

1. **Parts finder** (customer-facing). A farmer or contractor describes, photographs or names what they need. AI guides them to the right part; if it can't, it books a callback from the dealer's parts or service team (ADR-0003). It must work on a phone in a yard with weak signal, and needs no app install.
2. **Field guide** (engineer-facing). Manufacturer procedures for the exact part and machine, usable **offline** for days at a time (ADR-0004). Large tap targets, works with gloves, readable in sunlight.
3. **Dealer desk** (staff-facing, internal). The callback queue, content verification queue (foreman approves extracted procedures), counter lookup and the existing orders and insights screens.

The current UI (vanilla JS in `web/`) proved the flows but won't scale to a design system, tests and three apps.

## Decision

**One TypeScript monorepo with three installable PWAs sharing one design system and API client:**

- **React 19 + Vite + TypeScript**, client-rendered single-page apps (no server-side rendering needed: these are app-like, logged-in or offline tools).
- **TanStack Router + TanStack Query** for routing and server state. The **OpenAPI client is generated** from the Fastify `/docs` schema, so front-end types can't drift from the API.
- **Tailwind CSS + Radix primitives (via shadcn/ui)**, themed with the brand tokens in `docs/BRAND.md`. The component library lives in `packages/ui`.
- **Offline** (field guide; drafts in the parts finder): Workbox service worker for the app shell; **IndexedDB** for packs, with pack content **encrypted at rest** using a per-device key; background sync for queued photo uploads and step completions.
- **Camera and photos**: native `<input type="file" accept="image/*" capture>` first (works everywhere), with client-side resize and EXIF location stripping before upload. Uploads go direct to R2 via signed URLs.
- **Hosting**: Cloudflare Pages, one project per app, preview URL per pull request.
- **Native later, only if needed**: wrap the same PWAs with **Capacitor** if a dealer needs App Store presence, MDM deployment or deeper camera control. No separate native codebase.

```
apps/
  parts/   → parts.<brand>.co.uk     (public, magic-link sign-in, dealer-branded)
  field/   → field.<brand>.co.uk     (engineers, installable, offline-first)
  desk/    → desk.<brand>.co.uk      (dealer staff: callbacks, verification, counter)
packages/
  ui/      design system (tokens, components, icons)
  api/     generated OpenAPI client + auth helpers
  offline/ pack storage, encryption, sync
```

**White-label by default.** The parts finder shows the *dealer's* name and logo first ("Smith & Sons Parts, powered by …"). Dealers are the customer; farmers trust their dealer.

## Options considered

### Option A: React + Vite SPA PWAs on Cloudflare Pages (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low–Medium |
| Cost | £0 hosting |
| Scalability | Static CDN; scales without effort |
| Team familiarity | High; the biggest hiring pool |

**Pros:** offline-first is natural in an SPA; the cheapest possible hosting; largest ecosystem for camera, offline storage and accessible components; easy to wrap with Capacitor.
**Cons:** no SSR for SEO. That's fine: the marketing site is separate (Astro, also on Pages), and the apps sit behind login or deep links.

### Option B: Next.js on Vercel

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Free tier is non-commercial; Pro is about $20/user/month |
| Scalability | Good |
| Team familiarity | High |

**Pros:** SSR/SEO, server actions.
**Cons:** the server features we'd pay for aren't needed; offline-first PWAs fight the SSR model; it adds a second backend runtime beside Fastify.

### Option C: Native apps (React Native / Expo)

| Dimension | Assessment |
|---|---|
| Complexity | High (store releases, two platforms) |
| Cost | Developer accounts plus slower iteration |
| Scalability | Good |
| Team familiarity | Medium |

**Pros:** the best camera and background behaviour.
**Cons:** install friction kills the farmer-facing parts finder ("just send me a link"); slower pilot iteration. Capacitor gives us an escape hatch without this cost.

### Option D: Keep vanilla JS

Rejected beyond the demo: there's no type safety against the API, no component reuse across three apps, and it's hard to test.

## Trade-off analysis

A farmer will tap a link in a text or WhatsApp message, but won't install an app for a one-off part. An engineer *will* install the field guide, and needs it to survive a week without signal. PWAs serve both from one codebase at zero hosting cost. SSR (Next.js) solves a problem we don't have, and native apps add release friction we can't afford in a pilot.

## Consequences

- **Easier:** one design system; consistent offline handling; dealer white-labelling via theme tokens; preview links to show the pilot dealer every change.
- **Harder:** iOS PWA limits (storage can be evicted after weeks of non-use; push notifications need the app added to the home screen). Mitigation: packs re-validate and re-download when online, and engineers are told to "Add to Home Screen" during onboarding.
- **Revisit:** Capacitor wrapper if a dealer requires MDM or App Store distribution.

## Action items

1. [ ] Scaffold the monorepo (pnpm workspaces) with `apps/parts`, `apps/field`, `apps/desk`, `packages/ui|api|offline`.
2. [ ] Generate the API client from OpenAPI in CI; fail the build on drift.
3. [ ] Build brand tokens into Tailwind theme + dark mode; dealer white-label override.
4. [ ] Port the demo field guide to `apps/field` with encrypted IndexedDB packs and a real service worker.
5. [ ] Accessibility pass (WCAG 2.1 AA, gloved-hand targets ≥ 48px, sunlight contrast).
6. [ ] Marketing site (Astro) on the brand domain.
