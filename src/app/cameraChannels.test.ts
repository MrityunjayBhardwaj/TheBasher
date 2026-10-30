// #482 — a camera's channels obey the same rules as every other node's: mute, solo, weight and
// the layered fold. The camera used to sample its own keys in a private loop that read only the
// keys, so a muted fov channel still zoomed, a weight was ignored, and two channels on one param
// resolved by scan order. Its position was worse: the pose (what renders) and the world transform
// (what the gizmo shows) read the same channel two ways and disagreed. The film's cuts had the
// same gap: muting the cut channel changed nothing on screen.
//
// Every row below runs through the resolvers the app draws with. The pose and the world
// transform must agree, not merely each be right.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { cutChannelOf, resolveCameraPoseAt, selectActiveCameraNode } from './activeCamera';
import { resolveWorldTransform } from './resolveWorldTransform';
import { buildCutOps } from './shotOps';

beforeAll(() => registerAllNodes());

const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };

const run = (s: DagState, ops: readonly Op[]): DagState => {
  for (const op of ops) s = applyOp(s, op).next;
  return s;
};

/** A held channel on the default camera: the lens and aim live on its data half, the position
 *  on the Object, which is where the app's own keying puts them. */
function channel(id: string, paramPath: string, value: unknown, extra = {}): Op {
  const vec = Array.isArray(value);
  return {
    type: 'addNode',
    nodeId: id,
    nodeType: vec ? 'KeyframeChannelVec3' : 'KeyframeChannelNumber',
    params: {
      target: paramPath === 'position' ? 'n_camera' : 'n_camera_data',
      paramPath,
      keyframes: [
        { time: 0, value },
        { time: 1, value },
      ],
      ...extra,
    },
  } as Op;
}

const fov = (s: DagState) => resolveCameraPoseAt(s, 'n_camera', 0).fov;

describe('#482 — a camera channel obeys mute, solo, weight and the fold', () => {
  it('control: an ordinary channel drives the camera', () => {
    expect(fov(run(buildDefaultDagState(), [channel('ch', 'fov', 100)]))).toBe(100);
  });

  it('a muted fov channel leaves the lens alone', () => {
    expect(fov(run(buildDefaultDagState(), [channel('ch', 'fov', 100, { mute: true })]))).toBe(45);
  });

  it('a muted position channel: what renders and what the gizmo shows agree, on the base', () => {
    const s = run(buildDefaultDagState(), [channel('ch', 'position', [50, 0, 0], { mute: true })]);
    const pose = resolveCameraPoseAt(s, 'n_camera', 0).position;
    expect(pose).toEqual([3, 2, 3]);
    const world = resolveWorldTransform(s, 'n_camera', CTX)!.position;
    world.forEach((v, i) => expect(v).toBeCloseTo(pose[i], 9));
  });

  it('a live position channel: the two agree on the keyed value too', () => {
    const s = run(buildDefaultDagState(), [channel('ch', 'position', [50, 0, 0])]);
    const pose = resolveCameraPoseAt(s, 'n_camera', 0).position;
    expect(pose).toEqual([50, 0, 0]);
    const world = resolveWorldTransform(s, 'n_camera', CTX)!.position;
    world.forEach((v, i) => expect(v).toBeCloseTo(pose[i], 9));
  });

  it('two fov channels fold by order and weight instead of the last one winning', () => {
    const s = run(buildDefaultDagState(), [
      channel('ch', 'fov', 100, { order: 0 }),
      channel('ch2', 'fov', 40, { order: 1, weight: 0.5 }),
    ]);
    expect(fov(s)).toBe(70);
  });

  it('a channel at weight 0 contributes nothing', () => {
    expect(fov(run(buildDefaultDagState(), [channel('ch', 'fov', 100, { weight: 0 })]))).toBe(45);
  });

  it('a solo channel elsewhere on the camera silences this one', () => {
    const s = run(buildDefaultDagState(), [
      channel('ch', 'fov', 100),
      channel('ch2', 'lookAt', [1, 1, 1], { solo: true }),
    ]);
    expect(fov(s)).toBe(45);
    expect(resolveCameraPoseAt(s, 'n_camera', 0).lookAt).toEqual([1, 1, 1]);
  });
});

