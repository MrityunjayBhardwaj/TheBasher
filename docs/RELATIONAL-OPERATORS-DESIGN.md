# Relational Operators (CHOP) — Design

> Status: **DESIGN / Phase 0 — no product code.** Branch context: `main`.
> Captures the substrate agreed after the 2026-07-12 camera-system map + Blender
> pro-rig gap analysis. This is the checkpoint artifact: it defines the shared
> relational-operator stack that Track-To, Follow-Path, Copy-Location, the Ray
> sensor, and the driver family all become **members** of — instead of the fourth,
> fifth, sixth bespoke sidecar.
>
> Grounded on `ref/GROUND_TRUTH_HOUDINI_OPERATORS.md`,
> `ref/GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS.md`,
> `ref/GROUND_TRUTH_HOUDINI_RAY_SOP.md`. Corrects the "transform stack = a sub-chain"
> guess in `docs/OPERATORS-AND-LIGHTING-DESIGN.md` §0 (see §4).

---

## 0. The shape in one screen

Basher already renders a Modifiers stack (SOP: geometry → geometry). It has **no
Constraints tab**, and the reason is a structural gap, not a missing feature:

- **A "relational operator" is an operator that reads another object's WORLD state
  and emits a channel/value.** Track-To reads the aim target's world position and
  writes the constrained object's rotation. A driver reads a source param and
  writes a target param. The Ray sensor reads two objects' world geometry and emits
  a distance/normal. These are **one species** — a _relational CHOP_.
- **A relational operator cannot be a pure `evaluate`** — world state only exists
  after scene composition, which a bare node `evaluate` never sees. So the species
  is **edge-less** (it names its references by a `{node}` param, not a wired input)
  and **resolved at a seam** that is handed `state` + `resolveWorldTransform`.
- **Today the driver subset is on one shared seam-rail** (`paramDrivers.ts`,
  `statefulOps.ts`) — composable, stackable, cycle-guarded. **The pose-writing
  (constraint) subset is not.** It resolves _first-wins-single_
  (`src/app/nodeConstraints.ts:66` `trackToForTarget` — one Track-To per node) and
  is surfaced by three bespoke sidecars: the camera look-at dropdown
  (`CameraLookAtTarget.tsx`), the studio-light aim (`studioLightRig.ts`), and the
  UI-parked Ray sensor. Each new one re-pays the cost.
- **The one new abstraction is a per-object, ordered, edge-less transform-operator
  (constraint) stack** — the CHOP analogue of the Modifier stack, but ordered by an
  explicit `order` field rather than an edge chain (constraints have no edges).
  Track-To migrates onto it byte-identically; Follow-Path / Copy-Location join as
  members; the three sidecars fold into one **Constraints panel**.
- **No new umbrella name.** Modifiers (SOP), Constraints (CHOP → pose), Drivers
  (CHOP → param) stay the three director-facing surfaces over one engine substrate.

The camera rig is the concrete motivator: a `Curve` scene object + a `FollowPath`
constraint that writes **position** while Track-To writes **rotation** — orthogonal
channels that compose "travel the path while locked on the subject" with **no
ordering needed at all**. But we build the stack _first_ (Phase 1), so Follow-Path
lands as a member, not a fourth sidecar.

---

## 1. Motivation — "why is there no Constraints tab like Modifiers?"

The user's question has a precise answer. Modifiers earned a stack because a
geometry modifier **is a sub-chain**: `Box → Array → Mirror` is a linear wire of
typed nodes, each consuming the previous node's `out`. `operatorStack.ts` owns that
chain-wiring, and `ModifierStackControls.tsx` renders it.

