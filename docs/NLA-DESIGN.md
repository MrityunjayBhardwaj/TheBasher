# NLA / Action Strips — Motion-Space Layering Design

> Status: **DESIGN / Phase 0 complete.** Grounded on Blender source + Houdini/Cinema 4D reference docs.
> Scope: the 3D **motion space** only. The 3D→video (Shot-as-compositor-clip) bridge is a **separate deferred epic** — §9.
> Sibling doc: `docs/UNIFICATION-DESIGN.md` (the v0.7 AnimationLayer retirement that deliberately deferred this feature).

---

## 0. TL;DR

Basher animates one **curve per `(target, param)`** via free-floating `KeyframeChannel*` nodes (V57). The overlay resolver that applies them (`overlayChannels.ts:54-62`) is a **single-slot read-and-overwrite loop**: two channels on the same param → last-writer-wins at weight 1, scan-order-dependent lerp below it, order = DAG node order (undefined). That is the **V88 D3 multi-writer hazard**, and it is exactly the seam NLA needs.

NLA is **not a new subsystem** — it is giving that resolver a _control surface_: replace the single-slot loop with an **ordered, weighted, bottom→top stack-fold** (`Action` / `Strip` / `Track`), where order, blend mode, and influence are **authored** instead of accidental. The V88 D2 AnimationLayer retirement anticipated exactly this: it stripped layering down to per-channel `mute`/`weight` and punted "weighted multi-source layering" to _"a future SceneAnimation aggregator that knows about all layers"_ (`AnimationLayer.ts:88-92`). **This is that aggregator.**

