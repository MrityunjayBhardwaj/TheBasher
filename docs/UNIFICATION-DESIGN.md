# v0.7 Unification — One Animation Road for Native Meshes, glTF Children, Cameras & Lights

**Status:** DESIGN / proposed — not yet approved for implementation
**Author:** (drafted on `ux-overhall`, tip `94579ed`)
**Supersedes the narrow framing of:** #188 (glTF material-scalar animation) — #188 becomes one slice that falls out of this refactor for free
**Catalogue anchors:** V32 (renderer-agnostic IR), V34 (one substrate, producer builds it), V53 (one material IR, two callers), V56 (camera direct-channel resolver), V20 (one precedence rule), H40 (displayed ≠ rendered / two-callers band), H104 (custom inspector controls bypass generic affordances), H48 (no per-frame time subscription)

---

## 0. TL;DR

Basher animates the same kind of thing — a node's params over time — through **three different mechanisms** that grew at different times:

| Mechanism | Used by | Shape |
|---|---|---|
| **AnimationLayer** (legacy) | native `BoxMesh` / `SphereMesh` / `Transform` / `Character` | a wrapper node that re-parents the target in `scene.children`, clones it, and patches sampled channel values at `paramPath` |
| **Baked direct channels** | glTF children (transform) | free-floating `KeyframeChannelVec3` with `target = dagId`, enumerated per-asset, overlaid by a pure resolver consumed by renderer **and** read-side |
| **Direct camera channels** | the active camera | free-floating channels targeting `scene.camera`, overlaid by `resolveActiveCameraPoseAt`, consumed by viewport + still + animation render |

The latter two are the **same evolved pattern** — direct channels + a pure resolver + "one band, two callers" (H40). The first is the lone legacy holdout. **AnimationLayer is the odd one out.**

