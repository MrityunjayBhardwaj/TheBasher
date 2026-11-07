// #1829 — the drawn world read. The renderer writes a constraint's result into the constrained
// object's own transform and draws its children inside it; this read must land where they are drawn,
// while the input read (what constraints read) stays without any ancestor's constraints.
//
// The oracle is a real three.js tree built the way `ConstrainedR` builds it: each aimed object takes
// the aim `resolveTrackTo` derives, and three multiplies the nesting. The live app is compared in the
// e2e observation; the fixture of the first case is the one measured in the app on #1829.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { worldParentOf } from '../core/dag/worldChildren';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { makeSplitCube } from '../test-utils/splitCube';
import { withIds } from '../test-utils/curvePoints';
import { resolveCameraPoseAt } from './activeCamera';
import { resolveDrawnParentWorldMatrix, resolveDrawnWorldTransform } from './drawnWorldTransform';
import { resolveConstraintRotation } from './nodeConstraints';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { resolveTrackTo } from './resolveTrackTo';
import { resolveParentWorldMatrix, resolveWorldTransform } from './resolveWorldTransform';
import { quaternionFromEulerDeg } from './resolvedRotation';

// Passes through, counting: how many times the drawn read applied an ancestor's aim.
const rotationCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('./nodeConstraints', async (actual) => {
  const real = await actual<typeof import('./nodeConstraints')>();
  return {
    ...real,
    resolveConstraintRotation: (...args: Parameters<typeof real.resolveConstraintRotation>) => {
      rotationCalls.count++;
      return real.resolveConstraintRotation(...args);
    },
  };
});

type V3 = [number, number, number];

const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };
const BOX = 'n_box';
const SCENE = 'n_scene';

beforeAll(() => registerAllNodes());

type Step = object | ((s: DagState) => object[]);
function apply(state: DagState, ...ops: Step[]): DagState {
  for (const op of ops) {
    const each = typeof op === 'function' ? op(state) : [op];
    for (const o of each) state = applyOp(state, o as never).next;
  }
  return state;
}
/** #1823 — `child` in the scene's own list, unless it is listed already: parenting is not
 *  membership, so a child hung below the scene is a member of it too. */
const member =
  (child: string) =>
  (s: DagState): object[] => {
    const list = s.nodes[SCENE].inputs.children;
    const refs = (Array.isArray(list) ? list : list ? [list] : []) as { node: string }[];
    return refs.some((r) => r.node === child)
      ? []
      : [
          {
            type: 'connect',
            from: { node: child, socket: 'out' },
            to: { node: SCENE, socket: 'children' },
          },
        ];
  };
// #1824 — under the scene a child is on the scene's list; under an object it names that object
// through its parent input, and (#1823) is a member of the scene as well.
const hang = (child: string, parent: string): Step =>
  parent === SCENE
    ? member(child)
    : (s: DagState) => [
        {
          type: 'connect',
          from: { node: parent, socket: 'world' },
          to: { node: child, socket: 'parent' },
        },
        ...member(child)(s),
      ];
const trackTo = (id: string, target: string, params: object) => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'TrackTo',
  params: { target, ...params },
});
const setPosition = (nodeId: string, value: V3) => ({
  type: 'setParam',
  nodeId,
  paramPath: 'position',
  value,
});

/** A curve Object over its CurveData, from (5, 0, 0) to (9, 0, 0). Hang it to give it a world. */
const curveOps = () => [
  {
    type: 'addNode',
    nodeId: 'crv_data',
    nodeType: 'CurveData',
    params: {
      points: withIds([
        [5, 0, 0],
        [9, 0, 0],
      ]),
      closed: false,
      resolution: 32,
    },
  },
  { type: 'addNode', nodeId: 'crv', nodeType: 'Object', params: {} },
  {
    type: 'connect',
    from: { node: 'crv_data', socket: 'out' },
    to: { node: 'crv', socket: 'data' },
  },
];

/** The fixture measured on #1829: the default cube with a child at (0, 2, −3), aimed at (6, 2, 1). */
function aimedCubeWithChild(cube: V3 = [0, 0, 0]): DagState {
  let s = apply(buildDefaultDagState(), setPosition(BOX, cube));
  s = makeSplitCube(s, { objectId: 'kid', position: [0, 2, -3] }).state;
  return apply(s, hang('kid', BOX), trackTo('tt', BOX, { aimNode: '', aimPoint: [6, 2, 1] }));
}