The grounding verdict: **~80% of NLA is assembly of primitives we already shipped** (retime = `resolveSampleTime` #277; extrapolation = extend/cycles #269/#275; blend-in/out ramps = `effectiveInfluence` #279; presence-based layering = `resolveGltfChildTrs` R-4; per-type dispatch = `valueType`). The one genuinely new thing is **the fold reducer**.

---

## 1. The problem — two roads, one broken slot

### 1.1 The capability gap

One channel per param means: no reusable named performances ("author a walk once, drop it three times"), no non-destructive layering of two animations on the same param, no crossfades, no retiming a whole performance as a unit, no weight-as-a-channel. All are V88 D2 — the biggest remaining animation-parity gap.

### 1.2 The structural bug underneath (V88 D3)

`overlayChannels.ts:54-62`:

```
acc = base
for ch in channelsTargeting(node):     // order = Object.values(nodes) insertion order — undefined
  original = readAt(clone, ch.paramPath)  // reads the RUNNING clone, not the pristine base
  w = weight * (ch.weight ?? 1)           // weight is hardcoded 1 at every call site
  writeAt(clone, ch.paramPath, blend(original, ch.sample(t), w))  // overwrites the same slot
```

Consequences (all cited by the surface map):

- **Last-wins / discard:** at `w=1`, `blend` returns the channel value outright (`overlayChannels.ts:104`) — a second channel silently discards the first. No sum, no average, no defined precedence.
- **Order is DAG-order, not authored** — the tie-break is node insertion order (`nodeChannels.ts:46-52`).
- **No additive mode** — `blend` only lerps toward base (`overlayChannels.ts:97-138`).
- **Rotations can't blend** — quat/color snap at the half-weight mark (`overlayChannels.ts:137`); no slerp.
- **Every render/read call passes weight `1`** (`SceneFromDAG.tsx:768,848,1548,1621,2849`; `resolveEvaluatedTransform.ts:232`).

Fixing 1.2 _is_ the foundation of 1.1.

---

## 2. Grounding — Blender / Houdini / Cinema 4D

Three independent implementations of the same problem. Where they **converge** → a Basher invariant. Where they **diverge** → a Basher choice. (Blender is open-source, so we cite exact source; Houdini/C4D are reference-model grounding.)

### 2.1 The converged invariants (LOCK these)

**I-1 — Data/placement separation; the source is immutable.** All three separate the animation DATA from a lightweight, non-destructive PLACEMENT that references it:

- Blender: `Action` (F-curves at _relative_ RNA paths) + `NlaStrip` (references `act` + a `slot_handle`, never rebinds channels — `DNA_anim.h:436-455`).
- C4D: immutable `Motion Source` + reusable `Motion Clip` _instance_ of it (help.maxon.net _Motion System_ 33015).
- Houdini: `MotionClip` (data as packed-primitive poses) + blend/retime/sequence nodes (sidefx.com kinefx/motionclips).
  All three: **edits (loop/trim/time-warp/blend) live on the placement; the source is never rewritten.**

**I-2 — The final value is a weighted, ordered stack-fold over a base.** Blender's whole NLA is `nlasnapshot_blend` folding strips **bottom→top**, one `blend(lower, strip, mode, influence)` per channel (`anim_sys.cc:3482-3491, 3687-3711`). C4D: `N layers × {Mode} × {Layer Value weight} × {order} × {mute/solo/passthrough}`. Houdini: `motionclipblend` layer over base with per-sample `Effect Anim` weight. **Reorder ⇒ different result.** Never first/last-wins.

**I-3 — Per-channel "touched" domain; no implicit zeroing.** A strip only affects the params it actually keys; untouched params copy from the lower stack; unrepresented params fall back to the property's base/default (Blender `blend_domain` bitmap `anim_sys.cc:2183-2186`, base-snapshot fallback `3703-3705`). Basher already does exactly this **presence-not-value** layering in `resolveGltfChildTrs` (R-4: manual→baked→clip→base, `resolveEvaluatedTransform.ts:188-203`).

**I-4 — Additive/Combine needs a per-TYPE neutral reference — not the accumulator, not an artist rest.** _(This corrected an inference: the C4D and Houdini docs don't state the reference; both agents guessed "delta over the lower stack." Blender's SOURCE contradicts it.)_ Blender COMBINE-ADD subtracts the **property's default/identity** — `0` for add-channels, `1` for scale, identity-quat for rotation, captured once as a base snapshot (`anim_sys.cc:1512-1547, 1892`). This is what makes **a full-influence layer over an empty stack reproduce the source exactly**. The reference is type-dependent, captured, and distinct from the fold accumulator.

**I-5 — Rotations blend on the quaternion manifold.** Blender needed a dedicated `nla_combine_quaternion` (normalize → `strip^influence` → quaternion-multiply, `anim_sys.cc:2017-2029`) because componentwise lerp leaves the unit manifold (un-normalized, non-uniform angular rate, wrong for >2 stacked strips). Houdini: slerp / N-quaternion weighted slerp (VEX `slerp`), component-wise called "abrupt." C4D: per-layer `Quaternion Interpolation` boolean. **Replace-rotation → slerp; additive/Combine-rotation → power-multiply** (different manifold algebras for different modes).

**I-6 — Retiming is a pure per-frame time remap, never baked.** Blender `nlastrip_get_frame_actionclip`: `actstart + fmod(cframe − start, actlen·scale)/scale` (`nla.cc:706-768`; reverse flips at `:748`); animated Strip Time via the strip's own F-curve + cyclic wrap (`anim_sys.cc:1059-1071`). C4D: a `Timing` warp curve (`SplineData`) + loop + trim. Houdini: `motionclipretime` (resample by time/frame/speed; Clamp/Loop/Mirror end behavior).

**I-7 — Influence is a single scalar weight that may be an animatable curve.** Blender: automatic blend-in/out linear ramp OR a `use_animated_influence` F-curve (`anim_sys.cc:1009-1027, 1049-1051`). C4D: keyframeable `Layer Value` (crossfades ARE animated layer weights — "Make Transition"). Houdini: `Effect Anim` per-sample weight.

### 2.2 Divergent / non-universal choices (Basher's call — and we can do better)

- **Blender auto-detects the Combine sub-mode from the RNA subtype** (`anim_sys.cc:1550-1563`). We already carry an explicit **`valueType`** on every channel — dispatch on it directly, no reflection.
- **Blender's MULTIPLY-blend formula** (`inf·(lower·strip)+(1−inf)·lower`, `:1860`) is a convention, not a law.
- **Blender's extrapolation asymmetry** (hold-backward only for a track's first strip, `:1114-1123`) is a UX choice.
- **Blender keeps a legacy "active Action as an implicit top strip"** (`:3479`) — we make **every layer a real strip**.
- **Houdini stores motion as GEOMETRY** (packed-prim poses) — not our world; we are curve-based, like Blender.
- **C4D couples one Motion System tag to a whole hierarchy** — a C4D structural quirk, not an NLA law.
- **Transition/Meta strip types + Blender's key-_through_-the-stack invertible remap** — defer past v1.