describe('#482 — the film’s cuts obey mute and weight', () => {
  /** Two cameras and one cut to cam2 at 2 s. */
  function film(extra?: Record<string, unknown>): DagState {
    let s = makeSplitCamera(buildDefaultDagState(), {
      objectId: 'cam2',
      position: [10, 0, 0],
    }).state;
    s = run(s, buildCutOps(s, 2, 'cam2')!);
    if (!extra) return s;
    const cut = cutChannelOf(s, cutSelect(s))!;
    return run(
      s,
      Object.entries(extra).map(
        ([paramPath, value]) => ({ type: 'setParam', nodeId: cut.id, paramPath, value }) as Op,
      ),
    );
  }
  const cutSelect = (s: DagState) =>
    Object.values(s.nodes).find((n) => n.type === 'CameraSelect')!.id;
  const playing = (s: DagState) => [1, 3].map((t) => selectActiveCameraNode(s, t)?.id);
  /** The switch's own camera: what plays when no cut has a say. Inserting the switch made it
   *  cam2, so it differs from what the cut plays at 1 s and a row that ignores the cut channel's
   *  state cannot pass by accident. */
  const own = (s: DagState) => (s.nodes[cutSelect(s)].params as { active: string }).active;

  it('control: the cut plays, and the switch’s own camera is not the one before the cut', () => {
    expect(playing(film())).toEqual(['n_camera', 'cam2']);
    expect(own(film())).toBe('cam2');
  });

  it('a muted cut channel plays the switch’s own camera throughout', () => {
    const s = film({ mute: true });
    expect(playing(s)).toEqual([own(s), own(s)]);
  });

  it('a cut channel at weight 0 plays the switch’s own camera throughout', () => {
    const s = film({ weight: 0 });
    expect(playing(s)).toEqual([own(s), own(s)]);
  });

  it('a soloed channel elsewhere on the switch silences the cut channel', () => {
    const s = film();
    const solo = run(s, [
      {
        type: 'addNode',
        nodeId: 'other',
        nodeType: 'KeyframeChannelText',
        params: {
          target: cutSelect(s),
          paramPath: 'active',
          solo: true,
          keyframes: [{ time: 0, value: 'n_camera' }],
        },
      } as Op,
    ]);
    expect(playing(solo)).toEqual([own(solo), own(solo)]);
  });

  it('muting leaves the cut keys in place, so unmuting brings the cuts back', () => {
    const muted = film({ mute: true });
    const keys = (cutChannelOf(muted, cutSelect(muted))!.params as { keyframes: unknown[] })
      .keyframes;
    expect(keys.length).toBeGreaterThan(0);
  });
});

// #480 — the rest of what animates a param reaches the camera too. A strip placed on the camera
// folded nothing, because the camera pose read only its bare channels; a driver bound to a lens
// param was accepted and shown and moved nothing (#1266). Values are distinct from the base (45
// fov, [3,2,3] position) so a strip or driver that is skipped cannot read as working.
describe('#480 — strips and drivers on a camera', () => {
  /** An Action keyed at `value` on `paramPath`, placed on the camera Object by a strip. */
  function strip(paramPath: string, value: unknown, stripOver = {}): Op[] {
    return [
      {
        type: 'addNode',
        nodeId: 'act',
        nodeType: 'Action',
        params: {
          name: 'act',
          channels: [
            {
              valueType: Array.isArray(value) ? 'vec3' : 'number',
              paramPath,
              keyframes: [
                { time: 0, value },
                { time: 2, value },
              ],
            },
          ],
        },
      },
      {
        type: 'addNode',
        nodeId: 'st',
        nodeType: 'Strip',
        params: { name: 'st', action: 'act', target: 'n_camera', ...stripOver },
      },
      {
        type: 'addNode',
        nodeId: 'trk',
        nodeType: 'Track',
        params: { name: 'trk', strips: ['st'], order: 0 },
      },
    ] as Op[];
  }

  /** A driver writing the constant `value` onto the camera data's `paramPath`. */
  function driver(paramPath: string, value: number, extra = {}): Op[] {
    return [
      { type: 'addNode', nodeId: 'k', nodeType: 'Clamp', params: { min: value, max: value } },
      {
        type: 'addNode',
        nodeId: 'drv',
        nodeType: 'ParamDriver',
        params: { target: 'n_camera_data', paramPath, blendMode: 'replace', order: 0, ...extra },
      },
      { type: 'connect', from: { node: 'k', socket: 'out' }, to: { node: 'drv', socket: 'in' } },
    ] as Op[];
  }

  it('a strip on the camera drives its fov', () => {
    expect(fov(run(buildDefaultDagState(), strip('fov', 70)))).toBe(70);
  });

  it('a muted strip leaves the lens alone', () => {
    expect(fov(run(buildDefaultDagState(), strip('fov', 70, { muted: true })))).toBe(45);
  });

  it('a strip on the position: what renders and what the gizmo shows agree', () => {
    const s = run(buildDefaultDagState(), strip('position', [9, 1, 4]));
    const pose = resolveCameraPoseAt(s, 'n_camera', 0).position;
    expect(pose).toEqual([9, 1, 4]);
    const world = resolveWorldTransform(s, 'n_camera', CTX)!.position;
    world.forEach((v, i) => expect(v).toBeCloseTo(pose[i], 9));
  });

  it('a strip folds over a bare channel on the same param, as on any other node', () => {
    // Bare first, then strips: a replace strip at full influence wins.
    const s = run(buildDefaultDagState(), [channel('ch', 'fov', 100), ...strip('fov', 70)]);
    expect(fov(s)).toBe(70);
  });

  it('a driver on the camera drives its fov', () => {
    expect(fov(run(buildDefaultDagState(), driver('fov', 33)))).toBe(33);
  });

  it('a muted driver leaves the lens alone', () => {
    expect(fov(run(buildDefaultDagState(), driver('fov', 33, { mute: true })))).toBe(45);
  });
});
