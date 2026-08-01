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

### S1 — `MaterialRef`, minted by the evaluator — PROPOSED

`material: MaterialRef | null`, where `MaterialRef = { key, spec }`, mirroring
`GeometryRef`. The key is minted **after the full fold** (param → socket → operator
stack), because the fold is what decides identity.

Premises to measure first:

- ⚠️ **UNMEASURED** — how many places produce `MeshDataValue.material`. More than one
  means minting is N-spelled, which is the drift this repo has already paid for. Measure
  by **searching for the constructor across every tier**; the sweep that stopped at the
  unit tier last session let a broken e2e fixture ride into CI.
- ⚠️ **UNMEASURED** — whether any save / export / bundle path serializes an evaluated
  value. If it does, this is a format migration, not a type change.
- ⚠️ **UNMEASURED** — per-evaluation hashing cost. `GeometryRef` is precedent, which is
  encouragement, not evidence.

**Gate:** two objects linked to one Material node evaluate to the **same `ref.key`**;
adding an override to one changes only that one's key. Unit tier — moving this claim
below the browser is most of the point.

### S2 — the registry keys on `ref.key` — PROPOSED

Deletes the generic key walk and the "spec is the builder's only input" scaffolding from
#530. That machinery exists only because identity was being rediscovered downstream; with
the ref, the cause is gone rather than the symptom.

The registry becomes `resolve(ref, globalShading) → GPU material`, still refcounted
because it owns per-material texture clones.

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

### S5 — the artist half: make authored sharing breakable — PROPOSED

The Material link row shows a user count. In Blender that number _is_ the affordance that
gives this object its own copy.

⚠️ **UNMEASURED** — whether clicking ours does anything today. Measure before scoping; it
may be nothing, a one-liner, or a real slice.

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

**S0 → S1 (measure first) → S2 → S3 → S4**, with S5 / S6 / S7 folded in where cheapest.

Every ⚠️ above is the shape that produced four wrong gates in #394: a plan sentence that
argues, read later as a sentence that describes. Measure each before building the slice
that rests on it.

---

**REF:** issues #530, #532, #533, #535; PR #534; `src/app/geometryRegistry.ts`,
`src/app/materialRegistry.ts`, `src/viewport/SceneFromDAG.tsx`, `src/nodes/types.ts`;
`docs/PERFORMANCE.md` Lever 5; `ref/houdini/SOP.md`.
