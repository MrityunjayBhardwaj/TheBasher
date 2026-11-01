// activeCamera — locate the scene's active camera node + read its pose.
// Drives the editor view camera (#165): boot framing + look-through adopt.

import * as THREE from 'three';
import { cameraOrientationTuple } from './cameraOrientation';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  cameraFilmCtx,
  cameraPoseForNodeId,
  cameraPoseFromPair,
  type CameraPose,
  DEFAULT_CAMERA_POSE,
  resolveActiveCameraPose,
  resolveActiveCameraPoseAt,
  resolveCameraDofAt,
  resolveCameraFrustumPose,
  resolveCameraPoseAt,
  selectActiveCameraNode,
} from './activeCamera';
import { cameraDataOf } from './cameraNode';
import { buildDefaultDagState } from '../core/project/default';
import { applyOp, emptyDagState, type DagState } from '../core/dag';
import type { Node } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { makeSplitCube } from '../test-utils/splitCube';
import { splitOps } from '../test-utils/splitKinds';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';

// buildDefaultDagState / applyOp resolve node types from the registry, which
// is populated by registerAll (a side-effecting boot step in the real app).
beforeAll(() => {
  registerAllNodes();
});

type V3 = [number, number, number];
/** #1760 — `got` is the same pose as `want`: lens fields and position exact; orientation the
 *  same rotation (q and −q are one); the derived look-at and roll close (re-derived from it). */
function expectPose(got: CameraPose | null | undefined, want: CameraPose): void {
  expect(got).toBeTruthy();
  const g = got!;
  expect({ kind: g.kind, position: g.position, fov: g.fov, near: g.near, far: g.far }).toEqual({
    kind: want.kind,
    position: want.position,
    fov: want.fov,
    near: want.near,
    far: want.far,
  });
  const dot = g.quaternion.reduce((acc, v, i) => acc + v * want.quaternion[i], 0);
  expect(Math.abs(dot), 'orientation').toBeCloseTo(1, 9);
  g.lookAt.forEach((v, i) => expect(v, `lookAt ${i}`).toBeCloseTo(want.lookAt[i], 9));
  expect(g.roll, 'roll').toBeCloseTo(want.roll, 9);
}
/** The forward (view) direction a pose's orientation gives. */
const forwardOf = (p: CameraPose): V3 => {
  const [x, y, z, w] = p.quaternion;
  const v = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(x, y, z, w));
  return [v.x, v.y, v.z];
};

describe('activeCamera — selectActiveCameraNode', () => {
  it('finds the camera node wired into scene.camera (default project)', () => {
    const state = buildDefaultDagState();
    const node = selectActiveCameraNode(state);
    expect(node).not.toBeNull();
    expect(node?.id).toBe('n_camera');
    // #387 C4 — the seed camera is split-native: the node wired into scene.camera is the
    // OBJECT (pose) half, which keeps the id `n_camera`. Its lens lives on the CameraData.
    expect(node?.type).toBe('Object');
    expect(cameraDataOf(state, 'n_camera')?.type).toBe('CameraData');
  });

  it('returns null when no scene output is declared', () => {
    expect(selectActiveCameraNode(emptyDagState())).toBeNull();
  });

  it('returns null when the scene has no camera wired', () => {
    // Build a scene with no camera connection.
    let state: DagState = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_scene',
      nodeType: 'Scene',
      params: {},
    }).next;
    state = { ...state, outputs: { scene: { node: 'n_scene', socket: 'out' } } };
    expect(selectActiveCameraNode(state)).toBeNull();
  });
});

