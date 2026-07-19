// resolveMeshUVSpace — the ONE projection over the (mesh, material) pair (#406).
//
// What these tests exist to pin, in priority order:
//
//   1. The MISS SEMANTICS (#405). `geometryRegistry.get()` returns null for three different
//      reasons and the old two-resolver split disagreed about what that meant — the BakedMesh
//      arm read a miss as 'loading', the Object arm as 'none'. This is the regression that is
//      otherwise only reachable through an async OPFS read, so it is asserted directly here
//      rather than left to an e2e that would have to race a load to catch it.
//
//   2. The CAPABILITY REACH (#378). A split Object resolves through the shared evaluated mesh
//      rather than a node-type list, so the cube's real geometry is found via `data`.
//
//   3. PAIR COHERENCE. Both facets answer about the SAME resolved mesh — the property the
//      two independent resolvers could not structurally guarantee.
//
// The exhaustiveness gate (a new GeometryRef kind must declare its availability class or
// fail typecheck) is verified by the compiler, not here — falsified once by adding a
// hypothetical kind and observing TS2322 at the `never` branch.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import { resolveMeshUVSpace } from './resolveMeshUVSpace';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

/** A BakedMesh whose geometry ref points at OPFS bytes that were never primed — the
 *  registry MISS that must read as 'loading', not 'none'. */
function unprimedBakedMesh(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'baked',
    nodeType: 'BakedMesh',
    params: {
      geometry: {
        kind: 'baked',
        key: 'baked|never-primed',
        descriptor: { kind: 'baked', hash: 'never-primed', vertexCount: 3 },
      },
      material: {
        materialClass: 'standard',
        color: '#5af07a',
        roughness: 1,
        metalness: 0,
        opacity: 1,
        transparent: false,
        emissive: '#000000',
        emissiveIntensity: 1,
        map: null,
        normalMap: null,
        roughnessMap: null,
        metalnessMap: null,
        aoMap: null,
        emissiveMap: null,
      },
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  }).next;
  return s;
}

describe('resolveMeshUVSpace — miss semantics per availability class (#405)', () => {
  it('an unprimed BAKED geometry reads as loading, never as none', () => {
    const space = resolveMeshUVSpace(unprimedBakedMesh(), 'baked');
    // The bytes live in OPFS behind an async read: "not here yet" is NOT "there is none".
    // Reporting 'none' would make the panel show its empty state and stop waiting — the
    // exact silent-miss class this module was consolidated to end.
    expect(space.uvs.status).toBe('loading');
    expect(space.uvs.uvs).toBeNull();
  });

  it('a PROCEDURAL geometry resolves real islands (registry builds on demand)', () => {
    const { state, objectId } = makeSplitCube(emptyDagState(), { objectId: 'cube' });
    const space = resolveMeshUVSpace(state, objectId);
    // A box builds synchronously, so there is no loading window at all — asserting the
    // real island shape keeps this from passing on an empty resolve.
    expect(space.uvs.status).toBe('ok');
    expect(space.uvs.uvs!.islands).toHaveLength(6); // BoxGeometry: 6 faces, each full [0,1]
    expect(space.uvs.uvs!.triangleCount).toBe(12);
  });
});

describe('resolveMeshUVSpace — capability reach, not a node-type list (#378)', () => {
  it('a split Object reaches its geometry through the data socket', () => {
    const { state, objectId } = makeSplitCube(emptyDagState(), { objectId: 'cube' });
    // `Object` appears in no type list here — it resolves because it produces an evaluated
    // mesh. Any future kind that does the same works without editing this module.
    expect(resolveMeshUVSpace(state, objectId).uvs.status).toBe('ok');
  });

  it('a non-mesh node resolves to none on BOTH facets (identity-null, no crash)', () => {
    let s = emptyDagState();
    s = applyOp(s, { type: 'addNode', nodeId: 'empty', nodeType: 'Object', params: {} }).next;
    const space = resolveMeshUVSpace(s, 'empty');
    expect(space.uvs.status).toBe('none');
    expect(space.texture.status).toBe('none');
  });

  it('an unknown node id is none, not a throw (the seams must never throw)', () => {
    const space = resolveMeshUVSpace(emptyDagState(), 'nope');
    expect(space.uvs.status).toBe('none');
    expect(space.texture.status).toBe('none');
  });
});

describe('resolveMeshUVSpace — pair coherence', () => {
  it('both facets describe the SAME resolved mesh', () => {
    const { state, objectId } = makeSplitCube(emptyDagState(), { objectId: 'cube' });
    const space = resolveMeshUVSpace(state, objectId);
    // A cube with no albedo map: real UVs, no backdrop. The point is that ONE walk produced
    // both — the two old resolvers could disagree about the selection or its readiness
    // because nothing coupled them.
    expect(space.uvs.status).toBe('ok');
    expect(space.texture.status).toBe('none');
    expect(space.texture.image).toBeNull();
  });
});
