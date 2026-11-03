// #1773 — a camera shows its held edits, as a cube does. With Auto-Key off an edit to a keyed param
// is held until it is keyed or the frame changes; before, a camera's two roads (its pose, and the
// local pose the gizmo and the inspector read) laid on its keys and nothing after, so the edit was
// held and nothing moved.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../core/dag';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { resolveCameraPoseAt } from './activeCamera';
import { cameraDataOf } from './cameraNode';
import { quaternionFromEulerDeg } from './resolvedRotation';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { useTransientEditStore } from './stores/transientEditStore';
import { clockedCtx } from './subjectClock';

beforeAll(() => registerAllNodes());
afterEach(() => {
  const st = useTransientEditStore.getState();
  for (const e of [...st.edits.values()]) st.clear(e.nodeId, e.paramPath);
});

/** The default scene, its camera's rotation and fov keyed (constant), so a held edit on either is
 *  an edit to an animated param. */
function keyedCamera(): { s: DagState; lens: string } {
  let s = buildDefaultDagState();
  const lens = cameraDataOf(s, 'n_camera')!.id;
  for (const [id, type, target, path, value] of [
    ['rk', 'KeyframeChannelVec3', 'n_camera', 'rotation', [0, 90, 0]],
    ['fk', 'KeyframeChannelNumber', lens, 'fov', 30],
  ] as const) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: id,
      nodeType: type,
      params: {
        target,
        paramPath: path,
        keyframes: [
          { time: 0, value, easing: 'linear' },
          { time: 2, value, easing: 'linear' },
        ],
      },
    } as Parameters<typeof applyOp>[1]).next;
  }
  return { s, lens };
}

const hold = (nodeId: string, path: string, value: unknown) =>
  useTransientEditStore.getState().set(nodeId, path, value);

const closeQuat = (a: readonly number[], b: readonly number[]) => {
  const dot = Math.abs(a.reduce((acc, v, i) => acc + v * b[i], 0));
  expect(dot).toBeCloseTo(1, 9);
};

describe('#1773 — a camera shows its held edits on top of its keys', () => {
  it('control: with nothing held, the keys turn and frame the camera', () => {
    const { s } = keyedCamera();
    const pose = resolveCameraPoseAt(s, 'n_camera', 0.5);
    closeQuat(pose.quaternion, quaternionFromEulerDeg([0, 90, 0]));
    expect(pose.fov).toBe(30);
  });

  it('a held rotation on the Object and a held fov on the lens win over their keys', () => {
    const { s, lens } = keyedCamera();
    hold('n_camera', 'rotation', [0, -45, 0]);
    hold(lens, 'fov', 70);
    const pose = resolveCameraPoseAt(s, 'n_camera', 0.5);
    closeQuat(pose.quaternion, quaternionFromEulerDeg([0, -45, 0]));
    expect(pose.fov).toBe(70);
  });

  it('the gizmo and inspector road shows the same held rotation and position', () => {
    const { s } = keyedCamera();
    hold('n_camera', 'rotation', [0, -45, 0]);
    hold('n_camera', 'position', [1, 2, 9]);
    const t = resolveEvaluatedTransform(s, 'n_camera', clockedCtx(0.5, 0.5))!;
    expect(t.position).toEqual([1, 2, 9]);
    t.rotation!.forEach((v, i) => expect(v).toBeCloseTo([0, -45, 0][i], 6));
  });

  it('a held edit on a name the pose does not carry adds nothing to it', () => {
    const { s } = keyedCamera();
    hold('n_camera', 'scale', [3, 3, 3]);
    expect('scale' in resolveCameraPoseAt(s, 'n_camera', 0.5)).toBe(false);
  });

  it('another node’s held edit does not reach the camera', () => {
    const { s } = keyedCamera();
    hold('n_box', 'rotation', [0, -45, 0]);
    closeQuat(
      resolveCameraPoseAt(s, 'n_camera', 0.5).quaternion,
      quaternionFromEulerDeg([0, 90, 0]),
    );
  });
});