// #231 Inc 3 — the multi-camera "active" model. A CameraSelect feeds scene.camera;
// `selectActiveCameraNode` resolves THROUGH it to the camera its `active` names (#1668: by id,
// keyframeable → cuts, each key naming its camera). A direct-wired camera (every pre-change
// project) still resolves to itself — the fallback, no migration.
describe('activeCamera — CameraSelect resolve-through (#231 Inc 3)', () => {
  /** Default project + a 2nd camera + a CameraSelect wired into scene.camera, listing
   *  [n_camera, n_cam2] in that wire order. */
  function buildMultiCamera(active = 'n_camera'): DagState {
    let state = buildDefaultDagState();
    // #387 C4 — the fused camera node type is retired; a camera is an Object posing a
    // CameraData. `position` on the Object, the lens on the data half.
    state = makeSplitCamera(state, {
      objectId: 'n_cam2',
      fov: 60,
      position: [10, 0, 0],
      lens: { lookAt: [0, 0, 0] },
    }).state;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_camsel',
      nodeType: 'CameraSelect',
      params: { active },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_camera', socket: 'out' },
      to: { node: 'n_camsel', socket: 'cameras' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_cam2', socket: 'out' },
      to: { node: 'n_camsel', socket: 'cameras' },
    }).next;
    // Single-cardinality scene.camera → this REPLACES the direct n_camera wiring,
    // which #759 now makes the caller declare rather than perform silently.
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_camsel', socket: 'out' },
      to: { node: 'n_scene', socket: 'camera' },
      replace: true,
    }).next;
    return state;
  }

  /** A third camera at x=20, wired last into the switch. */
  function withThird(state: DagState): DagState {
    let s = makeSplitCamera(state, { objectId: 'n_cam3', position: [20, 0, 0] }).state;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'n_cam3', socket: 'out' },
      to: { node: 'n_camsel', socket: 'cameras' },
    }).next;
    return s;
  }

  /** The cut channel: a text channel on `active`, each key naming a camera. */
  function withCuts(state: DagState, keys: [number, string][]): DagState {
    return applyOp(state, {
      type: 'addNode',
      nodeId: 'ch_active',
      nodeType: 'KeyframeChannelText',
      params: {
        name: 'active',
        target: 'n_camsel',
        paramPath: 'active',
        keyframes: keys.map(([time, value]) => ({ time, value, easing: 'constant' })),
      },
    }).next;
  }

  it('resolves through CameraSelect to the camera `active` names', () => {
    expect(selectActiveCameraNode(buildMultiCamera('n_camera'))?.id).toBe('n_camera');
    expect(selectActiveCameraNode(buildMultiCamera('n_cam2'))?.id).toBe('n_cam2');
  });

  it('an empty `active`, or one naming a camera the switch does not list, picks the first camera (matches the value side)', () => {
    expect(selectActiveCameraNode(buildMultiCamera(''))?.id).toBe('n_camera');
    expect(selectActiveCameraNode(buildMultiCamera('n_gone'))?.id).toBe('n_camera');
  });

  it('the resolved active camera drives the pose', () => {
    const pose = resolveActiveCameraPose(buildMultiCamera('n_cam2'));
    expect(pose.position).toEqual([10, 0, 0]);
    expect(pose.fov).toBe(60);
  });

  it('a direct-wired camera (no CameraSelect) still resolves — the fallback', () => {
    // The default project wires n_camera DIRECTLY; unchanged.
    expect(selectActiveCameraNode(buildDefaultDagState())?.id).toBe('n_camera');
  });

  it('CUTS the pose between cameras on the key (camera cut)', () => {
    const state = withCuts(buildMultiCamera(), [
      [0, 'n_camera'],
      [1, 'n_cam2'],
    ]);
    // At t=0 the live camera is n_camera ([3,2,3]); from t=1 it is n_cam2 ([10,0,0]).
    expect(resolveActiveCameraPoseAt(state, 0).position).toEqual([3, 2, 3]);
    expect(resolveActiveCameraPoseAt(state, 0.99).position).toEqual([3, 2, 3]);
    expect(resolveActiveCameraPoseAt(state, 1).position).toEqual([10, 0, 0]);
  });

  it('#1663 — cutting from the first camera to the third never shows the one wired between them', () => {
    const state = withCuts(withThird(buildMultiCamera()), [
      [0, 'n_camera'],
      [2, 'n_cam3'],
    ]);
    const seen = new Set<string | undefined>();
    for (let f = 0; f < 48; f++) seen.add(selectActiveCameraNode(state, f / 24)?.id);
    expect([...seen]).toEqual(['n_camera']);
    expect(selectActiveCameraNode(state, 2)?.id).toBe('n_cam3');
  });

  it('the STATIC selector (no seconds) ignores the cuts — editor "now"', () => {
    const state = withCuts(buildMultiCamera('n_camera'), [
      [0, 'n_camera'],
      [1, 'n_cam2'],
    ]);
    expect(selectActiveCameraNode(state)?.id).toBe('n_camera');
    expect(selectActiveCameraNode(state, 1)?.id).toBe('n_cam2');
  });

  describe('#1668 — a cut whose camera is gone is skipped (Blender: BKE_scene_camera_switch_find)', () => {
    const cuts: [number, string][] = [
      [0, 'n_camera'],
      [1, 'n_cam2'],
      [2, 'n_cam3'],
    ];
    const unwire = (s: DagState, id: string) =>
      applyOp(s, {
        type: 'disconnect',
        from: { node: id, socket: 'out' },
        to: { node: 'n_camsel', socket: 'cameras' },
      }).next;
    const at = (s: DagState) => [0, 1, 1.5, 2, 3].map((t) => selectActiveCameraNode(s, t)?.id);

    it('control: every cut plays on its own camera', () => {
      expect(at(withCuts(withThird(buildMultiCamera()), cuts))).toEqual([
        'n_camera',
        'n_cam2',
        'n_cam2',
        'n_cam3',
        'n_cam3',
      ]);
    });

    // The shot before a removed cut is never the switch's FIRST camera here: the first camera is
    // also what a cut naming a missing camera falls to, so it would pass without the skip.
    it('taking the MIDDLE camera out: the shot before runs on, the later cut keeps its camera', () => {
      const s = unwire(
        withCuts(withThird(buildMultiCamera()), [
          [0, 'n_cam3'],
          [1, 'n_cam2'],
          [2, 'n_camera'],
        ]),
        'n_cam2',
      );
      expect(at(s)).toEqual(['n_cam3', 'n_cam3', 'n_cam3', 'n_camera', 'n_camera']);
    });

    it('taking the camera of the FIRST cut out: before the first live cut, its camera holds', () => {
      const s = unwire(
        withCuts(withThird(buildMultiCamera('n_cam2')), [
          [0, 'n_camera'],
          [1, 'n_cam3'],
          [2, 'n_cam2'],
        ]),
        'n_camera',
      );
      expect(at(s)).toEqual(['n_cam3', 'n_cam3', 'n_cam3', 'n_cam2', 'n_cam2']);
    });

    it('wiring it back brings its cut back, with no key edited', () => {
      let s = unwire(withCuts(withThird(buildMultiCamera()), cuts), 'n_cam2');
      s = applyOp(s, {
        type: 'connect',
        from: { node: 'n_cam2', socket: 'out' },
        to: { node: 'n_camsel', socket: 'cameras' },
      }).next;
      expect(at(s)).toEqual(['n_camera', 'n_cam2', 'n_cam2', 'n_cam3', 'n_cam3']);
    });

    it('no cut names a listed camera: the static `active` stands', () => {
      const s = withCuts(buildMultiCamera('n_cam2'), [[0, 'n_gone']]);
      expect(selectActiveCameraNode(s, 0)?.id).toBe('n_cam2');
    });

    it('a number channel on `active` (saved before v23, never migrated) is not read as cuts', () => {
      const s = applyOp(buildMultiCamera('n_cam2'), {
        type: 'addNode',
        nodeId: 'ch_old',
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: 'active',
          target: 'n_camsel',
          paramPath: 'active',
          keyframes: [{ time: 0, value: 0, easing: 'constant' }],
        },
      }).next;
      expect(selectActiveCameraNode(s, 0)?.id).toBe('n_cam2');
    });
  });
});