---

## 3. Target architecture

### 3.1 The reducer (the one new thing)

Replace `overlayChannels`' single-slot loop with a **bottom→top weighted fold** per param:

```
resolveLayeredParam(node, param, t):
  acc      = node.baseValue(param)          // REPLACE lower + I-3 untouched fallback
  identity = paramIdentity(valueType)       // I-4: 0 / 1 / quat-identity  (Combine reference, NOT acc)
  for track in tracksFor(node)  (mute/solo filtered, authored order):
    for strip in track.activeStripsAt(t):   // t ∈ [start,end] extended by extrapolation (I-6)
      if !strip.affects(param): continue     // I-3 touched-domain (presence, not value)
      τ   = strip.remap(t)                    // I-6 — resolveSampleTime-shaped
      v   = strip.action.sample(param, τ)
      inf = strip.influenceAt(t)              // I-7 — effectiveInfluence ramp OR a channel
      acc = blend[strip.mode](acc, v, identity, inf, valueType)
  return acc
```

`acc = base` when there are no tracks → **byte-identical to today**. A single REPLACE strip at `inf=1` → the strip value → matches today's last-writer. The existing-animation gate holds _by construction_, and V88 D3 becomes the defined fold.

### 3.2 Blend algebra (grounded, Blender `nla_blend_value` / `nla_combine_value`)

Two families:

- **Replace** — `lower·(1−inf) + strip·inf` (Blender `:1871`). This is _exactly_ today's `overlayChannels` lerp ⇒ Replace-only = byte-identical.
- **Combine** — the mode that composes correctly, type-dispatched on `valueType`:
  - number / vec (add): `lower + (strip − identity)·inf` (identity 0; Blender `:1892`)
  - scale (multiply): `lower · (strip / identity)^inf` (identity 1; Blender `:1898`)
  - quat: `lower ⊗ strip^inf` (normalize → power → q-mul; Blender `nla_combine_quaternion :2017-2029`)
- `inf == 0` short-circuits to `lower` (free byte-identity for muted / zero-weight strips; Blender `:1847-1849`).

### 3.3 Data model (three edge-less sidecar node kinds — mirroring the V57 channels & camera)

```
Action  { name, channels: { paramPath, valueType, keyframes[], modifiers[] }[] }   // paths RELATIVE, no target
Strip   { action: ref, target: dagId | targetMap,     // I-1 placement binds the concrete target
          start, end, timeOffset, timeScale, repeat, reverse,   // I-6 retime
          extrapolate: 'hold' | 'nothing' | 'hold-forward',     // I-6 outside the strip
          blendMode: 'replace' | 'combine',                     // §3.2
          influence: number | channelRef, blendIn, blendOut }   // I-7 weight (auto ramp or channel)
Track   { name, strips: Strip[], mute, solo }                   // I-2 ordered container
```

These live **outside `scene.children`** (the V57/`activeCamera` sidecar pattern — reached by resolver scan, not an edge). An **Action** is precisely a V57 channel bundle with the `target` _un-bound_: `paramPath` relative to a target-role, `target` supplied by the Strip. A **Track** is the return of `AnimationLayer`'s `mute`/`solo` — now with a real consumer.

### 3.4 The primitive-reuse map (why this is mostly assembly)

