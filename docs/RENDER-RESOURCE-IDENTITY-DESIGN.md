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

**Update 2026-08-01 — S0 merged, S1 and S2 built, and the convention earned its keep twice.**
All four of S1's premises were measured before building: S5 turned out to be mostly built
already, and S2's key substitution turned out not to be clean. Then S1's own headline —
`MaterialRef`, "mirroring `GeometryRef`" — was measured wrong DURING the build and replaced
with a sibling key; the argument is kept in §5 rather than edited away, because the analogy
that produced it is the reusable mistake. The memo question is closed too (measured: no memo).

**S2 then failed the same way in a new place, and the lesson is one level up.** Its key
substitution was already flagged here as not clean (textures); building it found **two more**
contributions the evaluator cannot see, one of which would have reopened #530's repaint bug.
Worse, the gate this document cited as S2's safety net — "the four `p530` tests pass
unchanged" — exercises a different override road and would have stayed green through it.
⇒ **a plan citing an existing gate must re-read what that gate's FIXTURE BUILDS, not what its
name suggests.** This is the same failure as the `GeometryRef` analogy wearing different
clothes: a claim about a neighbour taken as a claim about this case.

One ⚠️ remains untouched by these rounds: §3 (Houdini at source tier). S3's — whether a
syntactic sweep survives refactors — is now MEASURED, and the answer sharpened it: an
import-clause sweep is complete only over a subject that cannot be imported as a namespace,
so the gate refuses that form as its precondition. One new gap is now declared in S2: `ModifiedData` still
carries no minted key, so half the registry's traffic re-derives identity at render.

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

### How far this reaches today — 1 of 6 kinds (#542)

The invariant above is stated over the whole `ObjectData` union. It is **enforced on one
member of it.** `materialKey` exists on `MeshDataValue` and nowhere else, minted at exactly
two producers (`BoxData`, `SphereData`), while two other kinds carry a material with no key
at all. Read the invariant on its own and you would reasonably conclude that every evaluated
material carries identity; it does not, and this is where that is written down.

| kind                   | carries a material | carries a minted key | what keeps it non-divergent                                                                       |
| ---------------------- | ------------------ | -------------------- | ------------------------------------------------------------------------------------------------- |
| `MeshData`             | yes                | **yes**              | the key itself — the registry-backed primitive road                                               |
| `BakedData`            | yes                | no                   | **does not share.** A per-component `useMemo`, disposed at the site (`SceneFromDAG` `BakedMeshR`) |
| `ModifiedData`         | yes                | no                   | **shares, and re-derives.** See below — this is the interesting one                               |
| curve / light / camera | no                 | n/a                  | nothing to key. Not missing                                                                       |

The glTF road is not a kind at all (a `GltfChild` is still fused) and belongs in the same
census: it writes onto **per-clone** `THREE.Material` instances and never touches the
registry, so it is `BakedData`'s answer — safe by not sharing.

**`ModifiedData` is the one whose safety argument is easy to state wrongly.** It is not safe
by not sharing: `ModifiedMeshR` calls the same `usePrimitiveMaterial` seam the keyed road
calls, so a modifier's material goes into the same content-keyed `materialRegistry` and two
arrayed cubes with equal materials genuinely draw one instance. It carries no minted key, so
the renderer falls back to `materialKeyOf(ir)` — **the same function the evaluator calls, over
the same IR.** That is what keeps the two roads agreeing, and it is why a keyed and an unkeyed
object with equal materials correctly land on one instance rather than two. One function, one
answer; a fallback, never a second spelling of identity.

So the honest reading of the invariant's first clause is narrower than its wording: identity
is minted by evaluation **on the registry-backed primitive road**, and rediscovered downstream
— through the evaluator's own function — everywhere else that shares.