// #231 Inc 3.3 — a camera nested in a Group frames from the group-composed WORLD.
describe('activeCamera — nested camera world pose (#231 Inc 3.3)', () => {
  /** Default project + a Group@[gx,gy,gz] in scene.children + a 2nd camera nested
   *  in that Group's children AND wired active into scene.camera. */
  function buildNestedActiveCamera(group: [number, number, number]): DagState {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_grp',
      nodeType: 'Group',
      params: { position: group },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_grp', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    }).next;
    // #387 C4 — as above: the split pair, with the pose on the Object so the group-lift
    // this test measures still acts on the half that owns the TRS.
    state = makeSplitCamera(state, {
      objectId: 'n_cam2',
      fov: 50,
      position: [0, 0, 0],
      lens: { lookAt: [0, 0, -1] },
    }).state;
    // Nest the camera under the Group.
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_cam2', socket: 'out' },
      to: { node: 'n_grp', socket: 'children' },
    }).next;
    // Make it the active camera (replace the seed direct wire on the single socket).
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_cam2', socket: 'out' },
      to: { node: 'n_scene', socket: 'camera' },
      replace: true,
    }).next;
    return state;
  }

  it('the active nested camera pose is lifted by the group world', () => {
    const pose = resolveActiveCameraPoseAt(buildNestedActiveCamera([5, 1, 0]), 0);
    // local position [0,0,0] under Group@[5,1,0] → world [5,1,0].
    expect(pose.position[0]).toBeCloseTo(5);
    expect(pose.position[1]).toBeCloseTo(1);
    expect(pose.position[2]).toBeCloseTo(0);
    // local lookAt [0,0,-1] translated by the group → [5,1,-1] (aim preserved).
    expect(pose.lookAt[0]).toBeCloseTo(5);
    expect(pose.lookAt[1]).toBeCloseTo(1);
    expect(pose.lookAt[2]).toBeCloseTo(-1);
  });

  it('a top-level (un-nested) active camera is unchanged (byte-identical fallback)', () => {
    // Default project: n_camera wired direct, not in any Group.
    const pose = resolveActiveCameraPoseAt(buildDefaultDagState(), 0);
    expect(pose.position).toEqual([3, 2, 3]);
    // #1760 — turned by its own rotation, which looks at the origin.
    pose.lookAt.forEach((v) => expect(v).toBeCloseTo(0, 9));
  });

  it('the frustum pose helper lifts a nested camera the same way', () => {
    const state = buildNestedActiveCamera([5, 1, 0]);
    const pose = resolveCameraFrustumPose(state, 'n_cam2', {
      time: { frame: 0, seconds: 0, normalized: 0 },
    });
    expect(pose?.position[0]).toBeCloseTo(5);
    expect(pose?.position[1]).toBeCloseTo(1);
  });
});

