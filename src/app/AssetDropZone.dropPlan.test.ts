// planCatalogAssetDrop — the pure decision behind a Library → viewport drop.
//
// Its reason to exist is the "no scene to drop into" case: before this, that
// path was a silent `console.warn` and the dropped asset simply vanished. The
// decision is lifted out of the DOM handler so the swallow is now a testable
// outcome (`kind:'no-scene'`) the component turns into a warn toast (V38 — a
// drop that lands nowhere must be surfaced, never swallowed).

import { describe, expect, it } from 'vitest';
import type { DagState } from '../core/dag/state';
import { planCatalogAssetDrop, NO_SCENE_DROP_MESSAGE } from './AssetDropZone';

function stateWithScene(sceneNodeId = 'n_scene'): DagState {
  return {
    nodes: {},
    outputs: { scene: { node: sceneNodeId, socket: 'out' } },
  } as DagState;
}

function stateWithoutScene(): DagState {
  return { nodes: {}, outputs: {} } as DagState;
}

describe('planCatalogAssetDrop', () => {
  it('reports no-scene when the project has no `scene` output (the case that used to be swallowed)', () => {
    expect(planCatalogAssetDrop(stateWithoutScene(), 'library/rock')).toEqual({ kind: 'no-scene' });
    // The surfaced text exists and is non-empty — the component notifies with it.
    expect(NO_SCENE_DROP_MESSAGE.length).toBeGreaterThan(0);
  });

  it('routes an importable file (.glb/.gltf/.bvh/.fbx) to the extension importer', () => {
    expect(planCatalogAssetDrop(stateWithScene(), 'user-imports/tree/tree.glb')).toEqual({
      kind: 'import',
      path: 'user-imports/tree/tree.glb',
    });
    expect(planCatalogAssetDrop(stateWithScene(), 'motions/walk.bvh').kind).toBe('import');
  });

  // #1307 — a path in no import format used to become a GltfAsset reading it. It now goes to the
  // extension dispatcher like any other, which refuses it by name (routeImportByExtension's own
  // row in importBvhFbx.test.ts). This is also the control that the no-scene branch above is not
  // taken for every path: the same path with a scene is routed.
  it('a path in no import format WITH a scene goes to the dispatcher, never to a model node', () => {
    expect(planCatalogAssetDrop(stateWithScene('n_scene_42'), 'library/rock')).toEqual({
      kind: 'import',
      path: 'library/rock',
    });
  });
});