**What would break it, and therefore what to check.** If `ModifiedData` (or any pass-through
producer) ever mints its own key, that key immediately joins the S3 ownership rule: a writer
that patches an evaluated value owns the identity on it, and `overlayWithIdentity` would have
to clear it for that band too. Until then the fallback is immune to staleness by construction,
because it is computed from the content it is handed. Widening the mint is #542's stronger
half and is deliberately still open: `SetMaterialOp`/`MaterialOverrideOp` mint a material while
`ArrayModifier`/`MirrorModifier` pass one through, and "pass through" has to decide whether it
inherits the source's identity or gets its own. That is a design question, not a blank to fill.

The three counts in this section — two minting producers, one keyed kind of six, one downstream
re-derivation — are machine-checked by `src/nodes/materialKeyReach.gate.test.ts`, so this
paragraph cannot quietly become fiction.

### And why the handle alone is not enough

`GeometryRef` has worked this way all along and **#533 still happened.** Two objects
correctly resolved to one shared geometry via the graph, and the renderer still traded
them between meshes. Identity and ownership are different problems: evaluation can say
_these two are the same thing_; it cannot stop a consumer writing to it afterwards.

### The property all of it exists to protect — RENDER LOCALITY (#535)

> **What a node draws is a function of its own subgraph. Two objects whose subgraphs are
> disjoint cannot affect each other, so an edit is local to the subgraph it lands in.**

The invariant above is a mechanism; this is the thing the mechanism is for, and it is worth
naming separately because it is what a director actually notices. #533 and #530 were not
rendering bugs — they were locality violations, and they are the reason a shared instance is
worth any of this ceremony at all.

Locality is not enforced anywhere. It **holds** (MEASURED, 2026-08-03), because five separate
places each independently remembered to clone before mutating: the registry's `array` and
`mirror` roads, Apply-Transform's bake, the decoded-texture clone taken before a UV transform,
and attachment passing shared resources as props rather than handing them to `<primitive>`.
That is one rule with five spellings, and the sixth site is the one that forgets.

**Why no static gate closes this.** The structural censuses beside the registries answer two
questions — who IMPORTS a registry, and who WRITES through a known call — and both are keyed
to something the violating consumer need not have. The consumer that produces this bug is
merely _holding_ an instance it took off the scene graph: it imports nothing and writes
through whatever call it likes. There is no static key for "who is holding the resource", so
the backstop is behavioural: `tests/e2e/p535-render-locality.spec.ts` perturbs one subgraph
five ways and compares every other mesh the renderer drew.

**Both halves, every time.** "Nothing else changed" alone is satisfied by a build where the
edit does nothing — a freeze, which that gate would then certify as healthy. "The edited one
changed" alone is satisfied by a build where everything changed. The defect **swaps** the two
readings. **MEASURED** by breaking each direction in turn: re-adopting geometry through
`<primitive>` reddens both halves independently, while freezing the size reddens only the
first and leaves the second perfectly true.

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

### S2 — the registry keys on the evaluator's key — ✅ BUILT 2026-08-01 (`b2019f5`, `1540bc9`), and the plan was wrong three ways

**Shipped:** the registry key is
`materialKey ⊕ override ⊕ shading ⊕ resolvedTextures`, composed in one pure module
(`src/app/material/primitiveMaterialInputs.ts`) that also assembles the spec. The
derivation moved out of `usePrimitiveMaterial`, which is what gives it a tier below the
browser at all.

🔴 **This slice was planned as a SUBSTITUTION — "key on `materialKey`, delete the spec
walk" — and it is not one.** The rendered material depends on three inputs the evaluator
never sees. One was already recorded here before building; the other two were found by
measuring:

1. **The scene-band `MaterialOverride`.** `MaterialOverrideR` pushes it down the render
   TREE as an inherited prop, and it is composed at render time — so it is not in the
   evaluated value at all. **This is the dangerous one:** keyed on `materialKey` alone,
   two objects with one base material under different override wrappers collide onto ONE
   instance and repaint an object nobody overrode. That is #530's regression class,
   reopened by the slice meant to strengthen it.
2. **The global shading mode.** `wireframe` comes from the viewport store, not the graph.
3. **The resolved textures.** The IR carries map refs; the suspense hooks resolve them,
   and keying on the instance is deliberate so a loading slot and a loaded one stay
   distinct materials rather than one material at two moments.