describe('activeCamera — cameraPoseFromPair', () => {
  it('reads pose from the default seed camera (matches default.ts)', () => {
    const state = buildDefaultDagState();
    // #387 C4 — the seed camera is a PAIR, so the pose must be resolved through the id
    // (which finds the lens half itself). Passing `null` for the data half here would hand
    // the resolver one half of a split camera — see the sibling test below, which pins what
    // that silently returns.
    const pose = cameraPoseForNodeId(state, 'n_camera');
    // #1760 — the seed camera's own rotation looks at the origin, so its pose does.
    expectPose(pose, {
      kind: 'PerspectiveCamera',
      position: [3, 2, 3],
      lookAt: [0, 0, 0],
      fov: 45,
      near: 0.1,
      far: 1000,
      roll: 0,
      quaternion: cameraOrientationTuple([3, 2, 3], [0, 0, 0], 0),
    });
    // #1193 — the seed's far is now Blender's 1000, which is also `DEFAULT_CAMERA_POSE.far`,
    // so every field above equals the default and the assertion can no longer tell "read the
    // lens half" from "read nothing". A far written onto the lens half, and nowhere else,
    // puts that distinction back.
    const edited = applyOp(state, {
      type: 'setParam',
      nodeId: 'n_camera_data',
      paramPath: 'far',
      value: 250,
    }).next;
    expect(edited).not.toBe(state); // the write landed — not a refused no-op
    expect(cameraPoseForNodeId(edited, 'n_camera')?.far).toBe(250);
  });

  // ⚠️ WHY THIS SIBLING EXISTS. The seed camera was authored at the default framing, so
  // its pose equals `DEFAULT_CAMERA_POSE` in every lens field — since #1193 even `far`
  // (it was 500, and that one field is what caught the half-pair read when the seed was
  // split). The test above now separates the two with an edit; this one pins the failure
  // mode directly instead of leaving it resting on one lucky field.
  it('given ONLY the Object half, a split camera silently poses at the DEFAULT lens', () => {
    const state = buildDefaultDagState();
    const objectOnly = cameraPoseFromPair(selectActiveCameraNode(state), null);
    // The Object half's own params — position and (#1760) rotation — are the things that survive.
    expectPose(objectOnly, { ...DEFAULT_CAMERA_POSE, position: [3, 2, 3] });
    expect(objectOnly?.far).toBe(DEFAULT_CAMERA_POSE.far);
  });

  it('returns null for a null node', () => {
    expect(cameraPoseFromPair(null, null)).toBeNull();
  });

  it('defends against missing params with the default pose values', () => {
    // Spelled `Object` since #599: the claim here is about DEFAULTING, not about a type, and
    // the type it used to name no longer exists. The half-less arm it exercises is still live
    // — it is what answers for an Object that poses no CameraData.
    const node = { id: 'c', type: 'Object', params: {}, inputs: {} } as unknown as Node;
    const pose = cameraPoseFromPair(node, null);
    // #1760 — every lens field and the position default; with no rotation the camera is
    // unturned (looking down −Z), as any Object with no rotation is.
    expect({ ...pose!, quaternion: null, lookAt: null, roll: null }).toEqual({
      ...DEFAULT_CAMERA_POSE,
      quaternion: null,
      lookAt: null,
      roll: null,
    });
    expect(pose!.quaternion).toEqual([0, 0, 0, 1]);
  });

  // A case tagging a raw `OrthographicCamera` node with the ortho kind stood here. It was the
  // ONLY thing describing the fused projection branch in `cameraProjectionFromPair`, and #599
  // deleted that branch along with both fused camera types (#597). The branch had become
  // unreachable rather than merely unused: `addNode` resolves through the registry, so a node
  // of a deleted type cannot be built, and the load migration converts any saved one before
  // the state exists. This case reached it only by casting a hand-written literal past the
  // type system, which is the tell that its subject was gone.
  //
  // Orthographic projection itself is untouched and covered on the live road — it is the
  // `CameraData.projection` discriminator now, asserted in the split cases below.

  // #387 — the split half of the same function. The half-less case above is the CONTROL:
  // a node with no data half must still default rather than throw.
  it('spans the pair — position off the Object, every lens field off the CameraData', () => {
    const object = {
      id: 'n_cam',
      type: 'Object',
      // `lookAt`/`fov` planted on the OBJECT too, at values the assertion would catch.
      // The Object owns position and NOTHING else on this road; if the read ever falls
      // back to the object's bag, these are what it would report.
      params: { position: [7, 1, -4], lookAt: [9, 9, 9], fov: 12, roll: 33 },
      inputs: { data: { node: 'n_cam_data', socket: 'out' } },
    } as unknown as Node;
    const data = {
      id: 'n_cam_data',
      type: 'CameraData',
      params: {
        projection: 'Perspective',
        fov: 28,
        near: 0.02,
        far: 250,
        lookAt: [0, 1, 0],
        roll: 5,
      },
      inputs: {},
    } as unknown as Node;

    const pose = cameraPoseFromPair(object, data)!;
    expect({ kind: pose.kind, position: pose.position, fov: pose.fov, near: pose.near }).toEqual({
      kind: 'PerspectiveCamera',
      position: [7, 1, -4],
      fov: 28,
      near: 0.02,
    });
    expect(pose.far).toBe(250);
    // #1760 — the Object carries no rotation, so the camera is unturned: neither the lens's aim
    // and roll nor the ones planted on the Object turn it. The lens's look-at still sets the
    // aim distance (|[0,1,0] − position|, not |[9,9,9] − position|).
    expect(pose.quaternion).toEqual([0, 0, 0, 1]);
    expect(pose.roll).toBeCloseTo(0, 9);
    const dist = Math.hypot(...pose.lookAt.map((v, i) => v - pose.position[i]));
    expect(dist).toBeCloseTo(Math.hypot(7, 0, -4), 9);
  });

  it('takes the ortho kind from the data half’s projection, not the Object’s type', () => {
    const object = {
      id: 'n_cam',
      type: 'Object',
      params: { position: [0, 0, 5] },
      inputs: { data: { node: 'n_cam_data', socket: 'out' } },
    } as unknown as Node;
    const data = {
      id: 'n_cam_data',
      type: 'CameraData',
      // A split camera's node type is `Object` for BOTH projections, so the fused
      // `node.type === 'OrthographicCamera'` test cannot answer this question any more.
      params: { projection: 'Orthographic', fov: 45, zoom: 60 },
      inputs: {},
    } as unknown as Node;

    expect(cameraPoseFromPair(object, data)?.kind).toBe('OrthographicCamera');
  });
});