Constraints never earned a stack because the **first** relational operator (Track-To,
epic #201/#204) proved a constraint resolves **edge-less at the scene layer** — it
needs the constrained object's _world_ position, which no wired-input node can read.
So the transform stack "is NOT a sub-chain and [`operatorStack.ts`] serves the
GEOMETRY stack only" (`operatorStack.ts:9-15`, verbatim). The stack abstraction
`OPERATORS-AND-LIGHTING-DESIGN.md` §0 imagined as _polymorphic over value type_
collapsed to "one sub-chain helper for the operators that ARE sub-chains — modifiers
are; constraints aren't."

That left the pose-writing subset with **nowhere to land except another sidecar**,
and three accreted:

| Sidecar                 | File                             | What it is                                           |
| ----------------------- | -------------------------------- | ---------------------------------------------------- |
| Camera look-at dropdown | `src/app/CameraLookAtTarget.tsx` | picks a Track-To target for the active camera        |
| Studio-light aim        | `src/app/studioLightRig.ts`      | rig lights aim at a shared centre via Track-To reuse |
| Ray sensor (parked)     | `src/nodes/geometryQuery.ts`     | reads two objects, wired only through `ParamDriver`  |

This is the recurring trap (**catalogued: the relational-op-as-sidecar pattern**):
a relational operator's "reads another object" trait reads as _"this is special"_,
so each gets a bespoke resolution path + bespoke surface, and the pattern can't
compose or reorder. Building Follow-Path this way makes it four.

The fix is not "add a Constraints tab" as a fourth surface — it is to **name the
species and build its shared stack once**, then let Track-To / Follow-Path /
Copy-Location be members and fold the three sidecars in.

---

## 2. The taxonomy — classify by WHAT FLOWS, not by locality

The keystone realization (the Ray-SOP insight): **you cannot classify an operator by
whether it reads other objects.** The Ray op (`SampleGeometry`) reads _two_ objects'
world geometry — maximal locality breadth — yet it is a **CHOP**, because it _emits a
value_, not geometry. Locality is a red herring; **what flows** is the axis.

```
                    WHAT FLOWS
        geometry ─────────────────── channel / value
           │                              │
          SOP                     RELATIONAL CHOP
   geometry → geometry        emits a channel/value, reads
   edge-wired, cook-phase     cross-object WORLD state
   the Modifier stack         edge-LESS, {node}-ref, seam-resolved
   (Array, Mirror, ColorCC)          │
                          ┌───────────┴───────────┐
                     writes POSE              writes any PARAM
                     = Constraints            = Drivers / Sensors
                     Track-To                 ParamDriver, Solver,
                     Follow-Path              Lag, SampleGeometry
                     Copy-Location
```

- **SOP** = geometry → geometry. Pure `evaluate`, edge-wired, resolved in a local
  cook pass. The `OperatorStack` + **Modifiers** panel. Already built.
- **Relational CHOP** = emits a channel/value; _cannot_ be pure `evaluate` because it
  reads cross-object world state (`resolveWorldTransform` / world geometry) that only
  exists post-composition. So: **edge-less**, names refs by a `{node}` param,
  resolved at a **seam** handed `state`. **One species** spanning:
  - **Constraints** — write an object's **pose** (Track-To → rotation, Follow-Path →
    position, Copy-Location → position/rotation/scale). _Surfaced as the Constraints
    panel._
  - **Drivers / Sensors** — write **any param** (ParamDriver, Solver, Lag,
    SampleGeometry). _Surfaced as the Drivers affordance + the Controllers dock._

  Both halves are the same architectural shape; they differ only in _what they write_
  (a pose channel vs an arbitrary param) and therefore in _which UI surface_ exposes
  them.

