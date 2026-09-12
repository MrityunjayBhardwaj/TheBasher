// #536 S3 — the structural gate: a consumer of a SHARED GPU resource must say, at its
// import, which door it is opening.
//
// ── WHY A DOOR AND NOT JUST A GETTER ───────────────────────────────────────────────────
//
// Both registries hand out INSTANCES that other consumers are simultaneously holding.
// `geometryRegistry.get` returns the same `BufferGeometry` for two refs with one key, by
// design — that dedup is the whole point. So "who calls get?" is not the interesting
// question; every consumer does. The interesting question is what each consumer then does
// with the instance, because the three answers have incompatible rules:
//
//   ATTACH — hands it to the scene graph. Takes a share of ownership. This is where the
//            refcount lives for materials, and where one would go for geometry if it ever
//            needs one. The ownership bug this epic exists for (#530/#533) lived here.
//   READ   — computes something and discards it. Takes NO ownership, needs no refcount,
//            and must never write. Six of the geometry sites are this, which is why the
//            design doc's "the unwrap is not exported past it" would have forbidden the
//            majority of legitimate use.
//   PRODUCE — puts an instance IN (the async baked road priming after an OPFS read).
//
// A single `get` cannot express that, so the consumer's intent is unrecoverable from the
// code and every reviewer re-derives it. Naming the door moves the answer to the import
// line, where this gate can read it.
//
// ── WHY NAMESPACE IMPORTS ARE REFUSED, AND WHY THAT IS THE LOAD-BEARING CASE ──────────
//
// The sibling gate (`overlayIdentity.gate.test.ts`) keys on the import CLAUSE because an
// alias cannot dodge it: `import { overlayChannels as oc }` keeps the original name on the
// left of `as`. That technique was inherited here and MEASURED WRONG BEFORE IT SHIPPED —
// which is the same lesson this epic has now paid for twice: an analogy is a hypothesis
// about the CONSTRAINT, not merely about the shape.
//
// The constraint that differs: five of the nine registry importers were `import * as
// geometryRegistry from …`. A namespace clause names the MODULE and not the binding, so a
// binding-keyed sweep sees nothing at all and reports those five as clean. The door would
// be named only at the call (`geometryRegistry.get(…)`), i.e. exactly the call-shape sweep
// that aliasing defeats — and the namespace's local name is itself arbitrary, so it is
// defeated twice over.
//
// Hence case 1: neither registry may be imported as a namespace. That is not a style rule
// standing on its own; it is the precondition that makes cases 2 and 3 COMPLETE rather
// than silently partial. Without it this whole file is a census with a hole in it.
//
// ── WHAT THIS GATE CANNOT SEE — STATED HERE, NOT DISCOVERED LATER ─────────────────────
//
// An importer census only sees consumers that reach a resource THROUGH the registry. A
// consumer that walks the scene graph and takes `mesh.geometry` off an object3D holds the
// very same shared instance while importing nothing. Two such readers exist today and both
// write to what they find (`sceneBounds.ts`, `renderToImage.ts` — they lazily fill
// `boundingBox`), and the IMPORT-keyed cases below are structurally incapable of noticing
// either.
//
// So the write rule is gated a second way, by CONTENT rather than by import (case 4). A
// sweep for `computeBounding*` over the same file set sees all three sites regardless of
// how they reached the instance, which is exactly the blind spot the importer cases have.
// Two questions, two techniques, both stated: the importer cases answer "who opened the
// door", the content case answers "who wrote to what came out of it". Neither answers
// "who is holding the resource" — that is #535's behavioural backstop, and it stays open.
//
// REF: src/app/geometryRegistry.ts + src/app/materialRegistry.ts (the two subjects);
//      src/app/overlayIdentity.gate.test.ts (the sibling gate this shape comes from);
//      tools/gates/sourceFiles.ts (the shared enumeration);
//      docs/RENDER-RESOURCE-IDENTITY-DESIGN.md S3; .anvi/non-negotiables.md §5;
//      issues #530, #533, #535, #536, #541.

import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';

/** Does `src` pull `module` in as a whole namespace, hiding which door it opens? */
export function importsNamespace(src: string, module: string): boolean {
  return new RegExp(`import\\s*\\*\\s*as\\s+\\w+\\s*from\\s*['"][^'"]*${module}['"]`).test(src);
}