describe('activeCamera — the split camera pose road (#387)', () => {
  /** An Object posing a CameraData, built through real ops so params are schema-parsed. */
  function buildSplitCamera(): DagState {
    let s = emptyDagState();
    for (const op of splitOps(
      'camera',
      { objectId: 'n_cam' },
      {
        data: { fov: 28, near: 0.02, far: 250, lookAt: [0, 1, 0] },
        object: { position: [7, 1, -4] },
      },
    )) {
      s = applyOp(s, op as Parameters<typeof applyOp>[1]).next;
    }
    return s;
  }

  function withChannel(
    s: DagState,
    id: string,
    nodeType: string,
    target: string,
    paramPath: string,
    value: unknown,
  ): DagState {
    return applyOp(s, {
      type: 'addNode',
      nodeId: id,
      nodeType,
      params: {
        target,
        paramPath,
        keyframes: [
          { time: 0, value, easing: 'linear' },
          { time: 1, value, easing: 'linear' },
        ],
      },
    } as Parameters<typeof applyOp>[1]).next;
  }

  it('poses a split camera from both halves with no channels at all', () => {
    const pose = resolveCameraPoseAt(buildSplitCamera(), 'n_cam', 0);
    expect(pose.position).toEqual([7, 1, -4]);
    expect(pose.fov).toBe(28);
    // #1760 — the lens look-at, read off the data half, sets the aim distance.
    expect(Math.hypot(...pose.lookAt.map((v, i) => v - pose.position[i]))).toBeCloseTo(
      Math.hypot(7, 0, -4),
      9,
    );
    // 45 is DEFAULT_CAMERA_POSE.fov — what this resolver returns when it reads neither
    // half. Naming it keeps a passing assertion from being a coincidence.
    expect(pose.fov).not.toBe(DEFAULT_CAMERA_POSE.fov);
  });

  // The property R4 does not ask: the pose is SPANNED, so one resolve must gather from
  // BOTH ids. A scan that reached only the data half would pass R4's fov assertion while
  // dropping the Object's own position channel, and vice versa.
  it('overlays a channel on the Object AND one on the CameraData in the same resolve', () => {
    let s = buildSplitCamera();
    s = withChannel(s, 'ch_pos', 'KeyframeChannelVec3', 'n_cam', 'position', [1, 2, 3]);
    s = withChannel(s, 'ch_fov', 'KeyframeChannelNumber', 'n_cam_data', 'fov', 85);

    const pose = resolveCameraPoseAt(s, 'n_cam', 1);
    expect(pose.position).toEqual([1, 2, 3]);
    expect(pose.fov).toBe(85);
    // Unchannelled lens fields still come from the data half, not the default pose.
    expect(pose.near).toBe(0.02);
    expect(pose.far).toBe(250);
  });

  // The lens-node narrowing that used to be pinned here now lives with the function
  // it guards, in cameraNode.test.ts.

  it('a channel targeting an unrelated node still moves nothing', () => {
    let s = buildSplitCamera();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'n_other',
      nodeType: 'CameraData',
      params: { fov: 100 },
    } as Parameters<typeof applyOp>[1]).next;
    s = withChannel(s, 'ch_other', 'KeyframeChannelNumber', 'n_other', 'fov', 120);

    expect(resolveCameraPoseAt(s, 'n_cam', 1).fov).toBe(28);
  });
});

describe('activeCamera — resolveActiveCameraPose', () => {
  it('falls back to DEFAULT_CAMERA_POSE when no camera is present', () => {
    expect(resolveActiveCameraPose(emptyDagState())).toEqual(DEFAULT_CAMERA_POSE);
  });

  it('returns the seed camera pose for the default project', () => {
    expect(resolveActiveCameraPose(buildDefaultDagState()).position).toEqual([3, 2, 3]);
  });
});