**The Ray-op naming trap** (worth restating so it isn't re-litigated): `SampleGeometry`
is named for Houdini's Ray _SOP_ (the ray-vs-mesh algorithm) but its **role** is a CHOP
sensor — it reads geometry and _emits a value_ (out point / normal / distance), it does
not deform geometry. A true geometry-_deforming_ Ray/Shrinkwrap (geo → geo) would be a
real SOP on the Modifier stack; that is not built and is out of scope here.

---

## 3. The canonical relational-CHOP node shape

Every relational operator — pose-writer or param-writer — has the same four
structural properties. Track-To (`src/nodes/TrackTo.ts`) and ParamDriver
(`src/nodes/ParamDriver.ts`) already exhibit all four; this section names them as
the contract new members implement.

**3.1 Edge-less; references by `{node}` param.** The node has no wired data edge to
its target or to the objects it reads. It carries string node-ids in params
(`TrackTo.target`, `TrackTo.aimNode`; `ParamDriver.target`, `ParamDriver.sourceTransform.node`).
Its `outputs` socket exists only for introspection/agent completeness — nothing
consumes it (`TrackTo.ts:52` `out: { type: 'Constraint' }`, "nothing consumes it").

**3.2 `evaluate` is a passthrough / introspection value.** Because the real work
needs world state, `evaluate` returns a plain descriptor of the params (Track-To
returns a `ConstraintValue`; a stateful driver returns a passthrough). No node's
pure `evaluate` produces the resolved pose/value — that is the seam's job (§5). A
constraint is `pure: true` (its descriptor is a pure function of params); a stateful
driver is `pure: false` + `stateful: true`. Neither reads world state in `evaluate`.

**3.3 Enumerated by a flat scan, resolved at a seam given `state`.** A resolver walks
`state.nodes`, finds the relational operators whose `target === nodeId`, and resolves
their effect where `resolveWorldTransform` is in scope. Constraints:
`nodeConstraints.ts` (`trackToForTarget` → `resolveConstraintRotation` /
`resolveTrackToTarget`). Drivers: `paramDrivers.ts`
(`driverChannelValuesForTarget`). Both fold their result through the _same_
channel-value machinery a keyframe rides (`overlayChannels` / `foldChannel`), so
**render == read** holds by construction (the H40 invariant): the resolved overlay is
one band in the same fold the animation system already uses.

**3.4 Mute + order are first-class params.** `TrackTo.mute` already exists
(`TrackTo.ts:39`, "the future OperatorStack"). `ParamDriver.order` already exists
(`ParamDriver.ts:70`, `z.number().default(0)`). These two fields _are_ the stack:
mute = per-member bypass, order = deterministic composition sequence. The stack
abstraction is the enumeration + ordering + UI over members that already carry them.

> **Design rule.** A new relational operator is defined by adding a `NodeDefinition`
> with these four properties + a case in the relevant seam resolver. It is **never**
> given its own resolution path or its own authoring surface. If you find yourself
> writing a second resolver or a second panel for a relational operator, stop — that
> is the sidecar trap.

---

## 4. Why the constraint stack is NOT a sub-chain (the central decision)

The Modifier stack orders members by **edges**: the chain _is_ the wire
`base → mod1 → mod2`, and reorder = re-wiring (`operatorStack.ts` §2.2). Constraints
have **no edges** (§3.1). So the constraint stack needs a _different_ ordering
mechanism. Two candidates:

|                 | Edge-chain (SOP model)                         | Order-field (CHOP model) — **chosen**                   |
| --------------- | ---------------------------------------------- | ------------------------------------------------------- |
| Ordering        | wire `base→m1→m2`; reorder = re-wire           | integer `order` param per member; reorder = renumber    |
| Enumeration     | walk the edge chain (`enumerateOperatorStack`) | flat scan `target===nodeId`, sort by `order`            |
| Precedent       | `operatorStack.ts`                             | `ParamDriver.order` (already shipped), the drivers seam |
| Fits edge-less? | **no** — constraints have no data edge         | **yes**                                                 |

**Decision: the constraint stack is order-field-ordered, mirroring the driver rail,
not the geometry sub-chain.** A constrained object's stack = every non-muted
relational-pose node with `target === objectId`, sorted by `order`, composed
bottom→top. This reuses the exact model the driver family already proved (multiple
`ParamDriver`s on one target, ordered by `order`, folded in sequence), and it is why
`TrackTo` and `ParamDriver` were built edge-less with `mute`/`order` fields from the
start.

Concretely, the enumeration generalizes today's first-wins scan:

```ts
// nodeConstraints.ts — today (first-wins-single):
export function trackToForTarget(nodes, nodeId): ActiveTrackTo | null {
  for (const node of Object.values(nodes)) {
    if (node.type !== 'TrackTo') continue;
    if (p.target !== nodeId) continue;
    if (p.mute === true) continue;
    return { ... };          // ← first match wins, single
  }
  return null;
}

// Phase 1 — an ordered stack (drop-in superset):
export function constraintStackForTarget(nodes, nodeId): ActiveConstraint[] {
  return Object.values(nodes)
    .filter(n => isRelationalPoseNode(n) && n.params.target === nodeId && !n.params.mute)
    .sort((a, b) => a.params.order - b.params.order);   // ← ordered, N members
}
```

**Composition = channel overlay, and the camera rig needs no ordering.** Each stack
member resolves to a pose contribution on a specific band (Track-To → the rotation
band via `resolveConstraintRotation`; Follow-Path → the position band). Members that
write **orthogonal bands** (rotation vs position) commute — order is irrelevant. That
is exactly the camera rig: Follow-Path sets position by sampling the Curve, Track-To
sets rotation by aiming at the subject; the result is order-independent. Blender-style
constraint ordering only matters when two members write the _same_ band (e.g. two
rotation constraints); the stack supports it via `order`, but the headline rig never
needs it. **We ship the order field for correctness/generality, and lean on
orthogonality for the rig.**

**Single-band conflict rule (when two members write the same band).** Later member
(higher `order`) wins the base, earlier members compose under it — the same
last-writer-with-blend semantics the driver rail already uses. `influence`/blend
weight per member is a Phase-6 extra, not Phase 1.

---

## 5. The resolution seam — one pass, both H40 roads

There is exactly **one** place a relational operator's effect is computed, and every
surface that needs "where it actually renders / resolves" reads from it. This is the
existing pattern (`nodeConstraints.ts` for pose, `paramDrivers.ts` for param); Phase 1
generalizes the pose resolver from single to stack without adding a second path.

**Pose (constraint) seam — the three existing hooks the stack must feed:**

1. **Mesh rotation** — `resolveConstraintRotation(state, nodeId, ctx, cache)`
   (`nodeConstraints.ts:119`) derives the aim in world space and re-expresses it into
   the node's parent-local frame (`worldAimToParentLocal`, the #267 nested-constraint
   fix). Consumed by `SceneFromDAG`'s constrained-object mount.