function obj(position: V3, rotationDeg: V3 = [0, 0, 0], parent?: THREE.Object3D): THREE.Object3D {
  const o = new THREE.Object3D();
  o.position.set(...position);
  o.quaternion.fromArray(quaternionFromEulerDeg(rotationDeg));
  parent?.add(o);
  return o;
}

/** The world matrix three.js composes for `o`, as it does for the drawn tree. */
function worldOf(o: THREE.Object3D): number[] {
  o.updateWorldMatrix(true, false);
  return o.matrixWorld.toArray();
}

function expectMatrix(got: readonly number[] | undefined, want: readonly number[]) {
  expect(got).toBeDefined();
  want.forEach((x, i) => expect(got![i], `element ${i}`).toBeCloseTo(x, 9));
}

const forwardOf = (q: readonly number[]) =>
  new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]));

describe('#1829 — the child of an aimed object reads where it is drawn', () => {
  it('the measured case: drawn (2.195, 2.837, 0.366), and the input read keeps (0, 2, −3)', () => {
    const s = aimedCubeWithChild();
    const drawn = resolveDrawnWorldTransform(s, 'kid', CTX)!;
    expect(drawn.position[0]).toBeCloseTo(2.195, 3);
    expect(drawn.position[1]).toBeCloseTo(2.837, 3);
    expect(drawn.position[2]).toBeCloseTo(0.366, 3);
    expect(resolveWorldTransform(s, 'kid', CTX)!.position).toEqual([0, 2, -3]);
  });

  it('equals the tree three.js composes, away from the origin', () => {
    const s = aimedCubeWithChild([1, 0, 0]);
    const aim = resolveTrackTo([1, 0, 0], [6, 2, 1], [0, 1, 0], 0)!;
    const kid = obj([0, 2, -3], [0, 0, 0], obj([1, 0, 0], aim));
    expectMatrix(resolveDrawnWorldTransform(s, 'kid', CTX)?.matrix, worldOf(kid));
  });

  it('the parent read carries the aim, where the input read has an identity parent (null)', () => {
    const s = aimedCubeWithChild();
    const aim = resolveTrackTo([0, 0, 0], [6, 2, 1], [0, 1, 0], 0)!;
    expect(resolveParentWorldMatrix(s, 'kid', CTX)).toBeNull();
    expectMatrix(
      resolveDrawnParentWorldMatrix(s, 'kid', CTX)?.toArray(),
      worldOf(obj([0, 0, 0], aim)),
    );
  });

  it('an aimed grandparent reaches through a plain parent', () => {
    let s = apply(buildDefaultDagState(), setPosition(BOX, [1, 0, 0]));
    s = makeSplitCube(s, { objectId: 'mid', position: [0, 1, 0], rotation: [0, 30, 0] }).state;
    s = makeSplitCube(s, { objectId: 'kid', position: [0, 0, 2] }).state;
    s = apply(s, hang('mid', BOX), hang('kid', 'mid'));
    s = apply(s, trackTo('tt', BOX, { aimNode: '', aimPoint: [6, 2, 1] }));
    const aim = resolveTrackTo([1, 0, 0], [6, 2, 1], [0, 1, 0], 0)!;
    const kid = obj([0, 0, 2], [0, 0, 0], obj([0, 1, 0], [0, 30, 0], obj([1, 0, 0], aim)));
    expectMatrix(resolveDrawnWorldTransform(s, 'kid', CTX)?.matrix, worldOf(kid));
  });

  it('two aimed levels compose as the renderer nests them', () => {
    let s = apply(buildDefaultDagState(), setPosition(BOX, [1, 0, 0]));
    s = makeSplitCube(s, { objectId: 'mid', position: [0, 1, 0] }).state;
    s = makeSplitCube(s, { objectId: 'kid', position: [0, 0, 2] }).state;
    s = apply(
      s,
      hang('mid', BOX),
      hang('kid', 'mid'),
      trackTo('tt', BOX, { aimNode: '', aimPoint: [6, 2, 1] }),
      trackTo('tt2', 'mid', { aimNode: '', aimPoint: [-4, 3, 0] }),
    );
    // Each level takes what `ConstrainedR` writes on it: the very rotation the resolver returns.
    const top = obj([1, 0, 0], resolveConstraintRotation(s, BOX, CTX)!);
    const mid = obj([0, 1, 0], resolveConstraintRotation(s, 'mid', CTX)!, top);
    const kid = obj([0, 0, 2], [0, 0, 0], mid);
    expectMatrix(resolveDrawnWorldTransform(s, 'kid', CTX)?.matrix, worldOf(kid));
  });

  it('an aimed Group turns about its pivot', () => {
    const s = apply(
      buildDefaultDagState(),
      {
        type: 'addNode',
        nodeId: 'grp',
        nodeType: 'Group',
        params: { position: [1, 0, 0], pivot: [0, 1, 0] },
      },
      hang('grp', SCENE),
      hang(BOX, 'grp'),
      setPosition(BOX, [0, 2, -3]),
      trackTo('tt', 'grp', { aimNode: '', aimPoint: [6, 2, 1] }),
    );
    // Taken from the resolver, which is what `ConstrainedR` writes: the aim starts at the group's
    // world origin, which its pivot has moved off `position`.
    const aim = resolveConstraintRotation(s, 'grp', CTX)!;
    const inner = obj([0, -1, 0], [0, 0, 0], obj([1, 0, 0], aim));
    expectMatrix(
      resolveDrawnWorldTransform(s, BOX, CTX)?.matrix,
      worldOf(obj([0, 2, -3], [0, 0, 0], inner)),
    );
  });

  it('a quaternion-mode parent is aimed all the same', () => {
    const s = apply(aimedCubeWithChild(), {
      type: 'setParam',
      nodeId: BOX,
      paramPath: 'rotationMode',
      value: 'quaternion',
    });
    expect(resolveDrawnWorldTransform(s, 'kid', CTX)!.position[0]).toBeCloseTo(2.195, 3);
  });

  it('a parent on a Follow-Path carries its child to the path', () => {
    let s = makeSplitCube(buildDefaultDagState(), { objectId: 'kid', position: [0, 2, 0] }).state;
    s = apply(s, hang('kid', BOX), ...curveOps(), hang('crv', SCENE), {
      type: 'addNode',
      nodeId: 'fp',
      nodeType: 'FollowPath',
      params: { target: BOX, curve: 'crv', evalTime: 0 },
    });
    const drawn = resolveDrawnWorldTransform(s, 'kid', CTX)!.position;
    drawn.forEach((x, i) => expect(x, `axis ${i}`).toBeCloseTo([5, 2, 0][i], 6));
    expect(resolveWorldTransform(s, 'kid', CTX)!.position[0]).toBeCloseTo(0, 9);
  });

  it('a muted constraint turns nothing, and an unaimed parent reads the same on both roads', () => {
    let s = aimedCubeWithChild();
    s = apply(s, { type: 'setParam', nodeId: 'tt', paramPath: 'mute', value: true });
    expect(resolveDrawnWorldTransform(s, 'kid', CTX)!.matrix).toEqual(
      resolveWorldTransform(s, 'kid', CTX)!.matrix,
    );
    expect(resolveDrawnParentWorldMatrix(s, 'kid', CTX)).toBeNull();
  });

  // #1824 — a child names its one parent through its parent input, so it can no longer be held by
  // two: naming a second parent takes it off the aimed cube, and the read follows the new one.
  it('a node given a second parent hangs from that one alone, unaimed', () => {
    let s = aimedCubeWithChild();
    s = makeSplitCube(s, { objectId: 'other', position: [40, 0, 0] }).state;
    s = apply(s, hang('kid', 'other'), hang('other', SCENE));
    expect(worldParentOf(s, 'kid')).toBe('other');
    const drawn = resolveDrawnWorldTransform(s, 'kid', CTX)!.position;
    expect(drawn).toEqual([40, 2, -3].map((v) => expect.closeTo(v, 6)));
    const parent = resolveDrawnParentWorldMatrix(s, 'kid', CTX)!;
    expect(new THREE.Vector3().setFromMatrixPosition(parent).x).toBeCloseTo(40, 9);
    expect(parent.elements[0]).toBeCloseTo(1, 9);
  });
});