describe('activeCamera — resolveActiveCameraPoseAt (#190)', () => {
  // Add a KeyframeChannel* node targeting the default project's camera node.
  function addChannel(
    state: DagState,
    nodeType: 'KeyframeChannelVec3' | 'KeyframeChannelNumber',
    paramPath: string,
    keyframes: unknown[],
    target = 'n_camera',
    nodeId = `ch_${paramPath}`,
  ): DagState {
    return applyOp(state, {
      type: 'addNode',
      nodeId,
      nodeType,
      params: { name: paramPath, target, paramPath, keyframes },
    }).next;
  }

  it('returns the static base pose unchanged when the camera is unanimated', () => {
    const state = buildDefaultDagState();
    // Byte-identical to the static read at any time — a safe drop-in.
    expect(resolveActiveCameraPoseAt(state, 0)).toEqual(resolveActiveCameraPose(state));
    expect(resolveActiveCameraPoseAt(state, 5)).toEqual(resolveActiveCameraPose(state));
  });

  it('overlays a position channel, interpolating linearly between keys', () => {
    const state = addChannel(buildDefaultDagState(), 'KeyframeChannelVec3', 'position', [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 1, value: [10, 0, 0], easing: 'linear' },
    ]);
    expect(resolveActiveCameraPoseAt(state, 0).position).toEqual([0, 0, 0]);
    expect(resolveActiveCameraPoseAt(state, 1).position).toEqual([10, 0, 0]);
    expect(resolveActiveCameraPoseAt(state, 0.5).position).toEqual([5, 0, 0]);
    // Non-keyed params keep the base. #1760 — the orientation is the camera's own rotation,
    // which a moving camera keeps (it does not swing to keep looking at a point).
    const base = resolveActiveCameraPose(buildDefaultDagState());
    const moved = resolveActiveCameraPoseAt(state, 0.5);
    const dot = moved.quaternion.reduce((acc, v, i) => acc + v * base.quaternion[i], 0);
    expect(Math.abs(dot)).toBeCloseTo(1, 9);
    expect(moved.fov).toBe(45);
  });

  it('overlays a scalar fov channel', () => {
    const state = addChannel(buildDefaultDagState(), 'KeyframeChannelNumber', 'fov', [
      { time: 0, value: 20, easing: 'linear' },
      { time: 2, value: 60, easing: 'linear' },
    ]);
    expect(resolveActiveCameraPoseAt(state, 0).fov).toBe(20);
    expect(resolveActiveCameraPoseAt(state, 1).fov).toBe(40);
    expect(resolveActiveCameraPoseAt(state, 2).fov).toBe(60);
  });

  // #1760 — a camera banks by its own rotation (V665): keying the rotation turns it. A keyed lens
  // roll turns a plain camera no more (it adds only to a Track-To's aim until #1764).
  it('overlays a keyed rotation (#1760)', () => {
    const state = addChannel(buildDefaultDagState(), 'KeyframeChannelVec3', 'rotation', [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 2, value: [0, 90, 0], easing: 'linear' },
    ]);
    const near = (p: CameraPose, want: V3) =>
      forwardOf(p).forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
    near(resolveActiveCameraPoseAt(state, 0), [0, 0, -1]);
    near(resolveActiveCameraPoseAt(state, 1), [-Math.SQRT1_2, 0, -Math.SQRT1_2]);
    near(resolveActiveCameraPoseAt(state, 2), [-1, 0, 0]);
  });

  it('a keyed lens roll does not turn a plain camera (#1760)', () => {
    const state = addChannel(buildDefaultDagState(), 'KeyframeChannelNumber', 'roll', [
      { time: 0, value: 0, easing: 'linear' },
      { time: 2, value: 90, easing: 'linear' },
    ]);
    const base = resolveActiveCameraPose(buildDefaultDagState());
    const at = resolveActiveCameraPoseAt(state, 2);
    const dot = at.quaternion.reduce((acc, v, i) => acc + v * base.quaternion[i], 0);
    expect(Math.abs(dot)).toBeCloseTo(1, 9);
  });

  it('sorts a scalar channel before sampling, matching the inspector read-side (#200)', () => {
    // The SAME two keys as above, authored OUT OF TIME ORDER. The render path
    // (`sampleScalarKeyframes`) requires a sorted list, and the inspector
    // read-side (`KeyframeChannelNumber.evaluate` → `.sample`) sorts defensively,
    // so the two must agree only if THIS resolver also sorts. Falsifiable: revert
    // the #200 sort → `sampleScalarKeyframes` clamps to the first (now time=2)
    // key, so t=1 returns 60 instead of the correctly-interpolated 40.
    const state = addChannel(buildDefaultDagState(), 'KeyframeChannelNumber', 'fov', [
      { time: 2, value: 60, easing: 'linear' },
      { time: 0, value: 20, easing: 'linear' },
    ]);
    expect(resolveActiveCameraPoseAt(state, 0).fov).toBe(20);
    expect(resolveActiveCameraPoseAt(state, 1).fov).toBe(40);
    expect(resolveActiveCameraPoseAt(state, 2).fov).toBe(60);
  });

  it('overlays position + rotation + fov channels together at the same time', () => {
    let state = buildDefaultDagState();
    state = addChannel(
      state,
      'KeyframeChannelVec3',
      'position',
      [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 1, value: [2, 4, 6], easing: 'linear' },
      ],
      'n_camera',
      'ch_pos',
    );
    state = addChannel(
      state,
      'KeyframeChannelVec3',
      'rotation',
      [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 1, value: [0, 90, 0], easing: 'linear' },
      ],
      'n_camera',
      'ch_rot',
    );
    state = addChannel(
      state,
      'KeyframeChannelNumber',
      'fov',
      [
        { time: 0, value: 30, easing: 'linear' },
        { time: 1, value: 50, easing: 'linear' },
      ],
      'n_camera',
      'ch_fov',
    );
    const pose = resolveActiveCameraPoseAt(state, 1);
    expect(pose.position).toEqual([2, 4, 6]);
    forwardOf(pose).forEach((v, i) => expect(v).toBeCloseTo([-1, 0, 0][i], 9));
    expect(pose.fov).toBe(50);
    // near/far untouched → base.
    expect(pose.near).toBe(0.1);
    expect(pose.far).toBe(1000);
  });

  it('ignores channels that target a different node', () => {
    const state = addChannel(
      buildDefaultDagState(),
      'KeyframeChannelVec3',
      'position',
      [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 1, value: [99, 99, 99], easing: 'linear' },
      ],
      'some_other_node',
    );
    // The camera is unanimated → base pose despite the foreign channel.
    expect(resolveActiveCameraPoseAt(state, 1).position).toEqual([3, 2, 3]);
  });

  it('does not let an empty-keyframe channel clobber the base pose', () => {
    const state = addChannel(buildDefaultDagState(), 'KeyframeChannelNumber', 'fov', []);
    expect(resolveActiveCameraPoseAt(state, 0).fov).toBe(45); // base, not 0
  });

  it('returns DEFAULT_CAMERA_POSE for a camera-less scene at any time', () => {
    expect(resolveActiveCameraPoseAt(emptyDagState(), 3)).toEqual(DEFAULT_CAMERA_POSE);
  });
});