2. **Camera lookAt** — `resolveTrackToTarget(state, nodeId, ctx, cache)`
   (`nodeConstraints.ts:178`) returns the aim _point_; `resolveCameraPoseAt`
   (`activeCamera.ts:332`) writes it into `pose.lookAt` over the static/channel lookAt.
3. **Render mount set** — `constraintTargetSet(nodes)` (`nodeConstraints.ts:97`) is the
   set of constrained ids the renderer computes once and tests membership against, so
   the child map stays O(N).

Phase 1 changes each of these from "the first Track-To" to "compose the ordered stack",
while the _return shape_ and the _callers_ stay identical — a stack of one Track-To must
be byte-identical to today's single Track-To (§7). Follow-Path adds a **position**
contribution: a fourth entry point `resolveConstraintPosition(state, nodeId, ctx, cache)`
(new in Phase 4) that the constrained-object mount and `resolveCameraPoseAt`
(`pose.position`) consume — orthogonal to the rotation band, so it slots in without
touching Track-To's path.

**Why one seam holds render == read.** Both the viewport render road (`SceneFromDAG` /
`resolveCameraPoseAt`) and the inspector/read road resolve through the _same_ functions
with the _same_ `state` + `cache`. The resolved contribution is folded through the same
`overlayChannels`/`foldChannel` a keyframe uses, so a constrained value the inspector
shows is the value the viewport renders — the invariant that has held for channels,
drivers, strips, and the single-constraint path, extended to the stack unchanged.

---

## 6. Naming — three panels, one engine, no umbrella

Mirror the precedent that already worked: the engine concept is "a typed operator on
the DAG"; the _director-facing name_ is the Blender word for the surface it lives on.
We did **not** coin "geometry operator" — we called it **Modifiers**. Same here:

| Director surface | Engine species   | Writes          | Members                                  |
| ---------------- | ---------------- | --------------- | ---------------------------------------- |
| **Modifiers**    | SOP (edge-wired) | geometry        | Array, Mirror, ColorCorrect              |
| **Constraints**  | relational CHOP  | object **pose** | Track-To, Follow-Path, Copy-Location     |
| **Drivers**      | relational CHOP  | any **param**   | ParamDriver, Solver, Lag, SampleGeometry |

- The **engine substrate** is "relational CHOPs on the seam-rail" — an internal term,
  never surfaced.
- **Constraints** and **Drivers** are the two director words; both are the same
  species split by _what they write_ (pose vs arbitrary param) and hence _which surface_.