/**
 * The binding names `src` imports from `module`, as WRITTEN IN THE REGISTRY — i.e. the
 * left-hand side of any `as`, so an alias cannot hide which door was opened.
 *
 * Returns [] when the module is not imported at all.
 *
 * ⚠️ AN INLINE `type` SPECIFIER IS DROPPED, NOT NORMALISED (#587). It used to have its
 * qualifier stripped, which the comment here described as making a type import "read as the
 * name it is, not as a door" — while the code made it read as *exactly* a door, because the
 * result was indistinguishable from a value import of the same name. The whole-clause form
 * (`import type { X } from …`) never matched this regex at all, so the two spellings of the
 * same thing disagreed. A type erases at compile time and can carry no instance, so no
 * spelling of one opens a door.
 */
export function importedDoors(src: string, module: string): string[] {
  const m = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"][^'"]*${module}['"]`).exec(src);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^type\s+/.test(part))
    .map((part) => part.split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

/** What a consumer does with the instance it takes out. */
type Door =
  /** Hands it to the scene graph — takes a share of ownership. */
  | 'attach'
  /** Computes from it and discards it. Never writes, never retains. */
  | 'read'
  /** Puts an instance in (the async baked road, after the OPFS read). */
  | 'produce'
  /** Takes instances OUT and disposes them — the lifetime seam (#587). Exactly one file. */
  | 'lifetime'
  /** Imports only the spec/type surface — opens no door on an instance at all. */
  | 'spec-only';

/**
 * Every module that reaches `geometryRegistry`, and the door each one opens.
 *
 * A new importer is not forbidden — it is a RED that forces whoever adds it to say which
 * door it opens, here. That is the point: the eighth consumer cannot be added without
 * answering the ownership question.
 */
const GEOMETRY_CONSUMERS: Record<string, Door> = {
  // ATTACH — the two sites that hand a registry instance to an R3F <mesh>. ModifiedMeshR
  // and ObjectR's data road. This is the pair the ownership rule is actually about.
  'src/viewport/SceneFromDAG.tsx': 'attach',

  // READ — computes and discards. None of these may write to what they take.
  // ⚠️ boot.ts is a DECLARED EXCEPTION (#541) — see WRITERS below, which is where the
  // whole exception set lives now that it is machine-checked rather than described.
  'src/app/boot.ts': 'read',
  'src/app/geometrySampleSource.ts': 'read',
  // #635 — `resolveEvaluatedMesh` used to be here and no longer opens a door itself: the UV
  // read moved behind this module, which lifts the `uv` buffer off the built geometry as a
  // corner-domain attribute and copies it. It takes no ownership and writes nothing back.
  // …and `resolveMeshUVSpace` left with it, for the same reason: it now reads the typed UV
  // answer off the resolved value and imports only the CLASSIFIER (`availabilityOf`), which
  // hands back no instance and therefore opens no door. Two consumers became one.
  'src/app/uvAttributes.ts': 'read',
  // #786 — the rims `uvAttributes.ts` gathers through now come off the BUILT index buffer, so
  // that walk lives here. It opens a door for one reason: a derived kind's weld is COMPOSED from
  // its source's (#754 — position-welding a merged buffer would fuse a mirror's two copies), and
  // the recursion bottoms out at the primitive, whose geometry only the registry has. It takes
  // the top geometry as a PARAMETER and reaches for source geometries alone; it computes a weld
  // and rims and writes to neither.
  'src/app/builtRims.ts': 'read',
  // Clones before it writes, so the shared instance is untouched — a reader that happens to
  // own a copy afterwards, which is the rule working rather than an exception to it.
  'src/app/animate/dispatchApplyTransform.ts': 'read',
  // #847 — a bevel's angle limit selects edges by DIHEDRAL DEVIATION, which is the one fact on
  // the scope road that positions decide rather than the descriptor. It reads the source's built
  // buffer to take face normals and writes to nothing. The door is held HERE, in a module whose
  // whole job is that one read, so the shared scope resolver stays a pure function of its spine
  // and params and does not join this census.
  'src/app/edgeAngleSelection.ts': 'read',
  // #994 — the cube projection takes positions to project and writes to nothing. It is a
  // `read` for the same reason `uvAttributes.ts` is, and it is a SECOND consumer of that shape
  // rather than a widening of the first: the lift gathers a `uv` buffer, this gathers a
  // `position` buffer and computes a layer that was never in any buffer. Both mint into the
  // attribute store and hand the shared instance back untouched.
  'src/app/uvProjection.ts': 'read',

  // PRODUCE — primes the cache after the async OPFS read, then reads back to check.
  'src/app/asset/bakedGeometryLoader.ts': 'produce',

  // LIFETIME — the ONLY file that may take instances out and dispose them (#587). Its own
  // arm below pins the count at one: a second disposer is a second answer to "is this still
  // in use?", and the two would not have to agree.
  'src/viewport/geometrySweep.ts': 'lifetime',

  // SPEC-ONLY — imports the CLASSIFIER (`availabilityOf`) and nothing else. #605 item 2: the
  // sole minter of a `MaterialAssignment` derives from it whether an unanswered slot can be
  // answered somewhere else, which is the same condition `MeshUVRead` and `GeometryReadResult`
  // key their own `'elsewhere'` on. A classifier takes a descriptor and returns a label — it
  // never touches the cache and hands back no instance — so there is nothing here for a caller
  // to hold or free, and no door is opened. Deliberately NOT `readGeometry`: that would build
  // a geometry on every material read, where this question needs only the classification.
  'src/app/materialAssignment.ts': 'spec-only',
  // #1015 — the second spec-only importer, and the SAME classifier read one step further on.
  // `materialAssignment` asks whether an unanswered slot can be answered elsewhere; the UV
  // editor's backdrop then has to ask WHICH clone child holds the answer, and a boolean cannot
  // say. `cloneAddressOf` walks descriptors to descriptors by the recursion `availabilityOf`
  // already runs — no cache read, no build, no instance — so it opens no door either. It lives
  // in the registry rather than beside its caller because the whole defect it fixes was a
  // second rule (`descriptor.kind === 'gltf'`) that agreed with the classifier until it didn't.
  'src/app/resolveMeshUVSpace.ts': 'spec-only',
};

/**
 * Bindings that hand back NO INSTANCE, so importing one opens no door and answers no
 * ownership question (#586). `size`, `growthBySource` and `resetGrowth` return numbers.
 *
 * Listed rather than pattern-matched, and subtracted BEFORE the door check rather than
 * added to every class's allowance, so the census keeps its teeth in both directions: a new
 * diagnostic must be named here, and a file that imports ONLY diagnostics still trips the
 * "opens no named door" arm — it has no business in `GEOMETRY_CONSUMERS` at all.
 *
 * `clear` is deliberately absent: it disposes every instance in the cache, which is an
 * ownership act of the most consequential kind, and no production file may import it.
 *
 * ⚠️ `residentBytes` (#588) is the closest any entry here sits to the line, and the reason is
 * worth stating: it READS every cached instance's buffers, where the other three never touch
 * an instance at all. It still qualifies — it hands back a number, so no caller can hold or
 * free anything through it — but the rule this list encodes is about what comes OUT, not
 * about what the binding looks at, and the next candidate may not clear it so easily.
 */
const GEOMETRY_DIAGNOSTICS = ['size', 'residentBytes', 'growthBySource', 'resetGrowth'];

/**
 * Bindings that classify a `GeometryDescriptor['kind']` and never reach the cache (#630).
 *
 * (It read `GeometryRef['kind']` until ns-2 D8 removed that hand-written union; the two
 * spellings were the point of the removal, and this comment was one of the places the dead
 * one survived.)
 *
 * Kept SEPARATE from the diagnostics carve-out above rather than folded into it, because
 * the two are exempt for different reasons and merging them would make the list's rule
 * unreadable. A diagnostic looks at the cache and hands back a number. A classifier never
 * looks at the cache: `availabilityOf` takes a kind and returns a label, so there is no
 * instance for a caller to hold or free, and no door for it to be opening. It sits further
 * from the line than `residentBytes` does, not closer.
 *
 * Why it is importable at all rather than duplicated per consumer: it is the answer to
 * "what does a null from this registry MEAN", and the registry is the code that produces
 * the null. A consumer keeping its own copy is a second spelling that agrees until someone
 * adds a geometry kind — which is the shape `resolveMeshUVSpace.ts` was in before #630, and
 * its own header records that defect biting.
 */
// #389 — `drawnByAssetClone` joins on exactly the rule stated above rather than by
// resemblance: it takes a DESCRIPTOR and returns a boolean, never touches the cache, and
// hands back no instance, so there is nothing for a caller to hold or free. It is defined
// in terms of `availabilityOf` — one implementation, one rule — so it is not a second
// spelling of the classification either; it is that classification asked a question the
// renderer needs ("is something else already drawing these buffers?"). The alternative was
// a `descriptor.kind === 'gltf'` test at the draw site, which is the naming tier this
// module has catalogued twice and which would have gone right on passing when a kind moved.
// #1015 — `cloneAddressOf` joins by the same rule again, and it is the one the paragraph above
// predicted: the `descriptor.kind === 'gltf'` test the comment calls "the naming tier this module
// has catalogued twice" had in fact gone right on passing when a kind moved — a non-materialising
// `uvProject` over an imported mesh is drawn by the clone and is not of that kind. This takes a
// DESCRIPTOR and returns a DESCRIPTOR, reads no cache and builds nothing, and recurses exactly as
// `availabilityOf` does, so it is that same classification asked the follow-up question a boolean
// cannot answer: not "is something else drawing these buffers" but "WHICH child is".
const GEOMETRY_CLASSIFIERS = ['availabilityOf', 'drawnByAssetClone', 'cloneAddressOf'];

/** The door names each class is allowed to import. `get` is deliberately absent. */
const GEOMETRY_DOORS: Record<Door, string[]> = {
  attach: ['getForAttach'],
  // `readGeometry` (#630) is the same read with its absence typed — same cache, same
  // instance, same no-write contract — so it belongs to this door rather than opening a
  // new one. `getForRead` is defined in terms of it, not beside it.
  read: ['getForRead', 'readGeometry'],
  produce: ['prime', 'getForRead', 'readGeometry'],
  lifetime: ['sweep'],
  'spec-only': [],
};

/**
 * `materialRegistry` needs no renamed doors, because its accessor surface has exactly ONE
 * consumer. The rule here is the narrower one: only the seam may touch an instance.
 */
const MATERIAL_ACCESSORS = ['get', 'retain', 'release'];

/**
 * Every production site that WRITES to a geometry it does not own, and why each is
 * tolerated (#541). Keyed by file because the sweep below is per-file.
 *
 * This is the exception list to `getForRead`'s rule, and it is checked rather than
 * described: an undeclared fourth writer reds, and a declared one that goes away reds too,
 * so the list cannot quietly become fiction in either direction.
 *
 * All three are benign for ONE reason, and it does not generalise: `boundingBox` is an
 * idempotent derived cache of the geometry's own attribute data, so every writer computes
 * the same answer. That is a property of THAT FIELD, not of the seam. If anything ever
 * replaces attribute data on a shared instance in place, a stale `boundingBox` survives
 * and these are the readers that would serve it.
 */
const SHARED_GEOMETRY_WRITERS: Record<string, string> = {
  // Reaches the instance THROUGH the registry — the importer cases can see this one.
  'src/app/boot.ts': 'the __basher_baked_geometry_bounds dev seam, unconditionally',
  // Reach it off the scene graph (`mesh.geometry`) and import nothing. Invisible to an
  // importer census by construction — these two are why this case exists at all.
  'src/viewport/sceneBounds.ts': 'lazily fills boundingBox while walking the live scene',
  'src/render/renderToImage.ts': 'same shape as sceneBounds, on the offline render path',
};

/**
 * THE TOPOLOGY VERBS — the ones that change what the mesh IS, not what has been derived from it.
 *
 * ── WHY THIS CASE EXISTS (#725) ──────────────────────────────────────────────────────────
 *
 * The write case above pins sites that write to a geometry they do not own, and it sees exactly
 * ONE verb: `computeBounding(Box|Sphere)`. That was the whole population when it was written and
 * it reads like the general rule — the door map two hundred lines up says *"READ — computes and
 * discards. None of these may write to what they take."* Nothing checked the other verbs, so an
 * in-place `setIndex` on a shared instance would have landed in silence.
 *
 * 🔴 AND THAT IS PRECISELY THE EVENT #725 IS WAITING FOR. Its invariant — everything derived from
 * the OLD topology must be rebuilt, not merely interpolated onto the new — is not reachable today,
 * and the reason is structural rather than lucky: every geometry-producing path in the repo builds
 * a FRESH instance or clones before it writes, so a changed topology always lands under a new cache
 * key and every derived read goes to a different entry instead of to a stale one. Censused across
 * all 632 source files while opening this case; the nine below are the whole population.
 *
 * The protection is therefore a property of content-keyed rebuild, and it ends the moment one
 * operator mutates a topology in place. This case is that tripwire: a tenth file, or a new verb in
 * an existing one, reds here and sends its author to #725 — where the deform/topology-change
 * declaration and the per-structure invalidation rule are already written down, waiting for the
 * first consumer that makes them worth building.
 *
 * ⚠️ WHAT IT CATCHES, MEASURED BOTH WAYS RATHER THAN CLAIMED. Keyed by FILE, like the write case
 * above and for the same reason — two of these reach a geometry without importing anything. So:
 *   · a NEW FILE writing topology REDS, naming the file (falsified: a module doing
 *     `shared.setIndex(...)` on a geometry it was handed appears in the diff);
 *   · a new VERB inside an already-declared file does NOT red (falsified: adding
 *     `deleteAttribute` to `meshBvh.ts` left all nine green).
 * The residual hole is therefore a new in-place write inside one of the nine, and it is accepted
 * rather than overlooked: an operator that changes topology in place arrives as a new build arm or
 * a new module, which is the case that reds. Pinning a verb SET per file would shrink the hole and
 * would red on every innocent refactor of the four files that legitimately write their own output.
 *
 * ⚠️ `applyMatrix4` AND `computeVertexNormals` ARE DELIBERATELY ABSENT, and the omission is the
 * point rather than an oversight. Both are DEFORM verbs in the reference's own vocabulary — they
 * move points or refresh a derivation without creating or destroying points or primitives
 * (`SOP.md:84`, `duplicateSource` vs `duplicatePointSource`). Sweeping them in would grow the
 * census by a further ~17 sites and blur the one distinction #725 turns on, leaving a gate that
 * reds for two unrelated reasons and therefore says nothing precise when it reds.
 */
const TOPOLOGY_WRITE = /\.(setIndex|setAttribute|deleteAttribute|clearGroups|addGroup)\s*\(/;

/**
 * Every file that writes a geometry's topology, and WHY that write is safe. A new entry is not
 * forbidden — it is a red that forces its author to answer the question in the paragraph above:
 * does this instance belong to you?
 */
const TOPOLOGY_WRITERS: Record<string, string> = {
  // 🔑 THE CLOSEST THING IN THE REPO TO AN IN-PLACE TOPOLOGY CHANGE, and the reason this case is
  // worth having. Vertex splitting genuinely changes the mesh — it duplicates the points whose
  // loops disagree and rewrites the index to send each face at its own copy. It stays safe by
  // building a NEW container and copying every attribute across by name; the source is read and
  // never touched. Change that to write through to the source and #725 becomes live.
  'src/app/cornerMaterialisation.ts':
    'splits vertices into a fresh BufferGeometry; source untouched',
  // Owns the cache, so these are writes to its own output: `build` clears groups on what it just
  // built, the slot-table arm adds groups to that same instance, the bevel fills a fresh
  // container, and the subset arm CLONES before it rewrites the index.
  'src/app/geometryRegistry.ts':
    'writes only what it just built, and clones before the subset rewrite',
  // The PRODUCE door — rehydrates OPFS bytes into a fresh instance, which is its output rather
  // than something it took.
  'src/app/asset/bakedGeometryStore.ts': 'fills a fresh BufferGeometry from OPFS bytes',
  // A private world-space copy assembled from raw arrays, never a registry instance. three-mesh-bvh
  // reorders an index in place during construction — on THIS geometry, which is why it must be a
  // copy and why the final index is read back out rather than assumed.
  'src/app/meshBvh.ts': 'builds a private world-space geometry for the BVH from raw arrays',
  // Viewport helpers: each builds its own line/glyph geometry and attaches it to its own object.
  // None of them can reach a registry instance — they never import the registry.
  'src/app/Gizmo.tsx': 'builds its own handle line geometry',
  // Arrived on `main` from the armature work while this gate was being written on the geometry
  // branch, and the two only met at the merge — which is the case a text merge cannot see and
  // this gate can. Both of its writes fill a container it made in the same `useMemo`: the
  // octahedral bone body, and the stick-mode buffer that is re-filled per frame WITHIN a fixed
  // allocation (`setDrawRange`, never a re-`setIndex`). Nothing it writes was handed to it.
  'src/viewport/ArmatureHelper.tsx':
    'builds its own octahedral bone body and stick line buffer',
  'src/viewport/CameraHelpers.tsx': 'builds its own frustum//target line geometries',
  'src/viewport/CurveLine.tsx': 'builds its own polyline geometry',
  'src/viewport/LightHelpers.tsx': 'builds its own light-direction line geometry',
  'src/viewport/NullGlyph.tsx': 'builds its own null-glyph line geometry',
};

const MATERIAL_CONSUMERS: Record<string, Door> = {
  // The seam. Builds, retains in a layout effect, releases on unmount.
  'src/app/material/usePrimitiveMaterial.ts': 'attach',
  // Imports MAP_SLOTS and the spec TYPE to compose the key. Opens no door on an instance.
  'src/app/material/primitiveMaterialInputs.ts': 'spec-only',
};

describe('#536 S3 — every shared-resource consumer names the door it opens', () => {
  it('refuses a namespace import of either registry, which would hide the door', () => {
    // The precondition for the two censuses below. A namespace clause names the module and
    // not the binding, so a binding-keyed sweep cannot see the door at all — it would
    // report those consumers clean forever.
    const offenders = sourceFiles()
      .filter(
        ([, src]) =>
          importsNamespace(src, 'geometryRegistry') || importsNamespace(src, 'materialRegistry'),
      )
      .map(([path]) => path)
      .sort();

    expect(offenders).toEqual([]);
  });

  it('has exactly one closed set of geometry consumers, each opening a declared door', () => {
    const importers = sourceFiles()
      .filter(([, src]) => /from\s*['"][^'"]*geometryRegistry['"]/.test(src))
      .map(([path]) => path)
      .sort();

    expect(importers).toEqual(Object.keys(GEOMETRY_CONSUMERS).sort());

    // And each opens only the doors its class allows. Split from the census above so a
    // wrong ANSWER for a known consumer is a different red from an UNCLASSIFIED consumer.
    const wrong: string[] = [];
    for (const [path, src] of sourceFiles()) {
      const cls = GEOMETRY_CONSUMERS[path];
      if (!cls) continue;
      const opened = importedDoors(src, 'geometryRegistry').filter(
        (b) => !GEOMETRY_DIAGNOSTICS.includes(b) && !GEOMETRY_CLASSIFIERS.includes(b),
      );
      const allowed = GEOMETRY_DOORS[cls];
      for (const door of opened) if (!allowed.includes(door)) wrong.push(`${path}: ${door}`);
      // A declared consumer that opens nothing is a STALE declaration — EXCEPT for the one
      // class whose entire meaning is that it opens nothing. `spec-only` names a file that
      // imports a classifier or a type and takes no instance, which this suite's own prose
      // already calls a legitimate state ("hands back no instance and therefore opens no
      // door"); until #605 item 2 the only such file had been deleted from the map rather
      // than classified, so the two arms quietly disagreed about whether it could exist.
      // Staleness is still caught for it, one arm up: stop importing the module at all and
      // the census above reds, because the importer set no longer matches the map's keys.
      if (opened.length === 0 && allowed.length > 0) wrong.push(`${path}: opens no named door`);
    }
    expect(wrong).toEqual([]);
  });

  // #586 — the diagnostics carve-out above subtracts three bindings from the door check, so
  // it is exactly the shape that could quietly swallow a real door. Two arms hold it shut:
  // the list may only name bindings that return no instance, and the most dangerous export
  // in the module must stay out of production entirely.
  it('the diagnostic carve-out names only instance-free bindings, and `clear` is not one', () => {
    expect(GEOMETRY_DIAGNOSTICS).not.toContain('clear');
    for (const door of Object.values(GEOMETRY_DOORS).flat()) {
      expect(GEOMETRY_DIAGNOSTICS).not.toContain(door);
    }

    // `clear()` disposes every cached geometry. A production importer of it could blank
    // every mesh drawing a shared instance, which is [[H259]]'s symptom with a one-line
    // cause. It is a TEST seam and the census is what keeps that true.
    const importers = sourceFiles()
      .filter(([, src]) => importedDoors(src, 'geometryRegistry').includes('clear'))
      .map(([path]) => path)
      .sort();

    expect(importers).toEqual([]);
  });

  // #587 — `sweep` disposes. `clear` is forbidden outright and `sweep` is allowed exactly
  // once, and those are the same rule at two strengths: whoever may free a shared instance
  // is answering "is this still in use?", and two answerers would not have to agree. The
  // count is asserted rather than the membership alone, so a SECOND disposer reds even if it
  // is added to the consumer table above with a straight face.
  it('gives the geometry cache exactly one disposer, and names it', () => {
    const disposers = sourceFiles()
      .filter(([, src]) => importedDoors(src, 'geometryRegistry').includes('sweep'))
      .map(([path]) => path)
      .sort();

    expect(disposers).toEqual(['src/viewport/geometrySweep.ts']);
    expect(disposers).toHaveLength(1);
  });

  it('lets only the material seam touch a material instance', () => {
    const touching = sourceFiles()
      .filter(([, src]) =>
        importedDoors(src, 'materialRegistry').some((d) => MATERIAL_ACCESSORS.includes(d)),
      )
      .map(([path]) => path)
      .sort();

    const expected = Object.entries(MATERIAL_CONSUMERS)
      .filter(([, cls]) => cls === 'attach')
      .map(([path]) => path)
      .sort();

    expect(touching).toEqual(expected);
  });

  it('pins every site that writes to a geometry it does not own (#541)', () => {
    // Keyed on CONTENT, not on the import — deliberately a different technique from the
    // cases above, because two of these three reach the shared instance off the scene
    // graph and import nothing at all. Comments are stripped so prose that DOCUMENTS the
    // hazard (this file's own header did exactly that) is not read as a violation.
    const writers = sourceFiles()
      .filter(([, src]) => /\bcomputeBounding(Box|Sphere)\s*\(/.test(stripComments(src)))
      .map(([path]) => path)
      .sort();

    expect(writers).toEqual(Object.keys(SHARED_GEOMETRY_WRITERS).sort());
  });

  it('pins every site that changes a geometry TOPOLOGY, so #725 becomes reachable loudly', () => {
    // Same CONTENT technique as the case above and for the same reason — two of these reach a
    // geometry without importing anything — but over the verbs that change what the mesh IS.
    // See TOPOLOGY_WRITE for why the deform verbs are deliberately not swept in.
    const writers = sourceFiles()
      .filter(([, src]) => TOPOLOGY_WRITE.test(stripComments(src)))
      .map(([path]) => path)
      .sort();

    expect(
      writers,
      'A file changes a geometry topology and has not said whose geometry it is. If it builds or clones its own, add it to TOPOLOGY_WRITERS with that reason. If it writes through to an instance it was handed, STOP: every derived structure cached against the old topology (the weld map, tiledFaceOrder/tiledCornerOrder, the rim cache, the UV lift) now answers about a mesh that no longer exists. That is issue #725, and it has been waiting for exactly this commit.',
    ).toEqual(Object.keys(TOPOLOGY_WRITERS).sort());
  });

  it('neither registry is re-exported through a barrel', () => {
    // The one thing that would defeat an import-keyed sweep: a module a consumer could
    // import the registry FROM without naming the registry's own path. Nothing does this
    // today, and this case is what keeps it that way.
    const reExporters = sourceFiles()
      .filter(([path]) => !/\/(geometry|material)Registry\.ts$/.test(path))
      .filter(([, src]) =>
        /export\s*(?:\{[^}]*\}|\*)\s*from\s*['"][^'"]*(?:geometry|material)Registry['"]/.test(src),
      )
      .map(([path]) => path);

    expect(reExporters).toEqual([]);
  });

  it('guards the guard — the sweep sees an ALIASED door and a NAMESPACE import', () => {
    // The positive controls that make the cases above evidence rather than empty
    // assertions. Without these, a regex gone stale would report a clean sweep forever.
    expect(
      importedDoors(`import { getForRead as g } from './geometryRegistry';`, 'geometryRegistry'),
    ).toEqual(['getForRead']);
    expect(
      importedDoors(`import { getForAttach } from '../app/geometryRegistry';`, 'geometryRegistry'),
    ).toEqual(['getForAttach']);
    // The spec-only shape: one value binding beside a type. It used to expect the type in
    // this list too, which pinned the bug described on `importedDoors` — a type reported
    // exactly as a door would be. Only the VALUE survives now. This changed no verdict for
    // materials (the arm below keys on the three accessor names, and a type is not one),
    // which is why the old expectation could sit here looking correct.
    expect(
      importedDoors(
        `import { MAP_SLOTS, type PrimitiveMaterialSpec } from '../materialRegistry';`,
        'materialRegistry',
      ),
    ).toEqual(['MAP_SLOTS']);
    expect(importedDoors(`import { get } from './somethingElse';`, 'geometryRegistry')).toEqual([]);

    // #587 — a type erases at compile time and can carry no instance, so neither spelling
    // of a type import opens a door. The inline form used to be reported as one, which is
    // a FALSE red on a consumer that took nothing, and the confusing kind: the fix that
    // suggests itself is widening the allow-list, which then widens it for values too.
    expect(
      importedDoors(
        `import { sweep, type GeometrySweepResult } from '../app/geometryRegistry';`,
        'geometryRegistry',
      ),
    ).toEqual(['sweep']);
    expect(
      importedDoors(
        `import { type GeometrySweepResult } from './geometryRegistry';`,
        'geometryRegistry',
      ),
    ).toEqual([]);
    // The whole-clause form was already invisible; pinned so the two spellings stay agreed.
    expect(
      importedDoors(
        `import type { GeometrySweepResult } from './geometryRegistry';`,
        'geometryRegistry',
      ),
    ).toEqual([]);

    expect(
      importsNamespace(
        `import * as geometryRegistry from './geometryRegistry';`,
        'geometryRegistry',
      ),
    ).toBe(true);
    // The local name is arbitrary — that is precisely why a namespace import cannot be
    // gated at the call site and must be refused at the import.
    expect(
      importsNamespace(`import * as gr from '../app/geometryRegistry';`, 'geometryRegistry'),
    ).toBe(true);
    expect(
      importsNamespace(`import { getForRead } from './geometryRegistry';`, 'geometryRegistry'),
    ).toBe(false);

    // And the CONTENT sweep sees a real write while ignoring prose about one — the
    // distinction the whole write case rests on, since this file's own header discusses
    // `computeBoundingBox` at length and must not thereby become a violation.
    const seesWrite = (src: string) =>
      /\bcomputeBounding(Box|Sphere)\s*\(/.test(stripComments(src));
    expect(seesWrite(`if (!g.boundingBox) g.computeBoundingBox();`)).toBe(true);
    expect(seesWrite(`mesh.geometry.computeBoundingSphere();`)).toBe(true);
    expect(seesWrite(`// never call computeBoundingBox() on a shared instance`)).toBe(false);
    expect(seesWrite(`/* computeBoundingBox() is forbidden here */`)).toBe(false);

    // …and the TOPOLOGY sweep sees each of its verbs, ignores prose about them, and does NOT
    // fire on the deform verbs it deliberately excludes. Without this last pair the exclusion
    // would be invisible: a regex that quietly grew to match `applyMatrix4` would go on passing
    // while the census it guards stopped meaning what its header says.
    const seesTopology = (src: string) => TOPOLOGY_WRITE.test(stripComments(src));
    expect(seesTopology(`geometry.setIndex(new BufferAttribute(rewritten, 1));`)).toBe(true);
    expect(seesTopology(`g.setAttribute('position', attr);`)).toBe(true);
    expect(seesTopology(`built.clearGroups();`)).toBe(true);
    expect(seesTopology(`built.addGroup(0, 3, 1);`)).toBe(true);
    expect(seesTopology(`geom.deleteAttribute('uv');`)).toBe(true);
    expect(seesTopology(`// do not call setIndex() on a shared instance`)).toBe(false);
    expect(seesTopology(`/* setAttribute() is forbidden here */`)).toBe(false);
    expect(seesTopology(`geometry.applyMatrix4(m);`)).toBe(false);
    expect(seesTopology(`built.computeVertexNormals();`)).toBe(false);
  });
});
