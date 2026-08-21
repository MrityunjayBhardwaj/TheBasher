// #638 (ns-1b step 5) — the resolution function's contract, INCLUDING its refusals.
//
// Every assertion here is one of the phase's named failures, and each one is written as
// "this state has no constructor" rather than as "this state is detected". The four that
// matter most are silent in every tier above this one: an array over an empty layout draws
// NOTHING (no error, no shadow, no click), a 1-length array draws six of thirty-six index
// elements, a compacted table leaves `material[3]` undefined, and a non-indexed geometry
// puts groups in the wrong address space entirely.
//
// The geometries come from the REGISTRY, never hand-built, so what is checked is the layout
// `build()` actually writes. A stand-in that skipped the producer's own transformation would
// invert the test — it would red on correct code and go green when the change is removed.
//
// REF: src/app/resolveMeshMaterial.ts (the subject); src/app/geometryRegistry.ts (`build`);
//      src/test-utils/twoMaterialMesh.ts (the three fixtures); issues #638, #634.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';
import { clear, getForRead } from './geometryRegistry';
import { materialAssignmentOf, objectSlotsOf, primaryMaterial } from './materialAssignment';
import { meshMaterialRefusal, resolveMeshMaterial } from './resolveMeshMaterial';
import { boxGeometryRef, boxDescriptor } from './modifierGeometry';
import { mintMeshAttributes } from '../nodes/meshAttributes';
import {
  boxFromFaceIndices,
  nonAlignedMaterialMeshData,
  sparseSlotMaterialMeshData,
  twoMaterialMeshData,
} from '../test-utils/twoMaterialMesh';
import type { MeshDataValue } from '../nodes/types';

/** A hydrated slot table, the shape `useSlotMaterials` hands over: dense, in table order. */
const hydrated = (n: number) =>
  Array.from({ length: n }, () => new THREE.MeshPhysicalMaterial()) as THREE.Material[];

/** The pair a component builds: the built instance, and the value's own assignment. */
const drawFor = (data: MeshDataValue, materials: readonly THREE.Material[]) => {
  const geometry = getForRead(data.geometry);
  const assignment = materialAssignmentOf(data.attributeKey, objectSlotsOf(null, data));
  return {
    geometry,
    draw: resolveMeshMaterial(geometry, assignment, materials),
    refusal: meshMaterialRefusal(geometry, assignment, materials),
  };
};

beforeEach(() => {
  clear();
});

describe('#638 resolveMeshMaterial — when an array is the answer', () => {
  it('a two-material box draws with the TABLE, and its groups cover the whole index', () => {
    const materials = hydrated(8);
    const { geometry, draw, refusal } = drawFor(twoMaterialMeshData(), materials);

    expect(refusal).toBeNull();
    expect(Array.isArray(draw!.material)).toBe(true);
    // The table, in table order, not the slots the faces happen to use.
    expect(draw!.material).toEqual([materials[0], materials[1]]);
    expect((draw!.material as THREE.Material[])[0]).not.toBe(
      (draw!.material as THREE.Material[])[1],
    );
    expect(geometry!.groups.map((g) => [g.start, g.count, g.materialIndex])).toEqual([
      [0, 18, 0],
      [18, 18, 1],
    ]);
  });

  it('the SPARSE table stays sparse: length 4, no holes, and full coverage', () => {
    // `assignedMaterials()` would answer with TWO materials here — slot 0's and slot 3's,
    // compacted — and the groups say `materialIndex: 3`. `material[3]` would be undefined
    // and a third of the box would vanish with nothing thrown. This is that assertion.
    const materials = hydrated(8);
    const { geometry, draw, refusal } = drawFor(sparseSlotMaterialMeshData(), materials);

    expect(refusal).toBeNull();
    const array = draw!.material as THREE.Material[];
    expect(array).toHaveLength(4);
    expect(array.filter((m) => m === undefined)).toEqual([]);
    expect(array).toEqual(materials.slice(0, 4));
    // Coverage over the ACTUAL layout: the groups address slots 0 and 3, both of which
    // resolve, so every index element is drawn.
    const covered = geometry!.groups
      .filter((g) => (g.materialIndex ?? -1) < array.length)
      .reduce((sum, g) => sum + g.count, 0);
    expect(covered).toBe(geometry!.getIndex()!.count);
    expect(geometry!.groups.map((g) => g.materialIndex)).toEqual([0, 3]);
  });

  it('the non-aligned fixture resolves too — the boundary is the geometry’s business', () => {
    const materials = hydrated(8);
    const { geometry, draw } = drawFor(nonAlignedMaterialMeshData(), materials);
    expect(draw!.material).toEqual([materials[0], materials[1]]);
    expect(geometry!.groups.map((g) => [g.start, g.count])).toEqual([
      [0, 3],
      [3, 33],
    ]);
  });
});

