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
  // Clones before it writes, so the shared instance is untouched — a reader that happens to
  // own a copy afterwards, which is the rule working rather than an exception to it.
  'src/app/animate/dispatchApplyTransform.ts': 'read',

  // PRODUCE — primes the cache after the async OPFS read, then reads back to check.
  'src/app/asset/bakedGeometryLoader.ts': 'produce',

  // LIFETIME — the ONLY file that may take instances out and dispose them (#587). Its own
  // arm below pins the count at one: a second disposer is a second answer to "is this still
  // in use?", and the two would not have to agree.
  'src/viewport/geometrySweep.ts': 'lifetime',
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
 * Bindings that classify a `GeometryRef['kind']` and never reach the cache at all (#630).
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
const GEOMETRY_CLASSIFIERS = ['availabilityOf'];

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
      if (opened.length === 0) wrong.push(`${path}: opens no named door`);
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
  });
});
