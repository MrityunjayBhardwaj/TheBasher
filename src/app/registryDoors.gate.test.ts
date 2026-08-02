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
// `boundingBox`), and this file is structurally incapable of noticing either. They are
// tracked as #541 and named in the exception list below so the omission is recorded rather
// than implied. The behavioural backstop for that whole class is #535, which asks "did
// anything leak" rather than "did anyone open the door".
//
// REF: src/app/geometryRegistry.ts + src/app/materialRegistry.ts (the two subjects);
//      src/app/overlayIdentity.gate.test.ts (the sibling gate this shape comes from);
//      tools/gates/sourceFiles.ts (the shared enumeration);
//      docs/RENDER-RESOURCE-IDENTITY-DESIGN.md S3; .anvi/non-negotiables.md §5;
//      issues #530, #533, #535, #536, #541.

import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../tools/gates/sourceFiles';

/** Does `src` pull `module` in as a whole namespace, hiding which door it opens? */
export function importsNamespace(src: string, module: string): boolean {
  return new RegExp(`import\\s*\\*\\s*as\\s+\\w+\\s*from\\s*['"][^'"]*${module}['"]`).test(src);
}

/**
 * The binding names `src` imports from `module`, as WRITTEN IN THE REGISTRY — i.e. the
 * left-hand side of any `as`, so an alias cannot hide which door was opened.
 *
 * Returns [] when the module is not imported at all. A `type` qualifier is stripped so a
 * type-only import reads as the name it is, not as a door.
 */
export function importedDoors(src: string, module: string): string[] {
  const m = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"][^'"]*${module}['"]`).exec(src);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim(),
    )
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
  // ⚠️ boot.ts is a DECLARED EXCEPTION (#541): its `__basher_baked_geometry_bounds` dev
  // seam calls `computeBoundingBox()` on the shared instance, unconditionally. Benign only
  // because `boundingBox` is an idempotent derived cache of the geometry's own attribute
  // data — a property of that field, NOT of this door. Recorded, not waved through.
  'src/app/boot.ts': 'read',
  'src/app/geometrySampleSource.ts': 'read',
  'src/app/resolveEvaluatedMesh.ts': 'read',
  'src/app/resolveMeshUVSpace.ts': 'read',
  // Clones before it writes, so the shared instance is untouched — a reader that happens to
  // own a copy afterwards, which is the rule working rather than an exception to it.
  'src/app/animate/dispatchApplyTransform.ts': 'read',

  // PRODUCE — primes the cache after the async OPFS read, then reads back to check.
  'src/app/asset/bakedGeometryLoader.ts': 'produce',
};

/** The door names each class is allowed to import. `get` is deliberately absent. */
const GEOMETRY_DOORS: Record<Door, string[]> = {
  attach: ['getForAttach'],
  read: ['getForRead'],
  produce: ['prime', 'getForRead'],
  'spec-only': [],
};

/**
 * `materialRegistry` needs no renamed doors, because its accessor surface has exactly ONE
 * consumer. The rule here is the narrower one: only the seam may touch an instance.
 */
const MATERIAL_ACCESSORS = ['get', 'retain', 'release'];

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
      const opened = importedDoors(src, 'geometryRegistry');
      const allowed = GEOMETRY_DOORS[cls];
      for (const door of opened) if (!allowed.includes(door)) wrong.push(`${path}: ${door}`);
      if (opened.length === 0) wrong.push(`${path}: opens no named door`);
    }
    expect(wrong).toEqual([]);
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
    expect(
      importedDoors(
        `import { MAP_SLOTS, type PrimitiveMaterialSpec } from '../materialRegistry';`,
        'materialRegistry',
      ),
    ).toEqual(['MAP_SLOTS', 'PrimitiveMaterialSpec']);
    expect(importedDoors(`import { get } from './somethingElse';`, 'geometryRegistry')).toEqual([]);

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
  });
});
