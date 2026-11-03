// #1745 — the inspector judges a camera's solo where the render does: over the camera Object and
// its lens data together. It judged it per node, so soloing the camera's position silenced the
// fov channel on screen while the inspector still showed fov animating.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { resolveCameraPoseAt } from './activeCamera';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';

beforeAll(() => registerAllNodes());

const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };
const run = (s: DagState, ops: readonly Op[]): DagState => {
  for (const op of ops) s = applyOp(s, op).next;
  return s;
};
function channel(id: string, target: string, paramPath: string, value: unknown, extra = {}): Op {
  const vec = Array.isArray(value);
  return {
    type: 'addNode',
    nodeId: id,
    nodeType: vec ? 'KeyframeChannelVec3' : 'KeyframeChannelNumber',
    params: {
      target,
      paramPath,
      keyframes: [
        { time: 0, value },
        { time: 1, value },
      ],
      ...extra,
    },
  } as Op;
}
/** What the inspector row shows: the override, else the data node's base. */
const shown = (s: DagState, id: string, path: string) =>
  resolveEvaluatedParam(s, id, path, CTX)?.value ??
  (s.nodes.n_camera_data.params as Record<string, unknown>)[path];

describe('#1745 — a camera solo is judged over the Object and its lens data, as the render does', () => {
  it('a solo position on the Object silences the fov on the data: the inspector shows what renders', () => {
    const s = run(buildDefaultDagState(), [
      channel('fov', 'n_camera_data', 'fov', 50),
      channel('pos', 'n_camera', 'position', [1, 2, 3], { solo: true }),
    ]);
    const rendered = resolveCameraPoseAt(s, 'n_camera', 0).fov;
    expect(rendered).toBe(45);
    expect(shown(s, 'n_camera_data', 'fov')).toBe(rendered);
    expect(shown(s, 'n_camera', 'fov')).toBe(rendered);
  });

  it('a solo fov on the data keeps playing, in both', () => {
    const s = run(buildDefaultDagState(), [
      channel('fov', 'n_camera_data', 'fov', 50, { solo: true }),
      channel('pos', 'n_camera', 'position', [1, 2, 3]),
    ]);
    expect(resolveCameraPoseAt(s, 'n_camera', 0).fov).toBe(50);
    expect(shown(s, 'n_camera_data', 'fov')).toBe(50);
  });

  it('an older fov channel on the Object is silenced by a solo on the lens data, in both', () => {
    // Projects from before the split keyed fov on the camera Object; both reads still reach it.
    const s = run(buildDefaultDagState(), [
      channel('fov', 'n_camera', 'fov', 50),
      channel('near', 'n_camera_data', 'near', 0.5, { solo: true }),
    ]);
    const rendered = resolveCameraPoseAt(s, 'n_camera', 0).fov;
    expect(rendered).toBe(45);
    expect(shown(s, 'n_camera_data', 'fov')).toBe(rendered);
    expect(shown(s, 'n_camera', 'fov')).toBe(rendered);
  });

  it('control: with nothing soloed the fov animates in both', () => {
    const s = run(buildDefaultDagState(), [channel('fov', 'n_camera_data', 'fov', 50)]);
    expect(resolveCameraPoseAt(s, 'n_camera', 0).fov).toBe(50);
    expect(shown(s, 'n_camera_data', 'fov')).toBe(50);
    expect(shown(s, 'n_camera', 'fov')).toBe(50);
  });

  it('control: a box keeps its per-node solo (the scope widens for cameras only)', () => {
    const s = run(buildDefaultDagState(), [
      channel('sz', 'n_box', 'position', [0, 1, 0], { solo: true }),
      channel('col', 'n_box', 'visible', 1),
    ]);
    expect(resolveEvaluatedParam(s, 'n_box', 'visible', CTX)).toBeNull();
  });
});