So the win is not deleting the downstream hash. It is that the **evaluated half stops
being re-derived by the renderer**, and the three render-time contributions become named
inputs instead of leaves buried in a generic walk.

🔴 **The declared gate was blind to the failure it was cited against.** "The four
`p530-material-instance-sharing` tests pass unchanged" — measured, that suite's split test
wires a `MaterialOverrideOp` into the **data lane**, which is part of the fold and
therefore already inside `materialKey`, so it stays green under the exact defect. The
scene-band road had **no** instance-identity coverage: of the nine specs that build a
`MaterialOverride`, none read a material uuid. **`tests/e2e/p536-override-band-instance-split.spec.ts`
was written and committed FIRST, against unchanged code**, so it is a regression test
rather than a description of what the refactor produced. Both halves, since the defect
swaps the readings — and when it was falsified, the leaked colour turned out to be a
_starter-scene_ material, i.e. the collision reached objects the fixture never touched.

**What the naming costs, and how it is bought back.** The old key was a total function of
the spec, and the spec was the builder's only input, so "two materials that render
differently share an instance" was impossible **by construction**. A key composed from
named inputs gives that up. So `keyOf` is kept in two roles: the **default** when a caller
passes no key (forgetting lands on the old safe behaviour, not a weaker one), and the
**oracle** for `primitiveMaterialInputs.test.ts`, which asserts the composed key separates
every pair the walk separates. Only that direction is required; the reverse — this key may
split what the compile would have merged — is a lost dedup, a perf cost invisible on
screen, and #532 is the live example.

⚠️ **DECLARED LIMIT, verified not assumed: the wiring is behaviourally unfalsifiable.**
Forcing `mintedKey` to `null` at the call site reddens **nothing** (3622 unit tests, all
six browser sharing gates green), because the fallback is the _same function_ over the
same IR — which is itself the point, since a second spelling of identity is how the two
halves would drift. So the claim is a **cost** claim and was measured rather than given a
fake tier (20k iterations):

|                                              | µs        |
| -------------------------------------------- | --------- |
| `keyOf(spec)` — what the registry did before | 2.528     |
| composed key, with the evaluator's minted id | **0.482** |
| composed key, re-deriving the id at render   | 1.282     |

Two independent savings: dropping the sort and the per-leaf `JSON.stringify` buys
2.528 → 1.282; using the minted key buys 1.282 → 0.482. The second is what the wiring
buys, and it is the one no test can see.

⚠️ **COVERAGE, still open — and deliberately described in ONE place.** S2 left the
registry's other consumer (`ModifiedMeshR`) on the downstream fallback, so half this
boundary's traffic re-derives identity at render. That is not a defect of this slice but
the standing reach of the invariant, so it is stated once in **§4 "How far this reaches
today"** and machine-checked by `src/nodes/materialKeyReach.gate.test.ts`, rather than
restated here where it would drift out of date the moment the reach changes. Widening the
mint was out of S2's scope and remains #542's open half.

**Gate:** `src/app/material/primitiveMaterialInputs.test.ts` (6 tests, the oracle
property) + the two new browser tests + the four `p530` tests unchanged. Falsified six
ways, each discriminating: dropping any one of the four contributions reds the collision
test; a never-repeating key reds _only_ the dedup assertion; `irKeyFor` ignoring the
minted value reds only the preference test.

### S3 — the ownership doors — BUILT

This section was proposed as _"one module turns a handle into an attached GPU object; the
unwrap is not exported past it, covering **both** registries"_. Three parts of that did
not survive contact with the code, so what shipped is different and the original is kept
above as the claim rather than silently rewritten.

**Two seams enforcing one rule, not one module.** The registries have incompatible
ownership models — `materialRegistry` is refcounted (`retain`/`release`/`holders`, eviction
queued a tick after zero), `geometryRegistry` has no refcount at all — and they disagree on
which tier decides the key: after S2 a material's key is composed at _render_ time, while a
`GeometryRef` is purely _evaluated_. Merging them would mean either giving geometry a
refcount it does not have (new behaviour, not a refactor) or writing one module that is
internally two things wearing one name.

