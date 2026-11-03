// #1640 — a keyed camera's Position row shows where the camera is, as a mesh's row does.
//
// The inspector's transform rows read `resolveTransformParam` → `resolveEvaluatedTransform`,
// which found a node by walking the scene's children. A camera hangs off `scene.camera`, never a
// child, so the read returned null and the row fell back to the typed position while the camera
// moved (observed: row 3, camera at 6 then 9).

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { resolveCameraPoseAt } from './activeCamera';
import { resolveTransformParam } from './resolveTransformParam';
import { useTransientEditStore } from './stores/transientEditStore';

beforeAll(() => registerAllNodes());

const at = (scene: number, film = scene) => ({
  time: { frame: 0, seconds: scene, normalized: 0 },
  scene,
  film,
});
const keyed = (): DagState =>
  applyOp(buildDefaultDagState(), {
    type: 'addNode',
    nodeId: 'cp',
    nodeType: 'KeyframeChannelVec3',
    params: {
      target: 'n_camera',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 2, 3], easing: 'linear' },
        { time: 4, value: [8, 2, 3], easing: 'linear' },
      ],
    },
  } as Op).next;

describe("#1640 — a keyed camera's Position row follows the camera", () => {
  it('shows the keyed position, equal to the rendered one', () => {
    const s = keyed();
    for (const t of [0, 1, 2.5, 4]) {
      const row = resolveTransformParam(s, 'n_camera', 'position', at(t));
      expect(row).toEqual(resolveCameraPoseAt(s, 'n_camera', t).position);
    }
    expect(resolveTransformParam(s, 'n_camera', 'position', at(2))?.[0]).toBeCloseTo(4, 9);
  });

  it('reads the camera on the playhead, not scene time, when the two differ', () => {
    // Scene time 1, playhead 2 (a slowed scene): a camera runs on the playhead.
    expect(resolveTransformParam(keyed(), 'n_camera', 'position', at(1, 2))?.[0]).toBeCloseTo(4, 9);
  });

  it('a held edit wins over the keys, as it does for a mesh', () => {
    const store = useTransientEditStore.getState();
    store.set('n_camera', 'position', [7, 7, 7]);
    try {
      expect(resolveTransformParam(keyed(), 'n_camera', 'position', at(2))).toEqual([7, 7, 7]);
    } finally {
      store.clearAll();
    }
  });

  it('control: an unkeyed camera shows its typed position', () => {
    const s = buildDefaultDagState();
    const typed = (s.nodes.n_camera.params as { position: number[] }).position;
    expect(resolveTransformParam(s, 'n_camera', 'position', at(2)) ?? typed).toEqual(typed);
  });
});