describe('#1829 — what each road leaves alone', () => {
  it('the node read takes its own transform: its own aim is folded by the readers that may', () => {
    const s = aimedCubeWithChild();
    expect(resolveDrawnWorldTransform(s, BOX, CTX)!.matrix).toEqual(
      resolveWorldTransform(s, BOX, CTX)!.matrix,
    );
  });

  it('aiming at your own child, the one true cycle, keeps the input read for the aim', () => {
    let s = apply(buildDefaultDagState(), setPosition(BOX, [0, 0, 0]));
    s = makeSplitCube(s, { objectId: 'kid', position: [3, 0, 0] }).state;
    s = apply(s, hang('kid', BOX), trackTo('tt', BOX, { aimNode: 'kid', aimPoint: [0, 0, 0] }));
    // The aim reads the child with the parent un-aimed, as it did before the drawn read existed.
    const aim = resolveConstraintRotation(s, BOX, CTX)!;
    expect(aim).toEqual(resolveTrackTo([0, 0, 0], [3, 0, 0], [0, 1, 0], 0));
    // And the child reads back under the parent that aim produced, which is where it is drawn.
    const kid = obj([3, 0, 0], [0, 0, 0], obj([0, 0, 0], aim));
    expectMatrix(resolveDrawnWorldTransform(s, 'kid', CTX)?.matrix, worldOf(kid));
  });

  it('a Track-To aimed at the child of an aimed object still reads the child un-aimed', () => {
    // KNOWN GAP, by the rule that a constraint reads its inputs without ancestors' constraints: it
    // aims at (0, 2, −3), not at where the child is drawn. The stack views (#1805) lift this.
    let s = aimedCubeWithChild();
    s = makeSplitCube(s, {
      objectId: 'watcher',
      position: [-5, 0, 0],
      connectTo: { node: SCENE, socket: 'children' },
    }).state;
    s = apply(s, trackTo('tt2', 'watcher', { aimNode: 'kid', aimPoint: [0, 0, 0] }));
    expect(resolveConstraintRotation(s, 'watcher', CTX)).toEqual(
      resolveTrackTo([-5, 0, 0], [0, 2, -3], [0, 1, 0], 0),
    );
  });

  it('a Follow-Path whose curve hangs from the follower resolves, it does not loop', () => {
    let s = makeSplitCube(buildDefaultDagState(), { objectId: 'kid', position: [0, 2, 0] }).state;
    s = apply(s, hang('kid', BOX), ...curveOps(), hang('crv', BOX), {
      type: 'addNode',
      nodeId: 'fp',
      nodeType: 'FollowPath',
      params: { target: BOX, curve: 'crv', evalTime: 0 },
    });
    expect(() => resolveDrawnWorldTransform(s, 'kid', CTX)).not.toThrow();
    expect(resolveDrawnWorldTransform(s, 'kid', CTX)).not.toBeNull();
  });
});

