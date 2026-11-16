# ADR-0006: 3D exploded walkthrough ("Linchpin Teardown")

**Status:** Proposed (exploration)
**Date:** 2026-11-16
**Deciders:** Chris; pilot dealer workshop foreman (accuracy); manufacturer contacts (CAD licensing)

## Context

Concept 2 ("Machine Map") showed parts found on a picture of the machine. Chris wants to go further: take a **real photo of the machine**, turn it into **3D**, **explode it** like a workshop manual, and let the counter and the engineer **walk through** the repair in an immersive view. Another Linchpin USP beside the field guide (ADR-0004) and the parts agent (ADR-0003).

Two questions decide whether this is buildable and safe:

1. **Can a photo really become an exploded assembly?** Partly. Today's tools turn phone photos or video into a 3D **outside** of a machine well: photogrammetry and Gaussian splatting (Scaniverse, Polycam, Luma, Kiri Engine, Eclipse RealitySync, SpAItial Echo-3), viewable in a browser. But a photo can't show what's **inside** (bearings, seals, the bolt behind the guard). Research models that split a generated 3D object into parts (PartGen, Part123, AutoPartGen, OmniPart, BANG for exploded views) **invent** plausible internals. Fine for a game prop, unacceptable for a repair: a made-up seal or bolt order is exactly the error that hurts people and machines.
2. **Where do accurate internals come from?** From the manufacturer's **CAD** (licensed), or from the **parts book's exploded diagrams** modelled by us and checked by the foreman. OEMs already do the CAD route through interactive 3D parts-catalogue vendors (Documoto, VNTANA, SysOnline; AGCO's parts-book app has exploded views). Short-line manufacturers often only have PDFs.

## Decision

Build Teardown in **three layers**, each with a clear source of truth, and never let generated geometry pose as the real part.

| Layer | What the user sees | Source | Trust |
|---|---|---|---|
| **1. The real machine** | A 3D scan of *this* machine (or the model) to orbit: "it's here, behind the left guard" | Dealer's own phone capture (photogrammetry or Gaussian splat), stored per model or per machine | Real surface; no internals; labelled "scan" |
| **2. The exploded assembly** | The assembly pulled apart in order, every piece clickable to its part number | **Licensed OEM CAD** (simplified to web meshes), or **modelled from the licensed parts-book diagram** and verified by the foreman | Same rules as procedures: draft → foreman review → published (ADR-0005) |
| **3. The walkthrough** | Each procedure step moves the parts it touches; the spec and page show as in job mode | The **published procedure** (ADR-0004) plus a per-step animation script | Specs verbatim with page; animation is illustration |

Rules:

- **Generated 3D is illustration only.** If a model or part was produced by an image-to-3D or part-generation model, it carries an "Illustration, not from the manufacturer" label and is never evidence for identification or a spec.
- **Every exploded piece maps to a catalogue number** (or says "not sold separately"). Clicking a piece opens Find a part with that number and the machine.
- **Licensing follows ADR-0004/0005**: CAD is content with a `content_licences` row, scope and offline rules. Offline packs may carry the meshes only where the licence allows.
- **The flat page stays one tap away.** The parts-book page and manual page remain the reference; 3D is the fast way in.
- **Brand language:** "workshop-manual style", never another publisher's name.

## How it works (pilot shape)

```
Dealer scans a machine with a phone ──► splat/mesh (layer 1) ──► stored per model
Parts-book Fig 12 (licensed) ──► modelled assembly (glTF) ──► foreman review ──► published (layer 2)
Procedure WM-AT-02-04 (published) ──► step → parts-to-move script ──► walkthrough (layer 3)

Viewer: three.js in the web app (desk and field), glTF/GLB meshes, splats via a WebGL splat renderer;
WebXR later for headsets. Same deep links as today: #/field/explode/<assembly>?serial=…
```

Data model (when we build it for real):
- `assemblies_3d` (model, assembly, source kind `oem_cad | modelled | scan | generated`, licence, status, file key, version)
- `assembly_parts_3d` (node name in the glTF → make + part number, explode vector, order)
- `procedure_animations` (procedure id, step seq → nodes to move, camera)

## Options considered

### A. Photo → AI-generated exploded model, end to end
Fastest to demo, **rejected for repair use**: internals are invented. Keep as an illustration tool for marketing and for assemblies we have no data for, clearly labelled.

### B. Licensed OEM CAD only
Most accurate, but slow and gated (each OEM, legal, CAD clean-up). The franchise OEMs may never agree. **Use where offered.**

### C. Three layers: scan for "where", licensed/modelled assembly for "what", procedure for "how" (chosen)
Works with short-line PDFs today (model from the diagram), upgrades to CAD when an OEM agrees, and uses real scans for the "it's here on your machine" moment.

## Trade-offs

Modelling assemblies from diagrams costs time (estimate: a few hours per common assembly for a 3D artist, plus foreman review), so we start with the **top 20 jobs** on the pilot dealer's top 3 models (the same list as the field-guide pilot). Scans are cheap but heavy (tens of MB per machine); stream them and keep offline packs to the exploded assembly, not the scan.

## Consequences

- **Easier:** identifying a part at the counter ("the one behind the bracket"); explaining a repair to a less experienced engineer; demoing Linchpin.
- **Harder:** a new content type with its own review; file sizes for offline; WebGL performance on older rugged tablets.
- **Revisit:** part-aware generation once models can be *checked* against a parts list (segmentation matched to catalogue numbers, not invented); WebXR on headsets for training.

## Action items

1. [x] Prototype viewer in the app: invented flail-rotor assembly, explode slider, click a piece to see its part, step walkthrough linked to the demo procedure (`web/js/explode.js`, `#/field/explode/demo`).
2. [ ] Pick 3 assemblies with the pilot foreman; model one from a licensed parts-book diagram; foreman review.
3. [ ] Scan one pilot machine with a phone (splat); test streaming and file size on the workshop tablet.
4. [ ] Ask one short-line manufacturer for CAD under the content licence (add a CAD clause to the template).
5. [ ] Schema and review flow (`assemblies_3d`, `assembly_parts_3d`, `procedure_animations`) once 2–4 prove out.