// #204 — the camera migration onto Track-To. A constraint on the camera node
// DERIVES its lookAt from the target (V60), through the SAME machinery meshes use.
describe('activeCamera — Track-To migration (#204)', () => {
  /** Default project + a target box (the aim node) + a Track-To on n_camera. */
  function buildCameraTrackTo(opts: { aimNode?: string; aimPoint?: [number, number, number] }) {
    let state = buildDefaultDagState();
    if (opts.aimNode) {
      state = makeSplitCube(state, {
        objectId: opts.aimNode,
        position: [7, 0, 0],
        size: [1, 1, 1],
      }).state;
      state = applyOp(state, {
        type: 'connect',
        from: { node: opts.aimNode, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      }).next;
    }
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_cam_tt',
      nodeType: 'TrackTo',
      params: {
        name: 'camtt',
        target: 'n_camera',
        aimNode: opts.aimNode ?? '',
        aimPoint: opts.aimPoint ?? [0, 0, 0],
        up: [0, 1, 0],
        mute: false,
      },
    }).next;
    return state;
  }

  it('derives the camera lookAt from a node-ref target world position', () => {
    const state = buildCameraTrackTo({ aimNode: 'n_cam_target' });
    // lookAt is no longer the static [0,0,0] param — it tracks the box at [7,0,0].
    expect(resolveActiveCameraPoseAt(state, 0).lookAt).toEqual([7, 0, 0]);
    // position is untouched (Track-To only aims).
    expect(resolveActiveCameraPoseAt(state, 0).position).toEqual([3, 2, 3]);
  });

  it('the camera lookAt follows a MOVING target over time', () => {
    let state = buildCameraTrackTo({ aimNode: 'n_cam_target' });
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'ch_target',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'tgt',
        target: 'n_cam_target',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [7, 0, 0], easing: 'linear' },
          { time: 1, value: [0, 0, 7], easing: 'linear' },
        ],
      },
    }).next;
    expect(resolveActiveCameraPoseAt(state, 0).lookAt).toEqual([7, 0, 0]);
    expect(resolveActiveCameraPoseAt(state, 1).lookAt).toEqual([0, 0, 7]);
  });

  it('a point-target Track-To overrides the static lookAt', () => {
    const state = buildCameraTrackTo({ aimPoint: [1, 2, 3] });
    expect(resolveActiveCameraPoseAt(state, 0).lookAt).toEqual([1, 2, 3]);
  });

  it('a muted camera Track-To leaves the camera’s own rotation to turn it', () => {
    let state = buildCameraTrackTo({ aimNode: 'n_cam_target' });
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'n_cam_tt',
      paramPath: 'mute',
      value: true,
    }).next;
    // #1760 — the camera's own rotation stands, as in the unconstrained base pose.
    const pose = resolveActiveCameraPoseAt(state, 0);
    const own = resolveActiveCameraPose(state);
    const dot = pose.quaternion.reduce((acc, v, i) => acc + v * own.quaternion[i], 0);
    expect(Math.abs(dot)).toBeCloseTo(1, 9);
  });
});