describe('#638 resolveMeshMaterial — the four states with no constructor', () => {
  it('an array over an EMPTY layout is refused: the mesh would draw nothing at all', () => {
    // The reachable route, not a synthetic one: a geometry whose ref carries no attribute
    // key gets no groups from `build()`, while the data value still declares two slots —
    // a store miss, a stale key after an overlay rebuild, or either named refusal.
    const geometry = getForRead(boxGeometryRef([1, 1, 1], null))!;
    expect(geometry.groups).toHaveLength(0);
    const assignment = materialAssignmentOf(twoMaterialMeshData().attributeKey, [null, null]);
    const materials = hydrated(2);

    const draw = resolveMeshMaterial(geometry, assignment, materials);
    expect(Array.isArray(draw!.material)).toBe(false);
    expect(draw!.material).toBe(materials[0]);
    // Degradation is REPORTED. A mesh that should draw two materials drawing one is a lying
    // label, and a lying label passes every behavioural test there is.
    expect(meshMaterialRefusal(geometry, assignment, materials)).toMatch(/covers 0 of 36/);
  });

  it('a stock box’s SIX cube-side groups cannot take a two-length array', () => {
    // Six of thirty-six, the failure that is visible only in pixels. `build()` already
    // removes the stock six, so this asserts the SECOND rung: even if a layout meant for
    // something else survived, the array has no constructor over it.
    const stock = new THREE.BoxGeometry(1, 1, 1);
    expect(stock.groups).toHaveLength(6);
    const assignment = materialAssignmentOf(twoMaterialMeshData().attributeKey, [null, null]);
    const materials = hydrated(2);

    expect(Array.isArray(resolveMeshMaterial(stock, assignment, materials)!.material)).toBe(false);
    expect(meshMaterialRefusal(stock, assignment, materials)).toMatch(/covers 12 of 36/);
  });

  it('a NON-INDEXED geometry is refused by name — groups there address another buffer', () => {
    const nonIndexed = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    expect(nonIndexed.index).toBeNull();
    const assignment = materialAssignmentOf(twoMaterialMeshData().attributeKey, [null, null]);
    const materials = hydrated(2);

    expect(Array.isArray(resolveMeshMaterial(nonIndexed, assignment, materials)!.material)).toBe(
      false,
    );
    expect(meshMaterialRefusal(nonIndexed, assignment, materials)).toMatch(/NOT INDEXED/);
  });

  it('a 1-length array has no constructor — over a table of one, or of four', () => {
    const materials = hydrated(8);

    // One slot declared.
    const uniform = getForRead(
      boxGeometryRef([1, 1, 1], mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate')),
    )!;
    const oneSlot = materialAssignmentOf(null, [null]);
    expect(Array.isArray(resolveMeshMaterial(uniform, oneSlot, materials)!.material)).toBe(false);
    expect(meshMaterialRefusal(uniform, oneSlot, materials)).toBeNull();

    // Four slots declared, one of them used. The table is wide; the ASSIGNMENT is not.
    const fourSlotsOneUsed = materialAssignmentOf(
      mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate'),
      [null, null, null, null],
    );
    expect(Array.isArray(resolveMeshMaterial(uniform, fourSlotsOneUsed, materials)!.material)).toBe(
      false,
    );
    expect(meshMaterialRefusal(uniform, fourSlotsOneUsed, materials)).toBeNull();
  });
});

describe('#651 the single material is the one the faces USE', () => {
  it('a mesh whose every face sits on slot 1 draws slot 1, and both roads say so', () => {
    // The two roads have to agree about what this mesh is made of. The read road answers
    // the lowest USED slot; a render road answering `materials[0]` would draw the other
    // material with nothing reported, and the built layout would say `materialIndex: 1`
    // while a single material ignored it. Measured before the fix: groups [{0,36,1}],
    // read road slot 1, render road slot 0, refusal null.
    const indices = new Int32Array(12);
    indices.fill(1);
    const data = boxFromFaceIndices(indices);
    const slots = objectSlotsOf(null, data);
    const assignment = materialAssignmentOf(data.attributeKey, slots);
    const geometry = getForRead(data.geometry)!;
    const materials = hydrated(2);

    // ONE used slot, so this is the single-material arm and not the array one.
    expect(geometry.groups.map((g) => g.materialIndex)).toEqual([1]);
    const draw = resolveMeshMaterial(geometry, assignment, materials);
    expect(Array.isArray(draw!.material)).toBe(false);
    expect(draw!.material).toBe(materials[1]);
    // The read road's answer, on the same assignment — the agreement is the property.
    expect(primaryMaterial(assignment)).toBe(slots[1]);
    expect(meshMaterialRefusal(geometry, assignment, materials)).toBeNull();
  });

  it('falls back to slot 0 when the table reaches further than the caller hydrated', () => {
    // A slot past the end has no material, and an undefined one draws in three.js's
    // default white. The cap that produces this state reports separately.
    const indices = new Int32Array(12);
    indices.fill(3);
    const data = boxFromFaceIndices(indices, [null, null, null, null]);
    const assignment = materialAssignmentOf(data.attributeKey, objectSlotsOf(null, data));
    const geometry = getForRead(data.geometry)!;
    const materials = hydrated(2);

    expect(resolveMeshMaterial(geometry, assignment, materials)!.material).toBe(materials[0]);
  });
});

describe('#638 resolveMeshMaterial — the contract at its edges', () => {
  it('a NULL geometry answers "nothing draws" instead of throwing', () => {
    // `getForAttach` returns null on an ordinary cache miss, and both callers branch on it
    // AFTER their hooks — so the natural placement calls this with a null geometry. The
    // answer is in the contract rather than in placement discipline.
    const assignment = materialAssignmentOf(twoMaterialMeshData().attributeKey, [null, null]);
    expect(resolveMeshMaterial(null, assignment, hydrated(2))).toBeNull();
    expect(meshMaterialRefusal(null, assignment, hydrated(2))).toBeNull();
  });

  it('the geometry it reads IS the geometry it hands back, by identity', () => {
    // The coverage argument is about the instance the mesh MOUNTS. Returning the pair is
    // what makes "the resolver read one geometry and the mesh drew another" unconstructible
    // rather than merely unlikely — the caller would have to say so in its own JSX.
    const data = twoMaterialMeshData();
    const geometry = getForRead(data.geometry)!;
    const draw = resolveMeshMaterial(
      geometry,
      materialAssignmentOf(data.attributeKey, objectSlotsOf(null, data)),
      hydrated(8),
    );
    expect(draw!.geometry).toBe(geometry);
  });

  it('an EMPTY material table is refused at runtime, in the tier nothing typechecks', () => {
    // `vitest` transpiles through esbuild and checks no types; `npm run typecheck` excludes
    // test files. Both standing gates are blind to the same wrong call site, so the refusal
    // has to be a runtime one — an undefined material draws in three.js's default white,
    // which is plausible and silent.
    const assignment = materialAssignmentOf(null, [null]);
    expect(() => resolveMeshMaterial(new THREE.BoxGeometry(1, 1, 1), assignment, [])).toThrow(
      /material table is empty/,
    );
  });
});

describe('#638 who may speak of a material array', () => {
  // Counted EXACTLY and registered by role, for the reason the sibling censuses give: the
  // failure is the set GROWING one quiet module at a time until the coverage argument is
  // true of one door out of four. The property itself is pinned independently of any door
  // by the live-scene coverage walk — ask the scene, do not count the doors — but a second
  // minter should still cost someone an argument.
  const ARRAY_SPEAKERS: Record<string, string> = {
    'src/app/resolveMeshMaterial.ts': 'MINTS one — the only place that may',
    'src/app/resolveMeshUVSpace.ts':
      'READS one, array-aware by construction (`Array.isArray(mesh.material) ? … : [ … ]`)',
    'src/viewport/SceneFromDAG.tsx':
      'READS one on the glTF road, array-aware by declared type — and now also the two ' +
      'components that hand a resolved pair to a <mesh>',
  };

  it('exactly three production modules are typed to hold a material array', () => {
    const files = sourceFiles();
    const found = files
      .filter(([, src]) => /\bMaterial\s*\[\s*\]/.test(stripComments(src)))
      .map(([path]) => path)
      .sort();

    // `examined` travels with `found` so a walk that stopped descending cannot report a
    // clean closed set over a smaller repo.
    expect({ examined: files.length, found }).toEqual({
      examined: files.length,
      found: Object.keys(ARRAY_SPEAKERS).sort(),
    });
    expect(files.length).toBeGreaterThan(500);
  });

  it('the resolution function is called from exactly the two mesh components', () => {
    const files = sourceFiles();
    const callers = files
      .filter(([path, src]) => {
        if (path === 'src/app/resolveMeshMaterial.ts') return false; // where it is defined
        return /\bresolveMeshMaterial\s*\(/.test(stripComments(src));
      })
      .map(([path]) => path);

    expect({ examined: files.length, callers }).toEqual({
      examined: files.length,
      callers: ['src/viewport/SceneFromDAG.tsx'],
    });
  });

  // 🔴 THE INVERSE CENSUS — the one this phase actually needs (#638, ns-1b step 9).
  //
  // The census above counts array PRODUCERS. A phase that puts arrays on the DAG road has
  // the opposite exposure: a reader that treats a mesh's `material` as a single object does
  // not throw. It returns a plausible wrong answer, which is the shape that gets relied on.
  //
  // The measured instance, and the reason this gate exists rather than a note: the repo's
  // standing "what material is on screen" probe read
  // `((target as THREE.Mesh).material as THREE.Material) ?? null`. An array is truthy, so
  // the `?? null` never fired, every field downstream came back `null`/`false`, and a
  // null-valued material report is indistinguishable from an ordinary async gap — in the
  // one instrument the whole browser tier reads material through.
  //
  // What is gated is the exact shape that produced it: casting a three.js `.material` read
  // to a BARE single material type. A cast is how the union gets discarded silently; a
  // branch (`Array.isArray(…)`) and an array-aware declared type both survive it.
  const SINGLE_MATERIAL_CASTS: Record<string, string> = {
    'src/app/Gizmo.tsx':
      'a LINE the gizmo constructs itself and disposes — never a DAG mesh, and a Line has ' +
      'no group layout to disagree with',
  };

  it('no production site casts a three.js `.material` read to a bare single material', () => {
    const files = sourceFiles();
    // `as THREE.Material)` / `as Material)` — and NOT `as THREE.Material | THREE.Material[]`,
    // which is the array-aware form the widened probe now uses.
    const cast = /\.material\s+as\s+(?:THREE\.)?Material\s*(?!\s*\|)/;
    const found = files
      .filter(([, src]) => cast.test(stripComments(src)))
      .map(([path]) => path)
      .sort();

    expect({ examined: files.length, found }).toEqual({
      examined: files.length,
      found: Object.keys(SINGLE_MATERIAL_CASTS).sort(),
    });
  });

  // 🔴 AND THE CAP IS PINNED AGAINST ITS OWN HOOK COUNT (#638, D5).
  //
  // `useSlotMaterials` calls `usePrimitiveMaterial` a FIXED number of times, written out
  // rather than looped, because a hook count that varies with data is the one thing React
  // forbids. That makes the module constant and the number of call sites two spellings of
  // one fact — and the sibling reach gate counts the CALLS, so raising the constant alone
  // moves nothing it can see. A table of ten against eight hydrated materials then leaves
  // coverage short and degrades loudly rather than drawing wrong, but the degradation would
  // be for a reason nobody chose.
  it('the slot cap equals the number of hooks written out for it', () => {
    const [, src] = sourceFiles().find(([p]) => p === 'src/app/material/useSlotMaterials.ts')!;
    const body = stripComments(src);
    const calls = body.match(/usePrimitiveMaterial\s*\(/g) ?? [];
    const declared = body.match(/MAX_MATERIAL_SLOTS\s*=\s*(\d+)/);
    expect(declared).not.toBeNull();
    expect(calls.length).toBe(Number(declared![1]));
    expect(calls.length).toBe(8);
  });

  it('sees the shape it claims to see, in both directions', () => {
    const cast = /\.material\s+as\s+(?:THREE\.)?Material\s*(?!\s*\|)/;
    // The exact line this phase found lying, before it was widened.
    expect(
      cast.test(`const mat = ((target as THREE.Mesh).material as THREE.Material) ?? null;`),
    ).toBe(true);
    // And the widened one, which keeps the union and therefore keeps the question askable.
    expect(
      cast.test(
        `const raw = (target as THREE.Mesh).material as THREE.Material | THREE.Material[] | null;`,
      ),
    ).toBe(false);
    // A branch is not a cast, and never was the failure.
    expect(cast.test(`Array.isArray(mesh.material) ? mesh.material : [mesh.material]`)).toBe(false);
  });
});
