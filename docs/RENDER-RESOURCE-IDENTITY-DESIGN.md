# Render Resource Identity & Ownership

How two objects come to draw the same thing, and what stops that from leaking.

## Reading convention

Four of the planned gates in #394 were wrong because a sentence arguing what _should_
hold was quoted one slice later as a description of what _does_. Aspiration and
description are written in the same present tense, so this document marks them:

- **MEASURED** — observed, with the observation named. Trust it, and re-measure if the
  code has moved since.
- **PROPOSED** — a design intention. Nothing implements it yet.
- **⚠️ UNMEASURED** — a premise this plan rests on that nobody has checked. **Measure it
  before implementing the slice that depends on it.** A disproof is itself a finding —
  that is how #530 got split out of #394 in the first place.

**Update 2026-08-01 — S0 merged, S1 built, and the convention earned its keep.** All four of
S1's premises were measured before building: S5 turned out to be mostly built already, and
S2's key substitution turned out not to be clean. Then S1's own headline — `MaterialRef`,
"mirroring `GeometryRef`" — was measured wrong DURING the build and replaced with a sibling
key; the argument is kept in §5 rather than edited away, because the analogy that produced
it is the reusable mistake. The memo question is closed too (measured: no memo).

Two ⚠️ remain, both untouched by this round: §3 (Houdini at source tier) and S3 (whether a
syntactic sweep survives refactors).

Keep this honest as the document is edited. The whole reason for the convention is that a
sentence arguing what _should_ hold reads, one slice later, exactly like a sentence
describing what _does_ — and "mirroring `GeometryRef`" is now the clearest example in the
file, because the mirror was true about the shape and false about the constraint.

---

## 1. The problem

Two bugs, one cause, opposite directions.

**#533 — things you never connected moved together.** Two boxes authored at the same
size share one `BufferGeometry` (the geometry registry is content-keyed, by design).
Resizing one left _that_ box unchanged and resized _the other_.
**MEASURED** on `main` (`5a8fb15`) via a scene walk reading each mesh's geometry uuid and
real vertex extent, and reproduced on a clean worktree to confirm it predated the
material work.

**#530's regression — things you did connect stopped moving together.** With materials
shared, editing a Material node linked to several objects repainted one and left the
others frozen on the pre-edit instance.
**MEASURED** in a browser: the frozen mesh was holding the old material object, not a
stale colour on the new one.

Both came from `<primitive>`, which takes _ownership_ of the object it is handed — it
stamps reconciler bookkeeping onto the object itself. Fine while every mesh has its own
resource; wrong the moment two meshes are handed one, because the second attach
overwrites the first's and a later swap lands on the wrong owner.

### From the artist's side

> **Things I never connected must never move together.
> Things I did connect must always move together.**

One promise, two directions. An artist's confidence in a tool is just _can I predict what
my edit will do_ — and every invisible coupling is a permanent tax on it. Someone who
once resized a cube and watched a different cube move doesn't file a bug; they quietly
stop trusting the viewport and check everything twice, forever.

It is sharper for an agent, which cannot glance at the viewport to notice something moved
that shouldn't have. It has to be able to reason "I changed this object, so only this
object changed." If that isn't true, nothing built on top of it is reliable.

---

## 2. Two kinds of sharing, two contracts

|               | authored                            | derived                  |
| ------------- | ----------------------------------- | ------------------------ |
| example       | a Material node linked to N objects | registry content dedup   |
| who decided   | the director                        | a content key            |
| visible?      | yes — the link-users row            | no, and it must never be |
| breakable?    | yes, by the director                | no                       |
| **a leak is** | **the feature**                     | **a bug**                |

This is the distinction the two bugs blurred. A derived share behaving like an authored
one _is_ #533.

Rule, stated for the artist:

> **If you can see it, you can break it. If you can't break it, you must not be able to
> see it.**

---

## 3. Grounding

### Blender — MEASURED live (5.1.1, via MCP, scene restored afterwards)

**The authored layer is explicit, counted, breakable.** Two objects on one mesh
datablock: `users == 2`, `a.data is b.data`. Editing the shared mesh moves **both** — the
leak is the feature. "Make single user" (`.copy()`) drops users 2→1 and the two diverge
from then on. The user count _is_ the button that breaks the link.

**The evaluated layer is a separate address space.** With an Array modifier on one
sharer: original **4** verts, `A_eval` **12**, `B_eval` **4**, `users` still 2. All three
are distinct meshes, and the evaluated mesh **is not in `bpy.data.meshes` at all**.
Writing to an evaluated mesh is _allowed_ and cannot reach the authored datablock.

**Materials are shared across consumers exactly like our registry.** One material on two
meshes, three objects: `A_eval_mat is B_eval_mat is C_eval_mat` → **True**, including
across different meshes; not the authored datablock; not in `bpy.data.materials`. Blender
makes per-object evaluated _meshes_ (the modifier stack is per-object) but **one** shared
evaluated material.