describe('#1829 — a camera under an aimed object', () => {
  function cameraUnderAimedCube(camPos: V3 = [0, 2, -3]): DagState {
    let s = apply(buildDefaultDagState(), setPosition(BOX, [1, 0, 0]));
    s = makeSplitCamera(s, { objectId: 'cam', position: camPos }).state;
    s = apply(s, hang('cam', BOX), trackTo('tt', BOX, { aimNode: '', aimPoint: [6, 2, 1] }));
    return s;
  }

  it('the world read and the camera pose both turn with the parent', () => {
    const s = cameraUnderAimedCube();
    const aim = resolveTrackTo([1, 0, 0], [6, 2, 1], [0, 1, 0], 0)!;
    const want = new THREE.Vector3().setFromMatrixPosition(
      new THREE.Matrix4().fromArray(worldOf(obj([0, 2, -3], [0, 0, 0], obj([1, 0, 0], aim)))),
    );
    const read = resolveDrawnWorldTransform(s, 'cam', CTX)!.position;
    const pose = resolveCameraPoseAt(s, 'cam', 0).position;
    [want.x, want.y, want.z].forEach((x, i) => {
      expect(read[i], `read axis ${i}`).toBeCloseTo(x, 9);
      expect(pose[i], `pose axis ${i}`).toBeCloseTo(x, 9);
    });
  });

  it('a camera with its own Track-To under an aimed object still frames its target', () => {
    const s = apply(
      cameraUnderAimedCube(),
      trackTo('camtt', 'cam', { aimNode: '', aimPoint: [-3, 4, 2] }),
    );
    const pose = resolveCameraPoseAt(s, 'cam', 0);
    const toTarget = new THREE.Vector3(-3, 4, 2)
      .sub(new THREE.Vector3(...pose.position))
      .normalize();
    const forward = forwardOf(pose.quaternion);
    expect(forward.distanceTo(toTarget)).toBeLessThan(1e-9);
  });
  it('a camera on a Follow-Path under an aimed object stays on its path', () => {
    const s = apply(cameraUnderAimedCube(), ...curveOps(), hang('crv', SCENE), {
      type: 'addNode',
      nodeId: 'fp',
      nodeType: 'FollowPath',
      params: { target: 'cam', curve: 'crv', evalTime: 0 },
    });
    const pose = resolveCameraPoseAt(s, 'cam', 0);
    pose.position.forEach((x, i) => expect(x, `axis ${i}`).toBeCloseTo([5, 0, 0][i], 9));
  });

  it("a driver on the parent's aim that reads the aimed camera below it does not loop", () => {
    // The driver reads the camera through the evaluated transform, which takes the camera's own
    // aim, which reads the drawn parent, which applies the parent's aim: the driver again.
    const s = apply(
      cameraUnderAimedCube(),
      trackTo('camtt', 'cam', { aimNode: '', aimPoint: [-3, 4, 2] }),
      {
        type: 'addNode',
        nodeId: 'drv',
        nodeType: 'ParamDriver',
        params: {
          target: 'tt',
          paramPath: 'roll',
          blendMode: 'replace',
          order: 0,
          sourceTransform: { node: 'cam', channel: 'rx' },
        },
      },
    );
    // Without a guard this recurses until the stack overflows, and the driver road swallows that as
    // an unevaluable driver: nothing throws, so count the applications instead.
    for (const read of [
      () => resolveCameraPoseAt(s, 'cam', 0),
      () => resolveDrawnWorldTransform(s, 'cam', CTX),
      () => resolveEvaluatedTransform(s, 'cam', CTX),
    ]) {
      rotationCalls.count = 0;
      expect(read).not.toThrow();
      expect(rotationCalls.count).toBeLessThan(10);
    }
  });
});

