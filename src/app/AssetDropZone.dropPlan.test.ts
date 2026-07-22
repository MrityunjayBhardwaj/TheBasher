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

  it('CONTROL — a plain library asset WITH a scene builds catalog ops into that scene (the no-scene branch is not vacuously always-taken)', () => {
    const plan = planCatalogAssetDrop(stateWithScene('n_scene_42'), 'library/rock');
    expect(plan.kind).toBe('ops');
    // Narrow for the type checker, then assert the ops actually target the scene.
    if (plan.kind !== 'ops') throw new Error('expected ops');
    // The last op connects the new group into the scene node — proof the resolved
    // sceneNodeId flowed through, i.e. the happy path did NOT fall into no-scene.
    const lastConnect = plan.ops.at(-1);
    expect(lastConnect).toMatchObject({
      type: 'connect',
      to: { node: 'n_scene_42', socket: 'children' },
    });
  });
});