**The unwrap surface is dominated by READS.** Measured: geometry is 2 attach / 6 read /
1 produce. "The unwrap is not exported past it" would have forbidden the majority of
legitimate use, so the seam has a **read-only door** beside the attach door.

What exists now:

- `getForAttach` / `getForRead` on `geometryRegistry`; `get` is no longer exported. Each of
  the seven consumers names its door at the import line.
- `usePrimitiveMaterial` extracted to its own module — the single consumer that touches a
  material instance, so the accessor surface has exactly one importer.
- `registryDoors.gate.test.ts` holds both importer sets closed.

⚠️ **Declared limit:** the two geometry doors are the same function today. `getForRead`
cannot _enforce_ its no-write rule — a `BufferGeometry` is mutable and every reader hands
the real object to three.js. This is a naming tier, not a type tier.

✅ **The syntactic-sweep ⚠️ is now MEASURED, and the answer is sharper than "assume it
cannot work".** A **call-shape** sweep fails _today_, before any refactor — three consumers
imported `get` under an alias. An **import-clause** sweep fixes that but has its own hole:
it is blind to `import * as`, and five of the nine importers were exactly that. The repair
is to refuse the namespace form as the census's _precondition_, not to resolve the
namespace's local name and match `ns.get(` — that is the call-shape sweep again, for
precisely the members the clause sweep cannot see.