// A world read's callers: which road each takes is decided, per caller, on #1829. The input road is
// for what a constraint reads its inputs through (and for "is it in the scene at all", which both
// roads answer alike). A new reader is meant to land on the drawn road; this reds when one lands on
// the input road unlisted, where it would read the child of an aimed object where it is not drawn.
describe('#1829 — the census of world readers', () => {
  const INPUT_ROAD: Record<string, number> = {
    'src/agent/mutators/builders/constrain.ts': 1, // does it have a place: null or not
    'src/app/constraintStack.ts': 2, // does it have a place: null or not
    'src/app/curveSampleSource.ts': 1, // a Follow-Path's curve
    'src/app/geometrySampleSource.ts': 2, // a driver's terrain and query point
    'src/app/gltfNodeWorld.ts': 1, // a Track-To's aim at a bone
    // Keep-place: it refuses a constrained ancestor (`constrainedAtOrAbove`), so where it reads the
    // two roads agree. It moves to the drawn road when that refusal goes.
    'src/app/keepPlaceReparent.ts': 1,
    'src/app/nodeConstraints.ts': 5, // a constraint's origin, target and parent
    'src/app/rigIndex.ts': 2, // the armature world, read by a Track-To's aim at a bone
  };
  const DRAWN_ROAD: Record<string, number> = {
    'src/app/CurvePointHandles.tsx': 1,
    'src/app/Gizmo.tsx': 4,
    'src/app/activeCamera.ts': 2,
    'src/app/asset/fitMotionPathScale.ts': 1,
    'src/app/boot.ts': 1,
    'src/app/cameraTrackTo.ts': 2,
    'src/app/lightAim.ts': 1,
    'src/app/skeletonObjects.ts': 1,
    'src/viewport/BoxSelectController.tsx': 1,
  };
  const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  function callCounts(callee: RegExp): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [path, text] of Object.entries(sources)) {
      if (
        /\.test\.tsx?$|\/tmp-|\/spike\/|\/resolveWorldTransform\.ts$|\/drawnWorldTransform\.ts$/.test(
          path,
        )
      ) {
        continue;
      }
      const code = text
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      const n = (code.match(callee) ?? []).length;
      if (n > 0) out[path.replace(/^\//, '')] = n;
    }
    return out;
  }

  it('the input road is taken only where listed', () => {
    expect(callCounts(/\bresolve(?:WorldTransform|ParentWorldMatrix)\(/g)).toEqual(INPUT_ROAD);
  });

  it('the drawn road is taken where listed', () => {
    expect(callCounts(/\bresolveDrawn(?:WorldTransform|ParentWorldMatrix)\(/g)).toEqual(DRAWN_ROAD);
  });
});
