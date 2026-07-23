# Stable Sub-Element Identity

Status: **DESIGN** (approved 2026-07-23). Precedes and unblocks the curve split (#385, Stage C · C2).

## The problem

Some things a director selects and animates are not nodes — they are **elements of an array
param**: a curve's control points, a channel's keyframes, a glTF material's slots. Today each is
addressed by its **position** in that array — `(nodeId, index)`, `(channelId, time)`,
`materials.<slot>...`. Position is not identity. Insert a point ahead of the selected one, reorder a
material slot, undo across a topology change, and the reference silently names a **different**
element. The app already carries scar tissue for this: `history.ts` *drops* every position-addressed
sub-selection on undo/redo because it cannot trust the index to still mean the same thing (#326), and
a glTF material channel targeting `materials.2...` will mis-target if slot 2 moves.

The fix is to give these sub-elements a **stable id** that travels with the element across insert,
delete, reorder and restore, and to address them by `(nodeId, id)` instead of by position.

## What the reference tools do (grounding)

**Blender — interactive geometry is index-based; stable ids live only in the procedural layer.**
- A legacy `Curve` control point (`bpy.types.SplinePoint` / `BezierSplinePoint`) carries `co`,
  `radius`, `tilt`, handles, and its **selection as a boolean on the point** — but **no id and no
  index field**. Identity is its position in `Spline.points`. The RNA/animation path is
  `splines[0].points[2].co` — index-addressed, so an F-Curve on a control point mis-binds when a
  point is inserted ahead of it. Blender lives with this; it does not solve it.
- A `MeshVertex` has `.index` (readonly) + `.co` + `.select`. Delete → everything reindexes. No
  persistent vertex/edge/face id.
- Stable identity appears only in the **newer procedural geometry** (`bpy.types.Curves`,
  `PointCloud`) via the **attribute/domain model**: geometry stores data as *attributes* on *domains*
  (points/edges/faces/corners); `position` is just a required attribute; storage is an index-addressed
  array. A stable per-element **`id` is an optional attribute on the point domain**, maintained by
  geometry-nodes / simulation for cross-frame tracking — one attribute among many, never used for
  edit-mode selection or animation targeting.

**Houdini — the same architecture, made first-class.** Four attribute classes (point / vertex /
primitive / detail); a stable **`id` point attribute** is the idiomatic mechanism for identity that
survives reordering (copy-to-points, sims). Basher's Houdini ground-truth already logs the attribute
model as an unbuilt gap (four attribute classes, component-group selection scoping, topology-change
attribute interpolation, attribute promotion).

**The convergence:** in both tools, **stable identity is an `id` attribute on a domain array —
opt-in, maintained by the ops that need it — not intrinsic structure.** The full attribute-domain
substrate is the north star, but it has *no surface to land on in Basher yet* (see below), so we
realize the same idea minimally now: a stable `id` field on the array elements that actually exist.

## Basher reality (why the scope is what it is)

Two facts from a full codebase sweep shape the scope:

1. **There is no editable mesh topology.** All mesh geometry is parametric primitives
   (`BoxData.size`, `SphereData.radius`+segments → a `GeometryRef` handle, never serialized), opaque
   glTF clones, or content-hashed baked handles (`BakedMesh` `BakedGeometryRef`). No edit mode, no
   `vertices`/`faces` param, no topology mutation anywhere. **"vertex/edge/face ids" apply to zero
   surfaces today.** Curve control points are the only sub-element-addressable geometry.
2. **Nothing sub-element is animatable today — except glTF material slots.** Two path-writers exist
   with opposite array behaviour: the persistent `setParam` is dot-only and *refuses* to descend into
   arrays by design (`core/dag/ops.ts` `setAtPath`), so a curve point is only ever edited via a
   whole-array replace; the animation writer `overlayChannels.writeAt` *does* index arrays by numeric
   key, and the one thing riding it is a glTF **material slot** (`materials.<slot>...`) — a *persisted*
   channel/driver target addressed positionally. So curve points and keyframes have **zero** existing
   sub-element animation to migrate; the material slot is the lone positional-index precedent, and it
   is the one with a latent reorder bug.

The complete set of id-less positional sub-elements is exactly **three**. Everything stack-shaped
(modifiers, effects, constraints, drivers) already has real node-id identity — those are the
precedent the curve-point files cite, and are out of scope.

| Sub-element | Address today | Store / site | Stakes |
|---|---|---|---|
| Curve control point | `(nodeId, pointIndex)` | `curveSelectionStore` | UI selection; #326 undo-drop |
| Timeline keyframe | `(channelId, time)` | `timelineSelection` | UI selection; same #326 seam |
| glTF material slot | `materials.<slot>...` | channel/driver `paramPath` | **persisted animation target** — reorder mis-targets |

## The mechanism — "identified arrays"

An **identified array** is an array param whose elements each carry a stable `id: string`. A
sub-element is referenced by `(nodeId, id)` and resolved to an index **only** where a numeric index is
structurally required (the eval-time array write).

Shared core:
- A small `identifiedArray` helper: `findById(arr, id) → index | null`, plus id-preserving
  `insert` / `remove` / `reorder`.
- One **id minter usable inside pure op-builders** — the caller/UI mints the id and threads it into
  the (pure) op, mirroring how `operatorStack` lets the caller pass a fresh `newId`. Migrations mint
  ids for legacy elements (a one-shot, impure pass at load).
- Reference resolution `(nodeId, id) → index` at the read/eval boundary. The dumb `writeAt`
  path-walker stays index-only; **id→index resolution happens at the channel-application site, before
  `writeAt`** — the writer never learns about ids.

Two properties fall out for free (the test that the abstraction earns its span):
- **#326 is fixed properly.** An id-addressed selection *survives* the undo restore, because the
  element with that id is restored with the array. The `history.ts` drop-seam
  (`clearPositionAddressedSubSelections`) is *removed* for id-addressed selections, not papered over.
- **The material-slot reorder bug is fixed.** A persisted channel targeting `materials.<id>...`
  survives a slot reorder.

## Design decisions

1. **Embedded id (`{id, co}`), not a parallel `pointIds[]` array.** A parallel array reintroduces the
   exact index-alignment fragility ids exist to kill.
2. **Id at the reference layer, index resolved at eval; keep the `writeAt` writer dumb.** Resolution
   is a step at the channel-application site, not logic inside the path-walker.
3. **Caller/UI mints ids into pure ops; migrations mint for legacy.** Pure code cannot call a random
   uuid; the id is an input to the op. Deterministic-friendly minting so tests are reproducible.

## The three clients

- **Curve control points** — `points: Vec3[]` → `points: {id, co: Vec3}[]`. Selection store keys
  `(nodeId, id)`. Clean per-node `Curve` migration (`version` 1→2, `[x,y,z]` → `{id, co:[x,y,z]}`);
  no existing sub-element animation to migrate.
- **Timeline keyframes** — each keyframe object gains `id`; `timelineSelection` keys `(channelId,
  id)` instead of `(channelId, time)`. Fixes #326 for keyframes too.
- **glTF material slots** — each slot gains `id`; channel/driver `paramPath` `materials.<slot>...` →
  `materials.<id>...`, resolved id→index at overlay application. **The one heavy piece:** rewriting
  `<index>` → `<id>` inside *existing persisted* channel/driver paths is a **graph-wide format
  migration** touching real animation targets — its own carefully byte-identity-tested slice.

## Phasing

- **P1 — mechanism core + curve points.** The `identifiedArray` helper + id minter, `Curve`
  `points → {id, co}` with the per-node migration, `curveSelectionStore` → `(nodeId, id)`, remove the
  #326 drop-seam for points. Lands the data-model change first ("the id model first").
- **P2 — curve split (#385).** The Object + CurveData split rides on P1: CurveData owns
  already-id'd `points`.
- **P3 — keyframes.** Keyframe ids; `timelineSelection` → `(channelId, id)`; fixes #326 for keyframes.
- **P4 — material slots.** Slot ids + the graph-wide format migration for persisted channel paths;
  fixes the reorder mis-target.

Later / out of scope until a surface exists: a full attribute-domain substrate (point/vertex/prim/
detail classes with `id` as one attribute) for editable mesh topology. The `id`-carrying element here
is the seed of that model; it is not built speculatively while no mesh topology exists to exercise it.

## Open questions (for the P1 plan)

- Exact id-minting scheme reproducible inside pure op-builders (counter vs content-derived vs
  caller-passed), and how migrations mint stable ids for legacy points deterministically.
- Whether the P1 `identifiedArray` helper is authored generically from the start or extracted after
  the second client (P3) — decided by the observed shape, not up front.