describe('resolveCameraDofAt — the split camera DoF road (#387 D9)', () => {
  /** A split camera with DoF authored on the LENS half. `focusDistance: 3` is none of:
   *  the schema default (5), the `DofParams` fallback (5), |position − lookAt| for this
   *  fixture (√65 ≈ 8.06), or |position − lookAt| for `DEFAULT_CAMERA_POSE` (√22 ≈ 4.69).
   *  Every wrong road therefore lands on a number this test can name. */
  function buildSplitDofCamera(data: Record<string, unknown> = {}): DagState {
    let s = emptyDagState();
    for (const op of splitOps(
      'camera',
      { objectId: 'n_cam' },
      {
        data: {
          fov: 28,
          near: 0.02,
          far: 250,
          lookAt: [0, 1, 0],
          dofEnabled: true,
          focusDistance: 3,
          fStop: 2.8,
          ...data,
        },
        object: { position: [7, 1, -4] },
      },
    )) {
      s = applyOp(s, op as Parameters<typeof applyOp>[1]).next;
    }
    return s;
  }

  function withChannel(
    s: DagState,
    id: string,
    nodeType: string,
    target: string,
    paramPath: string,
    from: unknown,
    to: unknown,
  ): DagState {
    return applyOp(s, {
      type: 'addNode',
      nodeId: id,
      nodeType,
      params: {
        target,
        paramPath,
        keyframes: [
          { time: 0, value: from, easing: 'linear' },
          { time: 1, value: to, easing: 'linear' },
        ],
      },
    } as Parameters<typeof applyOp>[1]).next;
  }

  // The whole point of D9. Pre-split this road gated on `node.type === 'PerspectiveCamera'`;
  // a split camera's node is an `Object`, so the gate answered "not a camera" and DoF went
  // silently OFF — no error, no warning, just a sharp image where the director authored bokeh.
  it('reads the lens half of a split camera — the type gate would have returned null here', () => {
    const dof = resolveCameraDofAt(buildSplitDofCamera(), 'n_cam', 0);
    expect(dof).not.toBeNull();
    expect(dof!.focusDistance).toBe(3);
  });

  it('is null for an orthographic split camera, and for a camera with DoF off', () => {
    expect(
      resolveCameraDofAt(buildSplitDofCamera({ projection: 'Orthographic' }), 'n_cam', 0),
    ).toBeNull();
    expect(resolveCameraDofAt(buildSplitDofCamera({ dofEnabled: false }), 'n_cam', 0)).toBeNull();
  });

  // #247 spans the pair: the flag and the authored distance are the CameraData's, the
  // position is the Object's. This is the assertion the pre-mortem asks for — a fixture
  // whose pose sits at a NON-default position, so the expected distance cannot be the
  // one a fallback pose would produce.
  it('focus-on-target derives |position − lookAt| across BOTH halves', () => {
    const dof = resolveCameraDofAt(buildSplitDofCamera({ focusOnTarget: true }), 'n_cam', 0);
    expect(dof!.focusDistance).toBeCloseTo(Math.sqrt(65), 6);
    // Naming the two numbers a broken road would return keeps the pass from being luck:
    // √22 is what a fallback DEFAULT_CAMERA_POSE gives, 3 is the authored value that
    // would stand if the flag were read off the wrong half.
    expect(dof!.focusDistance).not.toBeCloseTo(Math.sqrt(22), 6);
    expect(dof!.focusDistance).not.toBe(3);
  });

  // Handed the DATA half instead of the Object, this answers NULL rather than a plausible
  // wrong number — `cameraLensParams` refuses a node that poses nothing. Pinned because
  // the surrounding code's whole hazard is that the two ids are interchangeable-looking.
  it('returns null when given the data half instead of the Object', () => {
    expect(resolveCameraDofAt(buildSplitDofCamera(), 'n_cam_data', 0)).toBeNull();
  });

  // ── D12 — the pinned negative. ────────────────────────────────────────────────────
  //
  // The camera row's `primaryWorkflows` says the DoF focus is STATIC. This is that claim,
  // asserted where it can fail: the DoF road hands `resolveCameraDof` the lens node's RAW
  // params, so a keyframed `focusDistance` reaches nothing (#193, [[V121]]).
  //
  // The CONTROL below is what makes this a claim about the road rather than about a
  // time-blind function: `resolveCameraDofAt` demonstrably DOES vary with `seconds` on the
  // focus-on-target path, because that path goes through `resolveCameraPoseAt`. So "the
  // authored focus did not move between t=0 and t=1" is a fact about which params get
  // overlaid, not about the fixture failing to animate anything.
  it('#193 — a keyframed focusDistance does NOT reach the DoF road (pinned limit)', () => {
    const s = withChannel(
      buildSplitDofCamera(),
      'ch_focus',
      'KeyframeChannelNumber',
      'n_cam_data',
      'focusDistance',
      3,
      40,
    );
    expect(resolveCameraDofAt(s, 'n_cam', 0)!.focusDistance).toBe(3);
    // The equality that reds the day #193 wires a channel overlay into this road — at
    // which point this test SHOULD fail and the row's workflow text should change with it.
    expect(resolveCameraDofAt(s, 'n_cam', 1)!.focusDistance).toBe(3);
    expect(resolveCameraDofAt(s, 'n_cam', 1)!.focusDistance).not.toBe(40);
  });

  it('CONTROL — the same road DOES vary with time on the focus-on-target path', () => {
    const s = withChannel(
      buildSplitDofCamera({ focusOnTarget: true }),
      'ch_pos',
      'KeyframeChannelVec3',
      'n_cam',
      'position',
      [7, 1, -4],
      [0, 1, 10],
    );
    expect(resolveCameraDofAt(s, 'n_cam', 0)!.focusDistance).toBeCloseTo(Math.sqrt(65), 6);
    expect(resolveCameraDofAt(s, 'n_cam', 1)!.focusDistance).toBeCloseTo(10, 6);
  });
});

// #1745 — the camera's lens fields read a driven fov on the clock the render reads it on. The
// fixture: the scene at half speed, the box keyed x = 10·t on the scene clock, and the camera's
// fov driven by the box's x. At a playhead of 4 s the scene is at 2 s, so the render's fov is 20.
// A plain `{ time }` context makes the playhead scene time and reads 40: the CONTROL below shows
// the fixture tells the two clocks apart, so the parity is not a coincidence of speed 1.
describe("cameraFilmCtx — a camera value read on the render's clock (#1745)", () => {
  function slowSceneDrivenFov(): DagState {
    let s = buildDefaultDagState();
    const ops = [
      { type: 'setParam', nodeId: s.outputs.scene!.node, paramPath: 'timeSpeed', value: 0.5 },
      {
        type: 'addNode',
        nodeId: 'bx',
        nodeType: 'KeyframeChannelVec3',
        params: {
          target: 'n_box',
          paramPath: 'position',
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'linear' },
            { time: 8, value: [80, 0, 0], easing: 'linear' },
          ],
        },
      },
      {
        type: 'addNode',
        nodeId: 'drv',
        nodeType: 'ParamDriver',
        params: {
          target: 'n_camera_data',
          paramPath: 'fov',
          blendMode: 'replace',
          order: 0,
          sourceTransform: { node: 'n_box', channel: 'tx' },
        },
      },
    ];
    for (const op of ops) s = applyOp(s, op as Parameters<typeof applyOp>[1]).next;
    return s;
  }

  it('a driven fov reads what the render reads at a slowed scene', () => {
    const s = slowSceneDrivenFov();
    const rendered = resolveCameraPoseAt(s, 'n_camera', 4).fov;
    expect(rendered).toBeCloseTo(20, 6);
    const shown = resolveEvaluatedParam(s, 'n_camera_data', 'fov', cameraFilmCtx(s, 4));
    expect(shown!.value as number).toBeCloseTo(rendered, 6);
  });

  it('CONTROL — a plain context takes the playhead for scene time and reads another value', () => {
    const s = slowSceneDrivenFov();
    const plain = { time: { frame: 240, seconds: 4, normalized: 0 } };
    expect(resolveEvaluatedParam(s, 'n_camera_data', 'fov', plain)!.value as number).toBeCloseTo(
      40,
      6,
    );
  });
});