| NLA primitive                                   | Reuses                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| Strip retime (`τ = remap(t)`)                   | `resolveSampleTime` (#277) — same global→local remap shape            |
| Strip extrapolation (hold/nothing/hold-forward) | `resolveExtend` + Cycles (#269/#275) at strip scope                   |
| Strip blend-in/out ramp                         | `effectiveInfluence` restricted-range ramps (#279)                    |
| Touched-domain (presence layering)              | `resolveGltfChildTrs` R-4 (`resolveEvaluatedTransform.ts:188-203`)    |
| Per-type blend dispatch                         | the `valueType` tag already on every channel                          |
| Influence as a channel                          | a channel targeting `strip.influence` — we already keyframe any param |
| Action = relative channel bundle                | V57 free-floating channel minus the bound `dagId`                     |

### 3.5 What stays unchanged (Chesterton)

The channel sampler (`keyframeInterp.ts`), the F-Modifier stack (`channelModifiers.ts`), the per-channel schemas, `nodeChannels` enumeration, and the render/read seams (`DirectChannelsR`, `resolveEvaluatedTransform`, `resolveEvaluatedParam`) are untouched in shape — the reducer slots in _inside_ the existing overlay call, and because render + read + compositor all funnel through it, NLA lights up everywhere at once (the H40 payoff, `overlayChannels.ts:60-61` "one band, two callers").

---

## 4. Byte-identity & migration

- **No schema bump to existing channels.** NLA nodes (Action/Strip/Track) are additive and optional; a per-channel `blendMode`/`order`/`influence` (Phase 1) is additive/defaulted.
- **Empty tracks ⇒ `acc = base` ⇒ byte-identical.** A pre-NLA project has no tracks; a single channel is a degenerate single-contribution fold. Gated the way #274–#281 were: an existing-animation fixture must render byte-identically with the reducer in place.
- **No file migration needed** for existing projects (unlike the AnimationLayer retirement, which was a graph rewrite). Per-channel `mute`/`weight` stay as-is (a bare channel = a degenerate Replace contribution).

---

## 5. Invariants — preserved & new (catalogue-ready)

Preserved: **H40** (render == read == curve — one reducer, all consumers); **V57** (free-floating, edge-less channels; Actions/Strips are the same sidecar pattern); the **F-Modifier / interp / extend** stack is untouched under the reducer.

New (to add to `.anvi/vyapti.md`, closing **V88 D3** and advancing **D2**):

- **V88 D3 (multi-writer precedence) → RESOLVED:** multiple contributions to one `(target,param)` combine by an **ordered, weighted, bottom→top fold** with an explicit blend mode; never scan-order-dependent. (I-2)
- **V88 D2 (weighted multi-source layering) → IMPLEMENTED (motion space):** Action/Strip/Track over the reducer.
- **New invariant — the neutral reference:** additive/Combine layering subtracts the param's **per-type identity** (0 / 1 / quat-identity), captured as a base snapshot, so a full-influence layer over an empty stack reproduces the source. (I-4)
- **New invariant — manifold rotation:** rotations blend via slerp (Replace) or normalize→power→q-mul (Combine), never componentwise. (I-5)

---

## 6. Phasing (each slice: gate + observe + one atomic commit + push)

**Phase 1 — The reducer foundation (fixes V88 D3; NO Action/Strip UI).** Replace `overlayChannels`' single-slot loop with the bottom→top fold over an ordered contribution list. Add additive/defaulted per-channel `blendMode` ('replace' default) + `order` + keyframeable `influence` so _channels themselves_ become proto-strips (Blender's "active action = top strip", generalized). Implement Combine (§3.2) + the per-type identity (I-4) + the quaternion path (I-5). _Gate:_ existing-animation fixture byte-identical; a NEW boundary-pair e2e stacks two channels on one param (replace vs combine) and asserts the defined, order-stable result (render == read). _Observe:_ two position channels on one box → additive sum, not last-wins.

**Phase 2 — Action / Strip / Track nodes.** The three sidecar node kinds (§3.3) + strip enumeration alongside `nodeChannels`. Strip `remap` via `resolveSampleTime`; `extrapolate` via `resolveExtend`; `influenceAt` via `effectiveInfluence`. Strip references an Action; the reducer folds strips per track. _Gate:_ a Strip placing an Action drives render == read (H40); empty track set byte-identical (falsify). _Observe:_ one Action dropped as two strips at different times replays twice.

**Phase 3 — Reuse, retarget & crossfade.** Bind one Action to a _different_ target (the I-1 target-map / "slot"); overlapping strips + blend-in/out ⇒ crossfade (influence ramps, C4D "Make Transition" = animated weights). _Gate:_ the same Action drives two different objects; a crossfade e2e (strip A influence→0 while B→1 over the overlap) render == read. _Observe:_ walk→idle crossfade on one target.

**Phase 4 — Agent mutators** (the #281 pattern): `createAction`, `addStrip(action, track, start, mode, influence)`, `setStripTiming`, `setStripBlend`. Additive, honest contract signatures, `__basher_dispatchMutator` e2e (strip → render == read + falsify). _Observe:_ agent composes "walk from t0, crossfade to idle at t3" end to end.

**Phase 5 — UI: NLA lanes.** Track/strip lanes in the timeline (mirroring the compositor's `LayerTimeline` metaphor — the same strips-on-tracks grammar); strip drag/trim/scale; blend-mode + influence controls; tweak-mode (edit an Action's keys in place, writes propagate to all strips referencing it). _Gate:_ 6-pillar UI audit + a11y contrast; e2e drives a lane gesture → setParam → render.

**Deferred to its own epic — §9 the 3D→video bridge.** NLA does not depend on it.

---

## 7. Risks & mitigations (pre-mortem)

- **R1 — Reducer changes an existing render (byte-identity break).** _Mitigation:_ Replace-only path is the current lerp verbatim; `inf==0` short-circuit; existing-animation fixture gate before any Action lands (Phase 1). This is the #274–#281 discipline.
- **R2 — Quaternion algebra wrong (wobble/gimbal).** _Mitigation:_ ground the two modes separately (Replace=slerp, Combine=power-multiply, I-5); unit-test against known 2- and 3-strip stacks; the "component-wise is visibly abrupt" tell is the observation.
- **R3 — The neutral-reference confusion (Fork B).** _Mitigation:_ keep TWO references explicit — the fold accumulator (Replace lower + untouched fallback) vs the per-type identity (Combine delta). Documented I-4; unit-test "full-influence Combine over empty stack == source".
- **R4 — O(all-nodes) enumeration cost with many strips.** _Mitigation:_ strips enumerate like channels (`nodeChannels` precomputed target set); measure before indexing — the cost curve, not inference.
- **R5 — Scope creep into the video bridge.** _Mitigation:_ §9 is a hard boundary; a Strip resolves to transforms/params, never pixels.
- **R6 — Stateful ops (spring/lag) break `f(t)` purity** (Houdini's CHOP caveat). _Mitigation:_ out of scope; if added later, they come as a fixed cook-contract + seed, not inside the pure fold.

---

## 8. Test strategy

- **Unit:** the fold reducer (order, Replace/Combine per type, identity reference, quaternion 2-/3-strip stacks, `inf==0` short-circuit, touched-domain); `strip.remap` parity vs `resolveSampleTime`; extrapolation vs `resolveExtend`.
- **Byte-identity:** existing-animation fixture renders identically with the reducer in place (the strongest proof, per #275).
- **Boundary-pair e2e (H40) per phase:** the authored strip/blend drives render == read == intended; **falsify** (empty tracks / muted strip / `inf=0` reverts to base).
- **Agent-path e2e:** `__basher_dispatchMutator` runs the strip mutators end to end (Phase 4).

---

## 9. The 3D→video bridge — DEFERRED (separate epic)

The maps confirmed the seam is real but unwired, and **NLA must not touch it**:

- A `Shot` is inert metadata (`Shot.ts:33-42`, `{name,startTime,endTime}` + camera + scene → `ShotValue`), consumed by nothing but the (also-unconsumed) `Cut` node.
- Its output is `type:'Shot'` and cannot reach `Layer.source`'s `type:'Image'` — there is **no `Shot→Image` adapter**.
- The compositor decode dispatches only `MediaClip` / `ComfyUIWorkflow` (`compositeDecode.ts:161/175`); the headers **name** Shot/scene-render as the intended third source kind (`MediaClip.ts:16`, `Layer.ts:4`), and `composite.ts:77` even handles "source null for a not-yet-rendered scene layer" — a designed-for slot.
- The global `useTimeStore` is already the shared clock for both the 3D render and the compositor (`renderImageAction.ts:84`; `CompositeViewer.tsx:41`).

The bridge epic is therefore: a **`Shot`-as-render source node** (renders camera-Action + scene → Image-over-time), **one `base.type` branch** in `collectCompositeInputs`, and a **bake/cache boundary** at the render node (you cannot re-render a nested shot every composite frame). Two blend algebras — value-domain (NLA) and pixel-domain (compositor) — joined by that render node; the timeline _metaphor_ and the _channel substrate_ are shared (compositor params already keyframe through the identical `KeyframeChannel` mechanism, `resolveEvaluatedParam.ts:48-77`), the _blend resolvers_ are not.

---

## 10. Catalogue impact (on implementation)

- `.anvi/vyapti.md` **V88 D2/D3** — mark D3 RESOLVED (the fold), D2 IMPLEMENTED (motion space) with the four new invariants (I-2, I-4, I-5, plus the reducer as the multi-writer authority).
- `.anvi/krama.md` — the fold order (base → tracks bottom→top → strips → touched-domain), a lifecycle dependency.
- `.anvi/dharana.md` — the reducer boundary (the former single-slot loop) as a flagged hot zone with the I-4 two-reference trap as its silent-failure mode.
- Consider a **Ground Truth doc** `ref/GROUND_TRUTH_BLENDER_NLA.md` from the cited `anim_sys.cc`/`nla.cc` findings (the blend formulas + the quaternion path + the retime map), per the three-layer grounding rule.

---

## 11. Phase 0 — locked decisions (grounded)

- **Fork A → TEMPLATE (3/3):** Action = relative-path channel bundle; Strip binds the target; cross-target reuse = explicit retarget (I-1). (Blender `DNA_anim.h:436-455`; C4D Source/Clip; Houdini explicit retarget.)
- **Fork B → per-type IDENTITY, NOT the accumulator (Blender source corrected the C4D/Houdini inference):** Combine subtracts 0 / 1 / quat-identity captured as a base snapshot (I-4; `anim_sys.cc:1512-1547, 1892`).
- **Fork C → reducer-first, unanimous:** the bottom→top weighted fold is the load-bearing foundation; build it before any Action/Strip UI (I-2; `anim_sys.cc:3482-3491`).
- **Fork D → quaternion required for stacked rotations, per-strip:** Replace=slerp, Combine=power-multiply; deferrable only for a Replace-only v1 (I-5; `nla_combine_quaternion :2017-2029`).

### Grounding citations

- **Blender (source, `blender/blender` main):** `DNA_anim_types.h:427-521` (NlaStrip/Track/Action DNA); `anim_sys.cc:1009-1147` (influence + extrapolation), `:1512-1563` (base default + mix-mode detect), `:1841-1904` (`nla_blend_value` / `nla_combine_value`), `:2017-2029` (`nla_combine_quaternion`), `:2165-2225` (per-value dispatch), `:3479-3711` (stack accumulate + `nlasnapshot_blend`); `nla.cc:706-768` (retime map), `:811+` (tweak remap). Manual: `editors/nla/*`.
- **Houdini (SideFX docs — reference-model):** kinefx/motionclips, motionclipblend (`Effect`/`Bias`/`Effect Anim`), motionclipretime (Clamp/Loop/Mirror), VEX `slerp`, kinefx/retargeting; local `ref/houdini/CHOP.md`.
- **Cinema 4D (Maxon docs — reference-model):** help.maxon.net _Motion System_ (33015), _MT_TAG_; SDK `mt_layer` (Mix/Relative/Absolute, Layer Value, Quaternion Interpolation, mute/solo/passthrough), `mt_clip` (Loops, Trim, `TIMWARPWND` timing curve, `TYPEFADEOUT` blend).