⚠️ **What no import-keyed gate can see**, stated because it is the residual risk: a
consumer that takes `mesh.geometry` off the scene graph holds the same shared instance
while importing nothing. Three production sites write to a geometry they do not own
(#541); two of them are invisible to any importer census. Those are pinned by a **content**
sweep instead, and **S4 remains the behavioural backstop** for the class as a whole.

### S4 — the locality gate (#535) — ✅ BUILT 2026-08-03 (`p535-render-locality.spec.ts`)

Two disjoint subgraphs → snapshot every mesh → perturb one → assert nothing outside it
moved, **and** that the perturbed one did.

Both halves, because the defect **swaps** the readings — either assertion alone is
satisfied by it. **MEASURED** on #533 by suppressing each in turn and watching the other
fail on its own.

This is the backstop for mechanisms that never route through the registries at all
(instancing, batching), and for the residual the structural censuses declared they could not
reach: a consumer merely HOLDING a shared instance.

Built as three identically-authored cubes and five perturbations — resize, recolour, splice
an operator, link a Material node, bake a pose — each in its own case, each targeting a
different subgraph so no subgraph is permanently the victim and none permanently inert. Four
things the plan above did not say, all of which the build had to measure:

- **The premise has to be asserted.** In a build that shares nothing, locality is trivially
  true and every case passes while saying nothing. Making the geometry registry never share
  reddens all five cases on that assertion — which is the point of having it.
- **The world matrix has to be read.** The pose rides the GROUP while the mesh keeps identity
  scale, so a bystander that got moved or scaled is invisible to a geometry read. Found by
  probing the fixture before writing it: a posed object showed up as no change at all.
- **The selection gizmo has to be excluded**, by ancestor type rather than by name. Apply
  Transform selects its target, which mounts ~50 `TransformControlsGizmo` meshes into the
  same scene — it arrived as a red in the bystander set. Chrome is a function of the
  selection, not of the graph.
- **The bystanders are compared as a sorted multiset**, so traversal order and object identity
  churn cannot red the file; only something the renderer actually draws can.

⚠️ **Declared limit:** of the five clone sites, four are exercised (the registry's array
transform, Apply-Transform's bake, the material registry's no-mutation rule, and attachment,
which every case rides on). The **decoded-texture clone** taken before a UV transform is not —
it needs an image asset fixture, and until one exists that site is guarded only by the comment
beside it. That is the first thing to add here, and it lands naturally with the UV work.

One thing the falsification pass found that is worth carrying: making `materialRegistry.keyOf`
colour-blind changed **nothing**, because the seam passes its own composed key and `keyOf` is
only the default and the oracle. A perturbation can land in the file and never touch the live
road — the break had to be re-aimed at the composed key, which then reddened exactly the two
material cases and left the three geometry ones green.

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

### S6 — #532 folds in — ✅ BUILT

The plan sentence was "applying `doubleSided` / `alphaTest` / `vertexColors` on the native
road is one place." Two of the three landed exactly that way. The third turned out not to
belong there at all, and finding that out is the whole content of this slice.

**Premise RE-MEASURED 2026-08-04 on `0537a16`** — the issue's numbers dated to `5a8fb15`,
eight merges earlier. It still held: the params land on the node, the rendered mesh does
not move, and a roughness control in the same run moved. The re-measurement added one
thing the issue did not have — **the material uuid changed anyway**, because the identity
key is a content walk. So the dead checkboxes were costing a fresh cache entry and buying
no picture, which is the lost dedup this document predicted in §S2 and is now closed.

**And `vertexColors` is deliberately excluded, which is a measurement, not an omission.**
Wiring it through the native build was tried and OBSERVED in a browser: the box renders
pure black, because three's shader multiplies by a `COLOR_0` attribute a `BoxGeometry`
does not have. A census puts the only writer of that flag in the glTF import chain, gated
on the imported primitive actually carrying the attribute, and applied on the imported
material rather than through this registry. The deeper reason is this document's own
invariant: **a shared material cannot answer a question about its consumer's geometry** —
two meshes may share one material and differ in what they carry, so conditioning the build
on one of them is exactly the coupling the epic removes. The reach is stated beside the
spec and pinned with a presence control, per §"how far this reaches today".

One thing the slice found on the way: the inspector already hid that checkbox for native
primitives, giving the reason "toggling is a no-op". Applying the flag would have
falsified that sentence silently — the control was hidden for a premise that a change one
module away had quietly removed. It now says _unsatisfiable_ instead of _inert_.

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

**S0 ✅ → S1 ✅ → S2 ✅ → S3 ✅ → S4**, with S5 / S6 / S7 folded in where cheapest.

S0 merged (`main` == `e6aaf52`, canary green as the combination). S1 built, and its plan
sentence — "mirroring `GeometryRef`" — is the fifth instance of the failure this document's
reading convention exists for: an analogy that argued a design was quoted as though it
described a constraint. Measuring it cost one build and saved the slice.

S2 built, and it is the sixth instance in a new grammatical dress: not an analogy but a
**citation**. "The four `p530` tests pass unchanged" was quoted as proof the slice was safe,
and that suite covers the data-lane override while the slice's hazard was on the scene-band
one. The repair generalises past this document — **write the missing gate BEFORE the
refactor, against unchanged code**, so it is a regression test rather than a description of
whatever the refactor produces.

S3's own ⚠️ turned out to be the interesting one, and it was measured rather than assumed:
the question is not whether a syntactic sweep survives a refactor but which sweep — a
call-shape sweep already failed at HEAD, and an import-clause sweep is blind to
`import * as` unless it refuses that form outright. S4 remains the backstop for consumers
that reach a shared instance off the scene graph, importing nothing. Note also that S2 leaves clause 1 of the invariant
**partially** satisfied by construction, not by omission — evaluation can only mint the
fold's half of render identity, so S3 inherits a two-tier world rather than a one-tier one.

Every ⚠️ above is the shape that produced four wrong gates in #394: a plan sentence that
argues, read later as a sentence that describes. Measure each before building the slice
that rests on it.

---

**REF:** issues #530, #532, #533, #535, #536, #537; PRs #534, #538; `src/app/geometryRegistry.ts`,
`src/app/materialRegistry.ts`, `src/app/material/primitiveMaterialInputs.ts`,
`src/viewport/SceneFromDAG.tsx`, `src/nodes/types.ts`, `src/nodes/materialKey.ts`;
`tests/e2e/p536-override-band-instance-split.spec.ts`;
`docs/PERFORMANCE.md` Lever 5; `ref/houdini/SOP.md`.
