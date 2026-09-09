// #981 — A MULTI-PRIMITIVE IMPORTED CHILD MUST NOT DRAW WHAT THE ASSET CLONE DRAWS.
//
// ── WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY DOES NOT COVER ───────────────────
//
// The defect was a missing guard, not a wrong value: `ObjectMeshR` refused to attach
// buffers the mounted clone was already drawing, and `MultiMaterialMeshR` — the fork an
// Object takes the moment its slot table has two entries — reached for the same door with
// no such test. So a one-primitive imported child was correct and a two-primitive one drew
// a second mesh from the clone's own `BufferGeometry` instance.
//
// 🔴 THE LAST MILE IS BROWSER-ONLY AND IS NAMED RATHER THAN PRETENDED. Neither renderer is
// unit-mountable — `MultiMaterialMeshR` runs six unconditional texture loads through a hook
// — which is the same blind spot that component records against itself for the #638 work.
// What IS unit-observable is the pair of facts the defect needed, and both are asserted
// here: the child resolves to a CLONE-DRAWN handle, and it declares MORE THAN ONE SLOT,
// which is exactly the input on which the dispatcher takes the fork that used to be
// unguarded. The refusal itself is pinned at the door in `geometryRegistry.test.ts`.
//
// REF: src/app/geometryRegistry.ts (`getForAttach` — where the rule now lives);
//      src/viewport/SceneFromDAG.tsx (`ObjectMeshR`, `MultiMaterialMeshR`, the fork);
//      src/core/import/gltfImportChain.ts (writes `materialSlots` for >1 primitive);
//      issues #981, #389, #638, #367.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import type { EvalCtx, Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { importedChildOps } from '../test-utils/importedChildFixture';
import { registerGltfClone, unregisterGltfClone } from './asset/gltfCloneRegistry';
import { clear, drawnByAssetClone, getForAttach, getForRead } from './geometryRegistry';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';

const CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };
const RED = { base: { color: '#ff0000' } };
const BLUE = { base: { color: '#0000ff' } };

function apply(state: DagState, ops: readonly unknown[]): DagState {
  return ops.reduce<DagState>((s, op) => {
    const res = applyOp(s, op as Op);
    // A write the schema silently dropped would leave every row below asserting nothing.
    expect(res.reportable).toBeUndefined();
    return res.next;
  }, state);
}

/** The clone `GltfAssetR` mounts — the thing that is ALREADY drawing these buffers. */
function mountClone(): { clone: Group; geometry: BoxGeometry } {
  const clone = new Group();
  const geometry = new BoxGeometry(1, 1, 1);
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  mesh.name = 'Cube';
  clone.add(mesh);
  registerGltfClone('asset-a', clone);
  return { clone, geometry };
}

describe('#981 — an imported child does not draw what the asset clone draws', () => {
  let mounted: { clone: Group; geometry: BoxGeometry };

  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
    clear();
    mounted = mountClone();
  });

  // Torn down per test, so a leaked clone cannot make a later row pass by resolving a
  // handle that row believes is unreachable.
  afterEach(() => unregisterGltfClone('asset-a', mounted.clone));

  it('a MULTI-primitive child declares two slots AND resolves to a clone-drawn handle', () => {
    // Both halves matter and neither alone is the defect. Two slots is what sends the
    // Object down the multi-slot fork; clone-drawn is what makes drawing it wrong. The bug
    // was the pair, which is why the pair is what this row states.
    const state = apply(
      emptyDagState(),
      importedChildOps('child', { material: RED, materialSlots: [RED, BLUE] }),
    );
    const mesh = resolveEvaluatedMesh(state, 'child', CTX);
    expect(mesh).not.toBeNull();
    expect(mesh!.materials.slots).toHaveLength(2); // → the fork that had no guard
    expect(drawnByAssetClone(mesh!.geometry.descriptor)).toBe(true);
    // And the door refuses it, which is the fix. Asserted on the handle the RESOLVER
    // produced rather than a hand-built one, so a change to how the child mints its
    // geometry cannot leave this row testing a ref the product never makes.
    expect(getForAttach(mesh!.geometry)).toBeNull();
  });

  it('a ONE-primitive child is refused by the same rule, not by a second one', () => {
    // This case was already correct, via a guard spelled at one call site. It is asserted
    // through the SAME door so that "correct" and "correct for the same reason" stop being
    // different claims — the one-slot road silently keeping its own private guard is how
    // the two roads diverged in the first place.
    const state = apply(emptyDagState(), importedChildOps('child', { material: RED }));
    const mesh = resolveEvaluatedMesh(state, 'child', CTX);
    expect(mesh!.materials.slots).toHaveLength(1);
    expect(getForAttach(mesh!.geometry)).toBeNull();
  });

  it('the clone keeps its buffers reachable for the roads that legitimately read them', () => {
    // The counterweight, and the reason the narrowing is on ONE door. Apply-Transform bakes
    // an imported child by reading exactly these buffers; a fix that made them unreachable
    // would have traded a double draw for a broken bake, with nothing here to say so.
    const state = apply(emptyDagState(), importedChildOps('child', { material: RED }));
    const mesh = resolveEvaluatedMesh(state, 'child', CTX);
    expect(getForRead(mesh!.geometry)).toBe(mounted.geometry);
  });
});