**And that shared evaluated material has #533's hazard.** Writing to it was **allowed**,
an unrelated object on a different mesh **saw the change**, and the authored datablock
stayed clean. Blender has **no access control in the evaluated layer**.

**How it avoids the bug.** Setting a slot's `link = 'OBJECT'` and pointing it at an
override material: the other object still resolves the original, and the mesh datablock
is untouched. Divergence is a **re-point**, never a write.

### Houdini — docs tier only

From `ref/houdini/SOP.md`, citing sidefx docs: a **packed primitive** stores "a
lightweight reference to geometry plus a single transform, NOT a duplicate… Copying a
packed prim copies the _reference_, not the data. **Packed primitives cannot be edited.**"
To change one you unpack, which materialises your own copy.

⚠️ **UNMEASURED / ungrounded at source tier.** No Houdini source is downloaded, and the
HDK's `GU_DetailHandle` read/write lock discipline — the part closest to this design — is
not covered by any reference doc we hold.

### What they give us

Blender supplies the **principle** (divergence is a re-point; never write to shared).
Houdini supplies the **enforcement** (the shared form cannot be edited).

**We need both, and the reason is specific:** Blender's evaluated layer is rebuilt by the
depsgraph, so a stray write is thrown away. Ours is **persistent and refcounted** — a
stray write is permanent and inherited by every future consumer that keys the same. Our
registry is _more_ dangerous than Blender's evaluated layer, which is why we cannot rely
on Blender's discipline alone.

---

## 4. The invariant

> **Identity is minted by graph evaluation. Ownership lives at one resolver seam.
> Per-consumer divergence is a re-point, never a write to a shared thing.**

Note that immutability is not the principle — it is one way to enforce it. Blender does
not enforce it at all; it simply never writes.

### Where we already half-do this

```ts
export interface MeshDataValue {
  readonly geometry: GeometryRef; // ← a handle: { key, kind, descriptor }
  readonly material: InlineMaterialSpec | null; // ← the whole IR, inline
}
```

Two lines apart. Geometry got the packed-prim treatment; material never did.
`GeometryRef` is already a deterministic content key minted by evaluation and resolved by
the renderer. **MEASURED consequence:** the material registry shipped in #530 is a
renderer-side reimplementation of identity the evaluator should be handing down.

### And why the handle alone is not enough

`GeometryRef` has worked this way all along and **#533 still happened.** Two objects
correctly resolved to one shared geometry via the graph, and the renderer still traded
them between meshes. Identity and ownership are different problems: evaluation can say
_these two are the same thing_; it cannot stop a consumer writing to it afterwards.

---

## 5. Slices

### S0 — land the in-flight fixes (PR #534)

Fixes #530 and #533. Changes no architecture. Nothing below depends on it merging; S1 can
start from the branch.

### S1 — identity minted by the evaluator — ✅ BUILT 2026-08-01 (`cb89909`), and NOT as planned

**Shipped:** `materialKey: string | null` as a SIBLING of `material`, minted after the full
fold (param → socket → operator stack), because the fold is what decides identity.

🔴 **The planned shape — `material: MaterialRef | null` where `MaterialRef = { key, spec }`,
mirroring `GeometryRef` — was built first and MEASURED WRONG.** It is recorded here rather
than quietly replaced, because the reason generalises.

**What broke.** The animation overlay addresses an evaluated value by a path that MIRRORS
the param path (`channelPathForBand`). Wrapping the IR in a handle inserts a `.spec` hop
that the param path does not have, so a channel authored on `material.base.color` lands at
`data.material.base.color` while the renderer reads `data.material.spec.base.color`: the
colour animates in the inspector and **freezes on screen**, with typecheck and the whole
unit suite green. The conformance matrix's overlay road caught it — the road exists for
exactly this failure, previously seen on the lights band.

**And the obvious repair failed too.** Adding the hop inside `channelPathForBand` fixed box
and sphere and immediately broke `BakedData`: that rule keys on the **band**, while the
handle is per-**kind** — `MeshData` would carry one, `BakedData` and `ModifiedData` would
still hold bare specs. One band would no longer have one shape.

