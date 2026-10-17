// CameraSelect — the switch picks the camera its `active` NAMES (#231 Inc 3, #1668).
//
// Pins: the ONE pick `pickCameraSelect` (a named camera → its place; a name the list does not hold,
// or none → the first camera; empty → null), the evaluator handing `evaluate` each camera's id
// (`InputDescriptor.sourceIds`), and the value side picking by id through the REAL evaluator, so
// it agrees with the id side (`selectActiveCameraNode`, H40) whatever order the cameras are wired in.
//
// REF: src/nodes/CameraSelect.ts; src/core/dag/evaluator.ts (`sourceIds`);
//      src/app/activeCamera.test.ts (the id-side mirror).

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, evaluate } from '../core/dag';
import type { DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { sourceIdsKey } from '../core/dag/types';
import { CameraSelectNode, CameraSelectParams, pickCameraSelect } from './CameraSelect';
import { registerAllNodes } from './registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import type { CameraValue, SceneObject } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function makeCamera(name: string): CameraValue {
  return {
    kind: 'PerspectiveCamera',
    position: [0, 0, 0],
    lookAt: [0, 0, 0],
    fov: 45,
    near: 0.01,
    far: 1000,
    roll: 0,
    name,
  } as unknown as CameraValue;
}

/** `evaluate` called the way the evaluator calls it: values plus who each one is. */
function evalSelect(
  active: string,
  cameras: SceneObject[] | SceneObject | undefined,
  ids?: string[],
): CameraValue | null {
  const parsed = CameraSelectParams.parse({ active });
  const inputs: Record<string, unknown> = cameras !== undefined ? { cameras } : {};
  if (ids) inputs[sourceIdsKey('cameras')] = ids;
  return CameraSelectNode.evaluate(parsed, inputs, {
    time: { frame: 0, seconds: 0, normalized: 0 },
  }) as CameraValue | null;
}
const nameOf = (v: CameraValue | null) => (v as { name?: string } | null)?.name;

describe('pickCameraSelect (the one pick)', () => {
  it('returns null for an empty list', () => {
    expect(pickCameraSelect('a', [])).toBeNull();
    expect(pickCameraSelect('', [])).toBeNull();
  });

  it('picks the named camera wherever it sits in the list', () => {
    expect(pickCameraSelect('a', ['a', 'b', 'c'])).toBe(0);
    expect(pickCameraSelect('c', ['a', 'b', 'c'])).toBe(2);
    expect(pickCameraSelect('c', ['c', 'a'])).toBe(0);
  });

  it('a name the list does not hold (deleted, unwired) or no name picks the first camera', () => {
    expect(pickCameraSelect('gone', ['a', 'b'])).toBe(0);
    expect(pickCameraSelect('', ['a', 'b'])).toBe(0);
  });
});

describe('CameraSelect evaluator', () => {
  it('undefined cameras input → null', () => {
    expect(evalSelect('a', undefined)).toBeNull();
  });

  it('empty cameras list → null', () => {
    expect(evalSelect('a', [], [])).toBeNull();
  });

  it('picks the camera `active` names, by the ids the evaluator hands over', () => {
    const cams = [makeCamera('A'), makeCamera('B'), makeCamera('C')];
    const ids = ['a', 'b', 'c'];
    expect(nameOf(evalSelect('a', cams, ids))).toBe('A');
    expect(nameOf(evalSelect('b', cams, ids))).toBe('B');
    expect(nameOf(evalSelect('c', cams, ids))).toBe('C');
  });

  it('a camera the list no longer holds picks the first (matches the id side)', () => {
    expect(nameOf(evalSelect('gone', [makeCamera('A'), makeCamera('B')], ['a', 'b']))).toBe('A');
  });

  it('single camera passed (not an array) → returned', () => {
    expect(nameOf(evalSelect('solo', makeCamera('solo'), ['solo']))).toBe('solo');
  });

  it('drops null entries WITH their ids, so the rest stay paired', () => {
    const cams = [null, makeCamera('B')] as unknown as SceneObject[];
    expect(nameOf(evalSelect('b', cams, ['a', 'b']))).toBe('B');
  });
});

describe('#1668 — through the real evaluator, the pick follows the camera, not its place', () => {
  const apply = (s: DagState, ops: Op[]) => ops.reduce((acc, op) => applyOp(acc, op).next, s);
  /** Three fused cameras wired into a switch in `order`, `active` naming `active`. */
  function wired(order: string[], active: string): DagState {
    let s = emptyDagState();
    for (const [i, id] of ['cam_a', 'cam_b', 'cam_c'].entries()) {
      s = makeSplitCamera(s, { objectId: id, position: [i * 10, 0, 0] }).state;
    }
    s = apply(s, [
      { type: 'addNode', nodeId: 'sel', nodeType: 'CameraSelect', params: { active } },
    ]);
    for (const id of order) {
      s = apply(s, [
        {
          type: 'connect',
          from: { node: id, socket: 'out' },
          to: { node: 'sel', socket: 'cameras' },
        },
      ]);
    }
    return s;
  }
  const xOf = (s: DagState) => (evaluate(s, 'sel').value as { position: number[] }).position[0];

  it('names cam_c → cam_c, in either wire order', () => {
    expect(xOf(wired(['cam_a', 'cam_b', 'cam_c'], 'cam_c'))).toBe(20);
    expect(xOf(wired(['cam_c', 'cam_a', 'cam_b'], 'cam_c'))).toBe(20);
  });

  it('taking a camera out of the list before it leaves the pick on its camera', () => {
    let s = wired(['cam_a', 'cam_b', 'cam_c'], 'cam_c');
    s = apply(s, [
      {
        type: 'disconnect',
        from: { node: 'cam_a', socket: 'out' },
        to: { node: 'sel', socket: 'cameras' },
      },
    ]);
    expect(xOf(s)).toBe(20);
  });
});