- **No new umbrella** ("Relations", "Rigging", etc.). Two familiar Blender words beat
  one invented one. A director who knows Blender finds Constraints where they expect it.

---

## 7. Phase 1 — migrate Track-To onto the stack, BYTE-IDENTICAL

This is the only refactor with byte-identity risk; everything else is additive.

**Goal.** Replace the first-wins single-constraint scan with an ordered stack, such
that a stack containing exactly one Track-To renders **pixel-identical** to today.

**Scope (engine only, no new UI):**

- Generalize `trackToForTarget` → `constraintStackForTarget` (ordered, N members) and
  add `resolveConstraintRotation` composition over the stack (§4/§5). Keep
  `resolveTrackToTarget` (camera lookAt) and `constraintTargetSet` returning the same
  shapes.
- Add an `order` field to `TrackTo` params (default `0`), mirroring `ParamDriver.order`.
  A project with no `order` deserializes to `0` → single-member stacks are unchanged.
- Introduce a relational-pose predicate `isRelationalPoseNode` (Track-To today;
  Follow-Path/Copy-Location later) — the CHOP analogue of `OperatorPredicate`.

**The guard — these parity e2e must pass UNCHANGED (this is the acceptance test):**

- **render == read** on a Track-To'd object (viewport rotation == inspector-resolved).
- **Nested constraint** (#204 / #267): a Track-To on a node inside a non-identity
  parent Group composes to the correct _world_ orientation (`worldAimToParentLocal`).
- **Studio-light aim** (`studioLightRig.ts`) and **camera look-at**
  (`CameraLookAtTarget.tsx`) still aim identically — they resolve through the same
  seam, so a single-member stack must reproduce them exactly.

**Observation (Lokayata gate).** After the refactor, drive `:5180`: a Track-To'd box
and an aimed camera must be visually unchanged, and a _second_ Track-To added to the
same object must now compose (the new capability) rather than be ignored (first-wins).
Compare a before/after screenshot of the single-constraint case for byte-identity.

**Non-goals for Phase 1.** No Constraints panel (Phase 2), no Follow-Path (Phase 4),
no per-member blend weight (Phase 6). Phase 1 is purely "one → N, single stays
identical."

---

## 8. Phase 2 — the Constraints panel

Mirror `ModifierStackControls.tsx` exactly — it is the proven stack-UI template.

- **`ConstraintStackControls.tsx`** in the NPanel `'constraint'` inspector section:
  for the selected object, list its constraint stack bottom→top with per-row
  **mute (●/◌) / reorder (▲/▼) / remove (✕)** and a **"+ Add Constraint"** menu
  (Track-To today; Follow-Path/Copy-Location as they land). Same data-testids pattern
  (`constraint-row-*`, `constraint-mute-*`, …) for e2e parity with the modifier suite.
- **Op-builders** in a new `constraintStack.ts`, mirroring `operatorStack.ts`'s
  `buildAdd/Move/Remove/ToggleMute` builders — but operating on the **`order` field**
  (renumber on move) and on **`target`** (add = create a `TrackTo` with `target` set),
  **not** on edges. Every mutation is a pure `Op[]` dispatched via `dispatchAtomic`
  → save/undo/animate for free (the studioProfiles/operatorStack template).
- **Fold in the sidecars.** The camera look-at dropdown and the studio-light aim become
  thin entry points that _add a Track-To to the stack_ (or are replaced by the panel
  for the camera). This retires the bespoke surfaces — the answer to "why no
  Constraints tab": there is one now, and the sidecars are members of it.

Reorder/add/remove all reduce to `setParam(order)` / `addNode(TrackTo, {target})` /
`removeNode` — no re-wiring, because the stack is edge-less.

---

## 9. Phases 3–6 — the camera rig (brief; own issues later)

Ordered by dependency; each is additive over Phase 1's stack.

- **Phase 3 — `Curve` scene object.** Control points + resolution; a viewport helper
  (`CameraHelpers.tsx`-style); a world-space sampleable polyline exposed via a
  `geometrySampleSource`-style seam (the same seam the Ray sensor reads through). A
  `SceneObject` like Null/Camera, so it lives in the Outliner naturally.
- **Phase 4 — `FollowPath` (headline).** A Phase-1 stack **member** that writes
  **position** by sampling the Curve at a keyframeable **`evalTime`** param. Because it
  writes position and Track-To writes rotation (orthogonal bands, §4), "travel the path
  while locked on the subject" composes with no ordering. `evalTime` is an ordinary
  keyframeable param → **eased accel/decel falls out of the existing F-curve editor**
  (bézier handles, V49/V50) — nothing new to build for speed easing.
- **Phase 5 — framing overlays (independent polish).** Passepartout + aspect gate, real
  near/far limit lines, DoF focus-plane gizmo, camera name label — additive over
  `CameraHelpers.tsx`. Camera monitor (dual view) is the heaviest and is deferred.
- **Phase 6 — extras (all cheap Phase-1 members).** Copy-Location, Limit-Distance,
  Damped-Track, and rack-focus (decoupled DoF focus target ≠ aim target).

---

## 10. Container extraction (B27) — not yet

When Phase 1+ lands, Basher has **three** container-ish operator constructs: the
`OperatorStack` (mesh sub-chain), the `Solver` meta-op (value sub-graph cooked with
feedback), and this relational-CHOP/Constraint stack (an ordered set of pose-writers —
the first `stateless-graph` relation-owning-a-set case the B27 survey said to wait for).
**Do not extract a unified container before the constraint stack is a concrete third
case.** The prior survey verdict (defer — the three diverge on container-marker,
enumeration, and eval-contract) stands until the third instance exists to measure. Earn
it from three concrete cases, per the domain-aligned-abstraction discipline; don't guess
the god-class.

---

## 11. Open decisions (for the checkpoint)

1. **Substrate-first vs rig-first.** This doc recommends substrate-first (Phase 1 stack
   → Phase 2 panel → then the Curve/FollowPath rig), because building Follow-Path before
   the stack is a fourth sidecar. The alternative (rig-first, migrate later) trades a
   temporary sidecar for a faster visible camera rig. **Recommendation: substrate-first.**
2. **Overlays timing.** Phase 5 (passepartout, limit lines, focus gizmo) is independent
   of the stack and could ship early as quick wins, or after the rig. **Recommendation:
   after Phase 4**, so the rig is the headline.
3. **Camera monitor (dual view) scope.** Heaviest single item (a second render view that
   doesn't replace look-through). **Recommendation: its own epic, out of this plan.**
4. **Single-band conflict semantics.** Last-writer-wins is proposed (§4). Per-member
   `influence` blend is Phase 6. Confirm last-writer-wins is acceptable for v1.

---

## Appendix A — grounded file map

| Concern                              | File(s)                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| First-wins constraint scan (→ stack) | `src/app/nodeConstraints.ts` (`trackToForTarget:66`, `constraintTargetSet:97`, `resolveConstraintRotation:119`, `resolveTrackToTarget:178`) |
| Edge-less constraint node            | `src/nodes/TrackTo.ts` (`mute:39`, `out socket:52`, `pure:true`)                                                                            |
| Camera pose hook                     | `src/app/activeCamera.ts:332` (`resolveCameraPoseAt` applies `resolveTrackToTarget` → `pose.lookAt`)                                        |
| SOP-stack precedent (edge-chain)     | `src/app/operatorStack.ts` (`enumerateOperatorStack`, `buildAdd/Move/Remove`); `src/app/ModifierStackControls.tsx` (panel UI to mirror)     |
| Edge-less ordering precedent         | `src/nodes/ParamDriver.ts:70` (`order` field); `src/app/paramDrivers.ts` (the driver seam)                                                  |
| Driver / sensor seam                 | `src/app/paramDrivers.ts`, `src/app/statefulOps.ts`, `src/nodes/geometryQuery.ts` (Ray sensor)                                              |
| Sidecars to fold in (Phase 2)        | `src/app/CameraLookAtTarget.tsx`, `src/app/studioLightRig.ts`                                                                               |
| Ground Truth                         | `ref/GROUND_TRUTH_HOUDINI_OPERATORS.md`, `…_DRIVERS_CONTROLLERS.md`, `…_RAY_SOP.md`                                                         |