🔑 **Why `GeometryRef` gets away with it and material cannot.** Nothing reads a `size` off
the evaluated value; geometry is a recipe the registry rebuilds. Material is read AND
animated leaf by leaf. Same-looking problem, genuinely different constraint — so "mirror
`GeometryRef`" was the wrong instinct, and the mirror is the part of the original plan that
did not survive contact. (That geometry ALSO has no working overlay path for `size` is a
separate, pre-existing, now-OBSERVED defect → **#537**.)

**What it cost, measured both ways:** the handle needed ~40 edits across 17 files and still
broke the overlay road; the sibling key touched **3 files with zero test changes**. The
invariant's first clause — identity minted by evaluation, never rediscovered downstream —
is satisfied either way. Only the carrier changed.

**One correction the gate forced on its own author:** the first key walked `name` too, which
would have separated two identical-LOOKING materials by their labels — a silently lost
dedup that S2 would have inherited, since the registry's compiled spec has no `name` at all.
`name` is now excluded, pinned in both directions.

**Gate:** `src/nodes/materialKey.test.ts`, 8 tests, falsified three ways (mint before the
fold → only the 3 fold-dependent tests red; a constant key → 5, including every
"not a constant" pairing; keying on `name` → exactly the 2 name tests). Unit tier, which was
most of the point: sharing previously had exactly one witness, a `THREE.Material` uuid read
off a live scene.

Premises, all four measured 2026-08-01 before writing any of this slice:

- **MEASURED — one mint seam, but it feeds two value kinds.** `MeshDataValue` has exactly
  two constructors (`BoxData.ts:58`, `SphereData.ts:66`) and both mint through the single
  `resolveNodeMaterial` seam, so minting a ref is one edit, not N. The catch is that the
  same seam has a **third** caller, `SetMaterialOp.ts:94`, which emits `ModifiedData` —
  so changing its return type lands on two members of the union at once. Two further
  producers carry a material without going through it at all: `BakedData.ts:84`
  (`params.material` straight through) and `MaterialOverrideOp.ts:110` (a three-way
  compose over the upstream base). Those two need an explicit answer in this slice rather
  than being absorbed by `ModifiedDataValue.material`'s `Inline | Baked | null` union.
  🔑 **And the sweep method mattered:** searching the type name `MeshDataValue` finds only
  the two primitives — `SetMaterialOp` never spells `kind: 'MeshData'`, so it is invisible
  to a type-name sweep and appears only when you search for the constructor and for
  `resolveNodeMaterial` itself. Same shape as the miss recorded in the catalogue.
- **MEASURED — no migration.** Nothing serializes an evaluated value. The persisted node
  is `{ id, type, version, params, spare?, inputs, meta? }` (`src/core/dag/types.ts`
  `NodeSchema`) and `state.outputs` is `Record<string, NodeRef>` — socket references, not
  values. The material IR is persisted as a **param** (`openpbrMaterialSchema()`), and the
  agent's only material read (`identify.ts:590`) is against params too. So long as the
  param schema is untouched and the ref is minted at evaluate time, this is a type change.
- **MEASURED, and the precedent is weaker than it looked.** `boxGeometryRef` hashes
  nothing — it string-templates three scalars (`box|x,y,z`), so it is no evidence at all
  about the cost of keying a full OpenPBR IR. Worse, the evaluator's existing params-hash
  memo is a `WeakMap` keyed on **params object identity** (exact only because `ops.ts`
  structurally shares unchanged params), and `resolveNodeMaterial` hydrates a **fresh** IR
  on every evaluation — so that memo would never hit for a material ref. The encouraging
  half: `materialRegistry.keyOf` already walks the whole spec on every acquire, so most of
  this cost is a **move** rather than a new charge. ⚠️ **STILL OPEN:** a material ref needs
  its own memo strategy; neither precedent supplies one.

**Gate:** two objects linked to one Material node evaluate to the **same `ref.key`**;
adding an override to one changes only that one's key. Unit tier — moving this claim
below the browser is most of the point.

### S2 — the registry keys on the evaluator's key — PROPOSED

Deletes the generic key walk and the "spec is the builder's only input" scaffolding from
#530. That machinery exists only because identity was being rediscovered downstream; with
the ref, the cause is gone rather than the symptom.

The registry becomes `resolve(materialKey, spec, globalShading) → GPU material`, still
refcounted because it owns per-material texture clones. (S1 shipped a sibling `materialKey`
rather than a `{key, spec}` handle — see above — so the key arrives beside the spec rather
than wrapping it. Nothing else about this slice changes.)

🔴 **MEASURED 2026-08-01 — keying the registry on the evaluator's key is NOT a clean substitution, and the reason
is deliberate.** `keyOf` is taken over the **resolved** `PrimitiveMaterialSpec`, in which
each texture slot is an actual `THREE.Texture` reduced to `tex:<uuid>`. Resolution happens
_above_ the registry, in the suspense hooks, and the module says why: keying on the
instance means "a slot that is still loading and one that has loaded are distinct
materials rather than the same one at two moments." A `ref.key` minted at evaluation holds
map _refs_, not resolved textures, so it cannot express that distinction. ⇒ the registry
key must be `materialKey` **plus** the resolved-texture / global-shading contribution; dropping
the second half would collapse loading and loaded into one entry. Scope S2 accordingly.

**Gate:** the four `p530-material-instance-sharing` tests pass **unchanged** — they assert
product behaviour, not mechanism, so they are the regression proof.

### S3 — the single ownership seam — PROPOSED

One module turns a handle into an attached GPU object; the unwrap is not exported past
it. Covers **both** registries.

Collapse the _attachment_, not the three renderer components — they have genuinely
different lifecycles (suspense, error banner, Empty) and merging them is the wrong
boundary.

⚠️ **UNMEASURED** whether a syntactic sweep can survive refactors here. Assume it cannot
— a gate keyed to an expression's shape reports a clean sweep forever once the expression
moves. Rely on S4.

### S4 — the locality gate (#535) — PROPOSED

Two disjoint subgraphs → snapshot every mesh → perturb one → assert nothing outside it
moved, **and** that the perturbed one did.

Both halves, because the defect **swaps** the readings — either assertion alone is
satisfied by it. **MEASURED** on #533 by suppressing each in turn and watching the other
fail on its own.

This is the backstop for mechanisms that never route through the registries at all
(instancing, batching).

### S5 — the artist half: make authored sharing breakable — MOSTLY ALREADY BUILT

The Material link row shows a user count. In Blender that number _is_ the affordance that
gives this object its own copy.

**MEASURED 2026-08-01 in a browser** (two separate tests, so neither could mask the other):

- **The count is inert.** `material-link-users` is a bare `<span>` with no handler
  anywhere in its subtree; clicking it leaves node count, users text and material uuid
  untouched — measured in a world where the fixture genuinely shared, so a make-single-user
  _would_ have had something to do.
- **🔑 "New Material" already IS make-single-user.** `buildNewMaterialOps` seeds the new
  node from the currently-linked material ("seed from what is on screen NOW"), disconnects
  this consumer and links it to the copy. Observed on three linked cubes: the colour is
  preserved rather than reset to a default, the other two stay linked, users goes 3 → 1 on
  the copy and 2 on the original, and **editing the original afterwards moves only the two
  that stayed linked**. That last perturbation is the discriminator — appearance cannot
  tell a copy from a link, and neither can the uuid (see below).

⇒ **S5 shrinks from "build make-single-user" to "make the number the affordance"** —
the semantics exist and are correct; what is missing is that the count is not the button,
and the button that does the work is labelled "New Material".

🔑 **AND ONE THING THE SAME RUN SETTLED, which S1/S2 must not conflate.** After the split,
the copy still resolves to the **same `THREE.Material` instance** as the original, because
the registry is content-keyed and a value-seeded copy is content-identical. That is
correct, not a leak: the **authored** share was broken while the **derived** one survived,
which is §2's table observed live. Graph identity (which Material _node_) and render
identity (which GPU material) are separate layers. A gate that asserts make-single-user by
reading a uuid would therefore fail against the right behaviour — a gate that passes the
broken build and fails the correct one, avoided here only because the premise was measured
before the gate was written.

### S6 — #532 folds in — PROPOSED

Once the spec is the ref's payload, applying `doubleSided` / `alphaTest` / `vertexColors`
on the native road is one place. Cheapest after S1, not before.

### S7 — catalogues and Ground Truth

- The invariant in §4.
- The error pattern: a shared object handed to an ownership-taking attach mechanism —
  three sightings of one rule (#530's freeze, #533's swap, and the pre-existing texture
  clone comment, which stated the rule correctly in one place and never generalised it).
- The Blender measurements in §3 — the ownership boundary is currently ungrounded for
  both reference systems.

---

## 6. Deliberately not doing

- **Collapsing the three renderer components.** Different lifecycles; wrong boundary.
- **Making the registry permanent.** It owns texture clones; unbounded growth over an
  edit session is the cost.
- **Touching the glTF road.** It has its own material ownership and is unaffected.
- **Grounding Houdini from source**, unless the HDK handle discipline turns out to decide
  something.

---

## 7. Sequencing

**S0 ✅ → S1 ✅ → S2 → S3 → S4**, with S5 / S6 / S7 folded in where cheapest.

S0 merged (`main` == `e6aaf52`, canary green as the combination). S1 built, and its plan
sentence — "mirroring `GeometryRef`" — is the fifth instance of the failure this document's
reading convention exists for: an analogy that argued a design was quoted as though it
described a constraint. Measuring it cost one build and saved the slice.

Every ⚠️ above is the shape that produced four wrong gates in #394: a plan sentence that
argues, read later as a sentence that describes. Measure each before building the slice
that rests on it.

---

**REF:** issues #530, #532, #533, #535; PR #534; `src/app/geometryRegistry.ts`,
`src/app/materialRegistry.ts`, `src/viewport/SceneFromDAG.tsx`, `src/nodes/types.ts`;
`docs/PERFORMANCE.md` Lever 5; `ref/houdini/SOP.md`.
