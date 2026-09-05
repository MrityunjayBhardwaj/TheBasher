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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import { rowDataParams, splitOps } from '../test-utils/splitKinds';
import { resolveMeshUVSpace } from './resolveMeshUVSpace';
import { buildDefaultDagState } from '../core/project/default';
import { registerGltfClone, __clearGltfCloneRegistryForTests } from './asset/gltfCloneRegistry';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from 'three';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** A baked mesh whose geometry ref points at OPFS bytes that were never primed — the
 *  registry MISS that must read as 'loading', not 'none'.
 *
 *  #388 — this was a fused `BakedMesh` node, which is the shape that no longer exists:
 *  the kind is retired and its read road is gone with it, so the fixture is the PAIR an
 *  Object + `BakedData` make. The invariant under test is unchanged and belongs to the
 *  baked AVAILABILITY CLASS, not to any one node shape — the fused node was only ever
 *  the vehicle for reaching it. Pinning it on the shape that actually exists is what
 *  keeps it a live test rather than a museum piece. */
function unprimedBakedPair(): DagState {
  let s = emptyDagState();
  for (const op of splitOps(
    'baked',
    { objectId: 'baked' },
    {
      data: {
        geometry: {
          kind: 'baked',
          key: 'baked|never-primed',
          descriptor: { kind: 'baked', hash: 'never-primed', vertexCount: 3 },
        },
        material: rowDataParams('baked').material,
      },
    },
  )) {
    s = applyOp(s, op as never).next;
  }
  return s;
}

describe('resolveMeshUVSpace — miss semantics per availability class (#405)', () => {
  it('an unprimed BAKED geometry reads as loading, never as none', () => {
    const space = resolveMeshUVSpace(unprimedBakedPair(), 'baked');
    // The bytes live in OPFS behind an async read: "not here yet" is NOT "there is none".
    // Reporting 'none' would make the panel show its empty state and stop waiting — the
    // exact silent-miss class this module was consolidated to end.
    expect(space.uvs.status).toBe('loading');
    expect(space.uvs.uvs).toBeNull();
  });

  it('🔴 #776 — a MODIFIER geometry still draws, though its corner layer cannot be lifted', () => {
    // THE ROW THE #776 CHANGE COULD HAVE BROKEN, and it covers a case none of the three UV e2e
    // specs reach: they all resolve a bare primitive or a glTF child.
    //
    // `readMeshUVs` reports two things that used to be one. The corner-domain LAYER is gathered
    // through the polygon rims, which an Array has none of in its own vertex numbering (#777),
    // so that half is now a named refusal. The ISLANDS come off the built geometry directly and
    // have never needed the layer. Before they were separated, a lift that could not produce
    // the attribute returned `none` for the whole read — the status meaning "there are
    // genuinely no UVs and waiting will not help" — and the panel would have shown its empty
    // state for a mesh whose UVs it can draw.
    const { state, objectId, dataId } = makeSplitCube(emptyDagState(), { objectId: 'cube' });
    let s = applyOp(state, {
      type: 'addNode',
      nodeId: 'arr',
      nodeType: 'ArrayModifier',
      params: { count: 3 },
    }).next;
    s = applyOp(s, {
      type: 'disconnect',
      from: { node: dataId, socket: 'out' },
      to: { node: objectId, socket: 'data' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: 'arr', socket: 'target' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'arr', socket: 'out' },
      to: { node: objectId, socket: 'data' },
    }).next;

    const space = resolveMeshUVSpace(s, objectId);
    expect(space.uvs.status).toBe('ok');
    // Three copies of a box: 36 triangles, and the island shape is asserted rather than a bare
    // 'ok' so an empty resolve cannot satisfy this.
    expect(space.uvs.uvs!.triangleCount).toBe(36);
    expect(space.uvs.uvs!.islands.length).toBeGreaterThan(0);
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

describe('resolveMeshUVSpace — a glTF mesh keeps BOTH facets once its clone mounts (#367)', () => {
  // ── WHY THIS SUITE EXISTS ────────────────────────────────────────────────────────────
  //
  // Before #367, `readGeometry` answered `elsewhere` for every glTF mesh, and this module
  // used that status to decide "read both facets off the asset clone". Two questions were
  // riding on one answer: where the UVs come from, and where the TEXTURE comes from.
  //
  // #367 made the registry resolve a glTF handle through the mounted clone, so a mounted
  // glTF mesh now reads `ok`. Only the UV half moved — glTF materials still have no data
  // half at all (#389/#605), so `resolveEvaluatedMesh` hands a glTF mesh `EMPTY_ASSIGNMENT`
  // and the registry-backed arm resolves its texture to `none`.
  //
  // 🔴 MEASURED, AND NOTHING IN THE SUITE NOTICED. With the branch still keyed on the status,
  // a mounted clone carrying a base-colour map took the registry arm and the UV editor's
  // backdrop went from `ok` with an image to `none` — 5221 tests, zero reds. That is the
  // whole reason for this file's newest rows: the fix is a one-token change that no existing
  // row can distinguish from the bug, so it needs one that can.
  afterEach(() => __clearGltfCloneRegistryForTests());

  /** A mounted clone whose `Mesh0` carries UVs and a drawable base-colour map. */
  function mountTexturedClone(): void {
    const group = new Group();
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const mesh = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ map: new Texture(canvas) }),
    );
    mesh.name = 'Mesh0';
    group.add(mesh);
    group.updateMatrixWorld(true);
    registerGltfClone('asset-1', group);
  }

  function gltfChildState(): DagState {
    let s = buildDefaultDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'gltf_child',
      nodeType: 'GltfChild',
      params: {
        childName: 'Mesh0',
        assetRef: 'asset-1',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        overridden: { position: false, rotation: false, scale: false },
      },
    } as never).next;
    return s;
  }

  it('the TEXTURE still comes from the clone, though the geometry no longer has to', () => {
    mountTexturedClone();
    const space = resolveMeshUVSpace(gltfChildState(), 'gltf_child');
    // The assertion that reds if the arm is ever re-keyed on the read's status. `none` here
    // is the measured regression, and it is a blank backdrop in the UV editor.
    expect(space.texture.status).toBe('ok');
    expect(space.texture.image).not.toBeNull();
    expect(space.uvs.status).toBe('ok');
  });

  it('and reports LOADING on both facets while the clone has not mounted', () => {
    // The other half of the same branch: unmounted, the answer must be "wait", never "none".
    // Keyed on the descriptor rather than the status, this arm is reached either way — which
    // is what makes the two rows a pair rather than one row and its accident.
    const space = resolveMeshUVSpace(gltfChildState(), 'gltf_child');
    expect(space.uvs.status).toBe('loading');
    expect(space.texture.status).toBe('loading');
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