**Decision:** adopt the glTF/camera direct-channel road as *the* universal mechanism. Generalize the proven pattern (don't invent a new one); **absorb `AnimationLayer`'s patch logic into a free resolver** and retire the wrapper node. Native primitives keep producing their geometry but route their animation/override bands onto the unified road. One converged OpenPBR material editor serves native + glTF.

This is multi-session and migration-bearing (V4). It must be sliced — each slice gated (`vitest`/`tsc`/`eslint`/`prettier`/`e2e`) **and** observed (real app / e2e), one atomic commit each.

---

## 1. The problem — two roads through the DAG

### 1.1 The asymmetry, by band

| Band | Native mesh (`BoxMesh`/`SphereMesh`) | glTF child (`GltfChild`) | Unified today? |
|---|---|---|---|
| Material IR | OpenPBR `material` (single object param) | OpenPBR `materials[]` (one per slot) | ✅ V53 — same IR |
| In `evaluate()` value | ✅ `material` surfaced (`BoxMesh.ts:73`) | ❌ transform only; `materials` **not** surfaced (`GltfChild.ts:93-103`) | ❌ |
| In `SceneChild` union | ✅ (`types.ts:753-763`) | ❌ deliberately a non-producer (`types.ts:530-533`) | ❌ (by design) |
| Renderer reads | the evaluated value | `node.params.materials` via S3 overlay (`SceneFromDAG.tsx:1442-1445`) | ❌ |
| **Transform animation** | AnimationLayer dotted `paramPath` (`position`) | **baked direct channels** → `resolveGltfChildTrs`, two callers (`resolveGltfChildTransform.ts:8-14`) | ❌ different mechanisms |
| **Material animation** | ✅ AnimationLayer dotted `material.color` (`AnimationLayer.ts:122`, `dispatchMutator.ts:426`) | ❌ none — the #188 gap | ❌ |
| Inspector | generic `ParamRow` (auto-diamond + autoKey) | custom `GltfMaterialEditor` (no diamonds — H104) | ❌ |

### 1.2 The three animation mechanisms (the real root)

**(a) AnimationLayer — the legacy wrapper.** `AnimationLayer.ts:79-115`. `evaluate()` wraps a `target` SceneChild + an `animation` list socket of channels; returns a `sampleTarget(seconds)` closure that deep-clones the target and `writeAt(paramPath, blend(sampled))` for each channel (`AnimationLayer.ts:132-148`). The renderer (`AnimationLayerR`) and `resolveEvaluatedTransform` both call `sampleTarget` — already a two-callers boundary, but built around a **wrapper node** that must be inserted into `scene.children` (re-parenting the target).

**(b) glTF baked direct channels.** `bakedGltfChannels.ts` + `resolveGltfChildTransform.ts`. A `KeyframeChannelVec3` carries `target = GltfChild dagId` + `childName` + `paramPath ∈ {position,rotation,scale}`. `bakedChannelSamplersForAsset` enumerates them per asset; `resolveGltfChildTrs` layers `manual → baked → clip → base` per-component by **presence, not value** (R-4). **Both** the renderer useFrame **and** `resolveEvaluatedTransform` consume it (BLOCK-1, the literal "one band, two callers"). **No AnimationLayer, no re-parenting.**

**(c) Direct camera channels.** `activeCamera.ts` `resolveActiveCameraPoseAt(state, seconds)` — static base (`cameraPoseFromNode`) overlaid with any channel whose `target` is the camera node, sampled via the shared interp primitives. Fed by `dispatchCameraFirstKey` (a free-floating channel — explicitly **not** `addLayer`, because the camera is wired via `scene.camera`, outside the layer machinery). Consumed by viewport look-through + still + animation render (V56).

**The shared substrate already exists.** All three sample through the same primitives (`buildVec3Sampler`, `sampleScalarKeyframes`, `keyframeInterp.ts`). The path-writer `writeAt` is **already exported and shared** between `AnimationLayer.patchTarget` and `overlayTransients` (`AnimationLayer.ts:160-167` — "one path-writer, no drift, H40"). What differs is only the **attachment + resolution** wrapper: (a) re-parents into a node; (b)/(c) target by id and resolve with a free function.

### 1.3 Why this is a structural problem, not a missing feature

Per the project's own fatality test: a single concern (animate a node's params over time) is enforced in **three** places with three attachment models. Every new animatable surface (glTF materials = #188; lights; future params) must pick one of the three and re-thread two callers. That is the span-mismatch signal — the organization is fighting the domain. #188 is just where it next became visible.

---

## 2. The decision

### 2.1 Reference road: glTF/camera direct channels (architectural reading)

Two readings of "absorb the primitive onto glTF" were considered:

- **Literal (REJECTED):** make a `BoxMesh` an actual `GltfChild`-backed object — three owns even the box geometry; one node type for everything. *Cost:* loses parametric geometry (re-`size` ⇒ regenerate an asset), couples primitives to the import pipeline, pays import cost for a cube. Lossy — rejected.
- **Architectural (CHOSEN):** the glTF child is the *reference design*, not a literal container. The primitive keeps producing its geometry from params, but its **animation + override bands** move onto the glTF/camera road: direct channels + a pure resolver overlaying sampled channels onto the primitive's evaluated base, renderer + read-side both consuming it.

The architectural reading is the same destination as "one animation mechanism," and it names **which** mechanism wins: the proven direct-channel road. We **generalize an existing, H40-clean pattern** rather than invent a replacement for AnimationLayer.

### 2.2 The producer/non-producer reconciliation (the trap, named)

A native primitive is a **geometry producer** (`size → evaluate() → mesh`); a glTF child is a **non-producer** (three owns geometry; the node only overrides). The glTF child can be "override-only" precisely because something else owns the base. A primitive has no external owner — it **must** keep producing.

Resolution: unification is at the **animation/override layer, not the production layer.** The primitive's `evaluate()` still emits its base value (geometry + static params). The change is that the **sampled-channel overlay** moves out of the `AnimationLayer` wrapper into a free resolver, exactly like the camera's static base + channel overlay. The "base" the resolver overlays onto is the node's own evaluated value (camera: `cameraPoseFromNode`; glTF: seeded import TRS / params; primitive: `evaluate()` output). Same shape, three sources of base.

---

## 3. Target architecture

### 3.1 The one road

```
ANIMATION = direct channels + one overlay resolver + two callers

  Channels:  free-floating KeyframeChannel{Number,Vec3,Quat,Color}
             target  = the animated node's dagId        (KeyframeChannelNumber.ts:40)
             paramPath = dotted band into the value      (':42' — e.g. 'material.base.color', 'position', 'fov')
             function-of-time sample(seconds)            (V24 — pure, no time input; H48)

  Resolver:  resolveEvaluated(baseValue, channelsForTarget, seconds)
             = AnimationLayer.patchTarget LIFTED OUT of the wrapper node:
               clone(base); for each channel: writeAt(paramPath, blend(sample(seconds)))
             writeAt is ALREADY the shared path-writer (AnimationLayer.ts:168)

  Callers:   (1) renderer reads the RESOLVED value at the useFrame time snapshot
             (2) read-side (gizmo / NPanel / dopesheet) reads the SAME resolver at ctx.time
             → displayed == rendered (H40); never two parallel walks (V20)
```

The camera (`resolveActiveCameraPoseAt`) and glTF transform (`resolveGltfChildTrs`) are the **two existing instances** of this resolver. Unification adds the third caller family (native mesh) and the missing band (glTF materials, #188), then **collapses the per-kind resolvers toward one generic overlay** where the base differs only by source.

### 3.2 What "absorb AnimationLayer" means, precisely

`AnimationLayer.patchTarget` (`AnimationLayer.ts:132-148`) is *already* the universal overlay — clone the base, `writeAt` each channel's sampled value at its `paramPath`, with `blend()` for partial weight. To absorb it:

1. **Lift `patchTarget` into a free resolver** that takes (base value, the channels targeting this node, seconds) — no wrapper node, no `scene.children` re-parenting.
2. **Find channels by `target` dagId**, the camera/glTF way, instead of by the layer's `animation` input socket.
3. **Renderer + read-side both call the resolver** (they already both call `sampleTarget`; we change *where the channels come from* and *that there's no wrapper to unwrap*).
4. **Retire the `AnimationLayer` node** once nothing produces or consumes it.
5. **mute / solo / weight / boneMask** (`AnimationLayer.ts:45-51`) are the only things the wrapper carried that a bare channel does not. Options: (i) move them onto the channel (per-channel mute/weight), (ii) a lightweight optional **ChannelGroup** overlay node that is *not* in `scene.children` (a sidecar, like the camera channels), or (iii) defer solo/boneMask (single-layer use today rarely needs them — `AnimationLayer.ts:88-92` already notes cross-layer solo is unimplemented). **Recommend (i) for mute/weight, defer solo/boneMask** — confirm in Phase 0.

### 3.3 Channel attachment for deep param paths (glTF materials)

glTF transform channels scope to an asset via `nodeNameMap[childName] === target` (`bakedGltfChannels.ts:67`). Material channels are `Number`/`Color` (no `childName` today — `KeyframeChannelNumber.ts:37-55`). For materials we target the `GltfChild` dagId directly and use `paramPath = materials.<slot>.<lobe>.<field>`. The enumerator scopes by `target === childDagId` (already unique per child) — **no `childName` needed for the scalar/color channels**; the per-asset grouping is derivable from the child→asset map. Confirm the enumerator generalization in Phase 0.

> **Do NOT add `setAtPath` array-indexing** (V53 enforcement note): the un-animated SOURCE write already sidesteps array paths with a whole-`materials`-array replace (S4/S5). The animation APPLY side (`writeAt`, `AnimationLayer.ts:168-179`) *already indexes array paths* (`materials.0.base.color`), so once the evaluated value surfaces `materials`, the overlay works with no `setAtPath` change. A `setAtPath` array-index extension has no consumer and was rejected (speculative generality touching V42/V43/V8/V20).

### 3.4 Converged material editor

Once native and glTF materials both resolve through one overlay band, the inspector converges: **one OpenPBR material-row component** carrying `ParamDiamond` + autoKey (`ParamDiamond.tsx`, extracted in #190) serves both. The custom `GltfMaterialEditor` is replaced (or reduced to the glTF-only extras: the slot selector + the S5 Maps edit-layer rows). Per H104, the converged component must wire the diamond/autoKey itself (custom controls do not inherit generic `ParamRow` affordances) — the #190 slice-5 `CameraLensControls` fix is the template.

### 3.5 What stays unchanged (Chesterton)

- glTF children remain **non-producers** (the #88 / H45 / B12 double-render guard, `GltfChild.ts:7-14`). Three keeps owning imported geometry/skeleton/deform.
- The shared sampling primitives (`buildVec3Sampler`, `sampleScalarKeyframes`, `keyframeInterp.ts`) — one sampling source; do not fork.
- `writeAt` stays the one path-writer shared with `overlayTransients` (H40).
- `resolveEvaluatedTransform` / `resolveEvaluatedMesh` (B14) stay the read-side entry points; their internals change to read the unified resolver instead of unwrapping an AnimationLayer clone.

---

## 4. Migration (V4 — mandatory)

Every node carries `version` and migrates older projects (V4). Retiring `AnimationLayer` is a **breaking shape change** for any saved `.basher` that contains one.

- **Bundled examples:** none reference `AnimationLayer` (verified — `grep src/core/project` empty). So the runtime-shipped projects need no data fixup.
- **User `.basher` files + tests:** an `AnimationLayer` node must migrate to: (1) free-floating channels targeting the wrapped node's dagId (rewrite each channel's `target`), (2) `scene.children` un-wrapped (replace the layer ref with its `target` ref), (3) drop the layer node. This is a **graph migration**, not a single-node param migration — it likely lives at the project-load/migration runner, not in `AnimationLayer.migrations`.
- **Keep a read-path shim** for one release: load-time, detect `AnimationLayer` nodes and transform them, so old files open. Gate with `migrations.test.ts` (byte-identical render before/after for a layer-wrapped fixture).
- **Two-layer guard (V10/H14):** any newly-read field (e.g. a channel's `target` after rewrite) defaults safely at the evaluator AND every consumer.

---

## 5. Invariants — preserved & new

**Preserved:** V20 (one precedence rule — the resolver is the only "where it renders" authority), V32/V34/V53 (one IR, one substrate, producer builds it), V56 (camera resolver — becomes an *instance* of the universal resolver, not a special case), H40 (two callers — every band threaded into renderer AND read-side), H48 (no per-frame time subscription — resolvers sample at the caller's snapshot), H104 (converged custom controls wire their own diamond/autoKey).

**New (to add on implementation):**
- **V-unify (proposed):** *Every animatable node is driven by free-floating channels targeting its dagId, overlaid by one pure resolver consumed by both the renderer and the read-side. `AnimationLayer` is retired; there is no wrapper-based animation path.* — the structural invariant this refactor establishes.
- **H-absorb (proposed, if a regression surfaces):** the trap of leaving one caller on the old `sampleTarget`/wrapper path while the other moved to the resolver → displayed ≠ rendered (an H40 instance specific to the retirement).

---

## 6. Phasing (each slice: gate + observe + one atomic commit + push)

**Phase 0 — Surface map & plan lock (no code).** Map every producer/consumer/serializer/test of `AnimationLayer` (the research stopped earlier). Confirm: mute/solo/weight disposition (§3.2), the channel-by-target enumerator generalization (§3.3), the migration host (§4). File GitHub issues per slice. **Checkpoint with user.**

**Phase 1 — Lift the overlay resolver.** Extract `patchTarget` into a free `resolveEvaluated(base, channels, seconds)`; unit-test it against the current `AnimationLayer.sampleTarget` for parity. No behavior change yet (AnimationLayer still calls it internally). *Observe:* existing layer animation renders identically.

**Phase 2 — Native mesh onto the road.** ✅ ROAD DONE (`ux-overhall`, #197): `nodeChannels` enumerates channels by `target = mesh dagId` (layer-aware coexistence guard); `DirectChannelsR` (render) + `resolveEvaluatedTransform` (read) both overlay direct channels via `overlayChannels`. Verified by the p197 boundary-pair (rendered == resolver for a free-floating channel, no layer). **The authoring switch** (`dispatchFirstKeyComposite` native → direct first-key, mirror `dispatchCameraFirstKey`, no `addLayer`) is **deferred into Phase 5** — flipping it obsoletes the same layer-select machinery (p160/p162, `resolveEditTargetId` unwrap, #162) Phase 5 retires, so those ~10-15 e2e are rewritten once, not twice. Until then native authoring still mints layers (rendered by the untouched layer path).

**Phase 3 — glTF materials (#188) falls out.** `GltfChild.evaluate()` surfaces `materials`; `resolveGltfChildMaterials` (sibling of `resolveGltfChildTrs`) overlays material channels; renderer reads the resolved materials (replaces the `params.materials` read at `SceneFromDAG.tsx:1442`). *Observe:* inject a `materials.0.base.metalness` channel via `__basher_dag`; scrub; the clone's metalness ramps in viewport + render.

**Phase 4 — Converged material editor.** One OpenPBR material-row component with `ParamDiamond` + autoKey for native + glTF; glTF keeps slot selector + S5 Maps rows. *Observe:* click the roughness diamond on a Box AND on a glTF child — both create a free-floating channel; the dopesheet shows both rows.

**Phase 5 — Retire AnimationLayer + the authoring switch + migrate.** Flip `dispatchFirstKeyComposite`'s native branch to a direct first-key (mirror `dispatchCameraFirstKey`, generalized to all valueTypes incl. color), so new native authoring creates direct channels. Remove the wrapper from producers (`dispatchMutator`/`resolveEditTarget`/`autoKeyCommit`) + the now-vestigial layer-select machinery (p160/p162, the `#162` unwrap), add the load-time migration + shim, delete the node. *Observe:* open an old `.basher` with a layer → animates identically; new edits create no layer (a free-floating channel). NB: the ~10-15 layer-authoring e2e are rewritten HERE (the reason the authoring switch was folded in from Phase 2).

**Phase 6 — Catalogue + memory.** Promote V-unify, re-derive dharana boundaries (B14, B-material, the retired AnimationLayer/B8 surface), update session memory.

> Phases 1→2→3 are independently shippable and parity-preserving. Phase 5 is the only breaking one and is gated behind the migration. If scope must shrink, stopping after Phase 3 still ships #188 on the unified road with AnimationLayer coexisting.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Retiring AnimationLayer breaks an old saved project | Load-time migration + read-shim one release; `migrations.test.ts` byte-identical fixture (§4) |
| One caller left on the wrapper path → displayed ≠ rendered (H40) | Phase-1 parity unit test; per-phase side-A/side-B e2e equality (the V53/V56 pattern) |
| mute/solo/weight semantics lost in the move | Phase 0 decides disposition before any retirement; defer solo/boneMask explicitly, don't drop silently (log it) |
| Per-frame regression (re-enumerating channels by target each frame) | Build sampler closures once per DAG change, sample per-frame at the snapshot (the `bakedChannelSamplersForAsset` pattern, H48) |
| Big-bang temptation | Strict slicing; AnimationLayer coexists until Phase 5; each phase gated + observed + atomic |
| `setAtPath` array-index rabbit hole | Explicitly out of scope (§3.3) — `writeAt` already indexes arrays; no consumer for the extension |

---

## 8. Test strategy

- **Unit:** resolver parity (Phase 1 vs `sampleTarget`); channel-by-target enumeration; material overlay; migration byte-identity.
- **e2e (one spec at a time, list reporter; :5180 cold-HMR flake → trust clean isolation re-run):** per phase, drive REAL interactions — inject channels via `__basher_dag`, assert the EVALUATED render (the V56 method); side-A/side-B parity (viewport == still == animation render).
- **Regression surface:** all current AnimationLayer tests (Phase 0 enumerates them), the camera (V56) + glTF transform (P7.12) suites, ux12/p165/p7.
- **Known pre-existing reds (confirm by stashing, not ours):** acceptance #4/#7/#8/#10, p163, p6-w5-first-run, p7.12(e), TimelineCanvas exhaustive-deps.

---

## 9. Open questions (resolve in Phase 0)

1. **mute / solo / weight / boneMask** — onto the channel, a sidecar ChannelGroup, or deferred? (§3.2)
2. **One generic resolver vs per-kind** — collapse `resolveActiveCameraPoseAt` + `resolveGltfChildTrs` + the new mesh/material resolvers into one `resolveEvaluated(base, channels, seconds)`, or keep thin per-kind wrappers over a shared core? (Lean: shared core, thin per-kind base-source adapters.)
3. **Migration host** — project-load runner vs a dedicated graph-migration pass; how to represent the channel-`target` rewrite atomically.
4. **GltfMaterialEditor** — full replacement vs reduce-to-glTF-extras (slot selector + Maps) wrapping the shared material-row.
5. **Channel scoping for deep paths** — confirm the per-target enumerator covers `materials.<slot>.<lobe>.<field>` without `childName` (§3.3).

---

## 10. Catalogue impact (on implementation)

- **vyapti:** add **V-unify** (the universal-channel invariant); amend **V56** (camera resolver → an instance, not a special case); amend **V53** (material now flows through the unified resolved band on both native + glTF).
- **hetvabhasa:** **H40** gains the retirement instance; possibly **H-absorb** if a half-migrated caller regresses.
- **dharana:** re-derive **B14** (evaluated-mesh boundary — now resolver-fed), **B-material** (OpenPBR IR ↔ THREE adapter — converged editor), and retire/rewrite the **B8 / AnimationLayer-as-Mutator-surface** boundary (the wrapper it described is gone).

---

## 11. Phase 0 — Surface map & locked decisions (completed)

Mapped on `ux-overhall` tip `94579ed`. The full `AnimationLayer` surface (37 non-test refs):

**Producers (create / wrap a target):**
- `src/agent/mutators/builders/addLayer.ts` — the ONLY layer creator. Per target: `addNode AnimationLayer`; for every consumer of target, `disconnect(target→C)` + `connect(layer→C)`; `connect(target→layer.target)` (`addLayer.ts:88-123`). **The migration reverses exactly this.**
- `src/agent/mutators/builders/addChannel.ts` — wires a channel into a layer's `animation` socket (`requiredNodeTypes:['AnimationLayer']`).
- `src/app/animate/dispatchMutator.ts` — autoKey first-key composite (`:562` iterates layers); camera branch (`:484,:543`) already bypasses the layer.
- `src/app/animate/autoKeyCommit.ts` (`:69,:197`), `src/app/animate/resolveEditTarget.ts` (`:24` — edits retarget to the wrapped node).

**Consumers (read):**
- `src/viewport/SceneFromDAG.tsx` — `AnimationLayerR` (`:695`), render case (`:570-575`), single-hop target-id resolve (`:579`), transient keying (`:207-264`), never-select-wrapper unwrap (`:626`).
- `src/app/resolveEvaluatedTransform.ts` — unwraps the patched clone (`:133,:238-264`); + `resolveEvaluatedMesh.ts`, `resolveEvaluatedParam.ts`, `resolveTransformParam.ts`.
- `src/app/Gizmo.tsx` (`:28,:132-197`), `src/timeline/TimelineCanvas.tsx` `collectChannelRows` (`:188,:216` — flattens layers + orphan channels), `src/app/timeline/LayerRowControls.tsx` (mute/solo row toggles), `src/app/NPanel.tsx` (`:449` mute/solo).
- `src/app/overlayTransients.ts` — imports the shared `writeAt` (`:24`).
- Agent: `src/agent/strategy/catalog.ts` (`:242-325` "wrap with AnimationLayer" guidance — rewrite), `addChannel`/`bakeGltfChannel`/`removeKeyframes`/`retarget` builders.

**Type / registration:** `types.ts:763` (in `SceneChild` union), `types.ts:869` (`AnimationLayerValue`), `core/dag/types.ts:75` (`'AnimationLayer'` socket name), `registerAll.ts:8,100`.

**Test regression surface:** unit — `nodes.test.ts`, `resolveEvaluatedTransform.test.ts`, `resolveTransformParam.test.ts`, `dispatchMutator.test.ts`, `mutators.test.ts`, `expand.test.ts`, `inspectorSectionsRegistry.test.ts`, `TimelineCanvas.test.tsx`. e2e — `p06-2-material-anim`, `p149-*` (×4), `p153-animated-primitive-boundary-pair`, `p160-gizmo-layer-select`, `p162-layer-select-unwrap`, `p190-camera-animation`, `p7-animation-authoring`, `p7-w-c2-diamond`, `p7.1`, `p7.3`, `p7.4`, `p3-acceptance`, `p3-observe`, `p6-w5/w6/w9`, `gizmo-autokey-record`.

### Key finding — the layer's "layer-shaped" semantics are largely inert

`AnimationLayer.evaluate` (`AnimationLayer.ts:88-115`) gates only on `mute`. `solo`, `boneMask`, and cross-layer resolution are carried in the value but **never filter channels** — the code itself defers them to "a future SceneAnimation aggregator that knows about all layers" (`:88-92`). `boneGroupPresets.ts` is editor sugar for a `boneMask` nothing reads. `weight` blends number/vec3 (`blend()`), but quat/color snap at 0.5 (partial weight deferred). **So in practice AnimationLayer is a re-parenting wrapper that carries `mute` + (number/vec3) `weight`.** Retiring it loses no functional behaviour beyond those two — both cleanly relocatable to the channel.

### Locked decisions (the 5 open questions)

1. **mute / solo / weight / boneMask** → `mute` and `weight` move **onto the channel** (`KeyframeChannel*` params, defaults `mute:false`, `weight:1` — byte-identical when defaulted). `solo` + `boneMask` were inert → **dropped from the node, explicitly logged** as "was never wired; reintroduce as per-channel solo / a ChannelGroup if a real need appears." No silent loss.
2. **Generic vs per-kind resolver** → **shared core + thin adapters.** `overlayChannels(base, channels, seconds)` = `patchTarget` lifted (clone + `writeAt(paramPath, blend(sample))`). `resolveActiveCameraPoseAt`, `resolveGltfChildTrs`, and the new mesh/material resolvers become thin wrappers supplying their base + their target-scoped channel set.
3. **Migration host** → a load-time graph pass `migrateAnimationLayers(state)` in the project migration runner (NOT `AnimationLayer.migrations`, which is single-node). Reverses `addLayer`'s rewire: re-point each `layer→consumer` edge to `target→consumer`, re-target each wired channel to the wrapped node's dagId, delete the layer. Gated by a byte-identical-render fixture in `migrations.test.ts`.
4. **GltfMaterialEditor** → **reduce-to-extras**, not full replacement. Extract a shared `MaterialRows` (OpenPBR lobe rows + `ParamDiamond` + autoKey); the native ParamRow material section AND `GltfMaterialEditor` both render it; `GltfMaterialEditor` keeps only the slot selector + S5 Maps rows around it. Lower rewrite risk (S4/S5/a11y stay put).
5. **Deep-path channel scoping** → material channels target the `GltfChild` dagId directly, `paramPath = materials.<slot>.<lobe>.<field>`; enumerator scopes by `target === childDagId` (unique per child — no `childName` needed). `writeAt` already indexes the array path; no `setAtPath` change.

### New scoping boundary (surfaced in Phase 0)

`addLayer` can wrap a `Character` (skeletal) target, but since `boneMask`/`solo` are inert there is **no functional skeletal-layer behaviour to preserve**. The first pass therefore targets param animation on mesh/material/transform/camera/light uniformly; if a real skeletal bone-mask layering need appears later it returns as a per-channel `solo`/`ChannelGroup` feature, not a blocker for retirement.

### GitHub issues (filed Phase 0)

See the epic + per-phase issues linked at the top of the tracker. #188 is reused as the Phase-3 issue (glTF material animation falls out of the unified band).
