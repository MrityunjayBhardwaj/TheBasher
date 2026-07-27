// The camera VALUE road for the object↔data split (#387, Stage C · C4 slice 4).
//
// Eight roads funnel a `CameraValue`: `Scene.camera`, `CameraSelect`, `Shot.camera`, the
// four image passes, and `runRenderJob`'s raw evaluate-and-cast. Post-split the thing
// arriving on each is an `ObjectValue` posing a `CameraData`, and every one of those
// sites used to reach it with a bare `as CameraValue` — a cast that cannot fail and
// produces a struct with no `fov`, no `lookAt`, and the wrong `kind`.
//
// ⚠️ WHY THESE TESTS GO THROUGH `evaluate` AND NOT THROUGH `renderedValueForBand`.
// The conformance matrix's camera row already calls `recomposeCameraObject` DIRECTLY
// (`splitKinds.ts`, landed in slice 1), so every assertion phrased against that helper
// passes with all eight production sites still unwired. It measures the helper, not the
// road. The subject here is the DAG's own gathers, reached the way the app reaches them.
//
// AND WHAT THIS DOES NOT CLAIM. A correct `CameraValue` here does NOT mean the camera
// frames the shot correctly — the picture comes from a `CameraPose` that `activeCamera.ts`
// builds from RAW params, and the value below reaches the renderer only as an ingredient
// in a render-cache key (`buildPassSourceHash`). That second question is the pose road's,
// and slice 2 asks it separately. What IS claimed here: the cache key is right, and the
// read side sees what the render side does.
//
// REF: src/nodes/cameraRecompose.ts; src/app/objectDataBand.ts (`renderReachForBand`);
//      src/app/activeCamera.ts (the pose road, deliberately not exercised here); #387.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, evaluate } from '../core/dag';
import type { DagState, Op } from '../core/dag/types';
import { MemoryStorage } from '../core/storage/MemoryStorage';
import { __reseedAllNodesForTests } from './registerAll';
import { splitOps } from '../test-utils/splitKinds';
import { runRenderJob, type PassEncoder } from '../render/runRenderJob';
import type { CameraValue, ImageValue, SceneValue, ShotValue } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

// The one authored lens used throughout. NONE of these values may be a fallback the
// broken road also returns: `fov` is 28 because 45 is `DEFAULT_CAMERA_POSE.fov` and what
// `addPrimitives` seeds, and the pose sits off the default so a passthrough cannot
// accidentally agree ([[V124]] observation trap, in unit form).
const LENS = { fov: 28, near: 0.02, far: 250, lookAt: [0, 1, 0] as const, roll: 15 };
const POSE = [7, 1, -4] as const;

function applyAll(s: DagState, ops: unknown[]): DagState {
  for (const op of ops) s = applyOp(s, op as Op).next;
  return s;
}

/** An Object posing a CameraData — the post-split form. */
function splitCameraOps(objectId: string, data: Record<string, unknown> = {}) {
  return splitOps(
    'camera',
    { objectId },
    { data: { ...LENS, ...data }, object: { position: POSE } },
  );
}

/** The pre-split form, authored with the SAME lens — the byte-identity control. */
function fusedCameraOp(nodeId: string, nodeType = 'PerspectiveCamera'): Op {
  return {
    type: 'addNode',
    nodeId,
    nodeType,
    params: { ...LENS, position: POSE },
  } as Op;
}

/** A Scene whose `camera` input is fed by `cameraId`. */
function sceneWith(cameraOps: unknown[], cameraId: string): DagState {
  let s = applyAll(emptyDagState(), cameraOps);
  s = applyOp(s, { type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} }).next;
  return applyOp(s, {
    type: 'connect',
    from: { node: cameraId, socket: 'out' },
    to: { node: 'n_scene', socket: 'camera' },
  }).next;
}

function sceneCamera(state: DagState): CameraValue {
  return (evaluate(state, 'n_scene').value as SceneValue).camera;
}

describe('#387 slice 4 — Scene.camera recomposes the split pair', () => {
  it('spans BOTH halves: lens off the CameraData, position off the Object', () => {
    const cam = sceneCamera(sceneWith(splitCameraOps('n_cam'), 'n_cam'));
    // The `kind` is the whole point: unrecomposed this is `'Object'`, and every consumer
    // downstream discriminates on it.
    expect(cam.kind).toBe('PerspectiveCamera');
    if (cam.kind !== 'PerspectiveCamera') throw new Error('unreachable');
    expect(cam.fov).toBe(28);
    expect(cam.near).toBe(0.02);
    expect(cam.far).toBe(250);
    expect(cam.lookAt).toEqual([0, 1, 0]);
    expect(cam.roll).toBe(15);
    // Position comes from the OTHER node. A recompose that read only the data half would
    // still satisfy every line above.
    expect(cam.position).toEqual([7, 1, -4]);
  });

  it('is byte-identical to the fused camera authored with the same lens', () => {
    // The migration's real contract, stated one slice before the migration exists: a
    // project that splits must produce the SAME value, or every render cache keyed on it
    // invalidates and every consumer sees a different struct on load.
    const split = sceneCamera(sceneWith(splitCameraOps('n_cam'), 'n_cam'));
    const fused = sceneCamera(sceneWith([fusedCameraOp('n_cam')], 'n_cam'));
    expect(split).toEqual(fused);
  });

  it('reads the projection discriminator, not the node type', () => {
    // Post-split BOTH projections wear `type: 'Object'`, so a recompose hardcoded to
    // Perspective passes every test above. This is the one that separates them.
    const cam = sceneCamera(
      sceneWith(splitCameraOps('n_cam', { projection: 'Orthographic', zoom: 12 }), 'n_cam'),
    );
    expect(cam.kind).toBe('OrthographicCamera');
    if (cam.kind !== 'OrthographicCamera') throw new Error('unreachable');
    expect(cam.zoom).toBe(12);
    expect(cam.position).toEqual([7, 1, -4]);
    // …and it must equal what the fused OrthographicCamera produces, same as above.
    const fused = sceneCamera(
      sceneWith(
        [
          {
            type: 'addNode',
            nodeId: 'n_cam',
            nodeType: 'OrthographicCamera',
            params: { ...LENS, zoom: 12, position: POSE },
          } as Op,
        ],
        'n_cam',
      ),
    );
    expect(cam).toEqual(fused);
  });

  it('leaves a still-fused camera untouched (coexistence)', () => {
    // The recompose returns null for anything that is not an Object posing a CameraData,
    // and the caller keeps the original. Without this, wiring the recompose in would be a
    // regression for every unmigrated project — which is every project until slice 7.
    const cam = sceneCamera(sceneWith([fusedCameraOp('n_cam')], 'n_cam'));
    expect(cam.kind).toBe('PerspectiveCamera');
    if (cam.kind !== 'PerspectiveCamera') throw new Error('unreachable');
    expect(cam.fov).toBe(28);
  });

  it("drops the Object's rotation and scale — the parity-first decision, pinned", () => {
    // #387 D1: a camera's orientation is `lookAt` + `roll` on the data half; the Object's
    // `rotation` is a NO-OP on the camera road. So two cameras differing only in rotation
    // must produce the identical value — which also means a rotate drag cannot thrash the
    // render cache. This is the assertion an unrecomposed passthrough FAILS while the
    // `fov` assertions above would still pass: the raw ObjectValue carries `rotation`.
    let a = applyAll(emptyDagState(), splitCameraOps('n_cam'));
    a = applyOp(a, {
      type: 'setParam',
      nodeId: 'n_cam',
      paramPath: 'rotation',
      value: [0, 45, 0],
    } as Op).next;
    a = applyOp(a, { type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} }).next;
    a = applyOp(a, {
      type: 'connect',
      from: { node: 'n_cam', socket: 'out' },
      to: { node: 'n_scene', socket: 'camera' },
    }).next;
    const rotated = sceneCamera(a);
    const unrotated = sceneCamera(sceneWith(splitCameraOps('n_cam'), 'n_cam'));
    expect(rotated).toEqual(unrotated);
    expect(rotated).not.toHaveProperty('rotation');
    expect(rotated).not.toHaveProperty('scale');
  });
});

describe('#387 slice 4 — the other seven gathers', () => {
  it('Shot.camera recomposes', () => {
    let s = applyAll(emptyDagState(), splitCameraOps('n_cam'));
    s = applyOp(s, { type: 'addNode', nodeId: 'n_shot', nodeType: 'Shot', params: {} }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'n_cam', socket: 'out' },
      to: { node: 'n_shot', socket: 'camera' },
    }).next;
    const cam = (evaluate(s, 'n_shot').value as ShotValue).camera;
    expect(cam?.kind).toBe('PerspectiveCamera');
    if (cam?.kind !== 'PerspectiveCamera') throw new Error('unreachable');
    expect(cam.fov).toBe(28);
    expect(cam.position).toEqual([7, 1, -4]);
  });

  it('CameraSelect recomposes the picked candidate, and picks by the same index', () => {
    // Two split cameras with DIFFERENT lenses, `active: 1`. Asserting the second one's fov
    // proves the recompose happens AFTER the pick — a recompose that ran over the
    // candidate list first could reorder or drop entries and this would catch it.
    let s = applyAll(emptyDagState(), splitCameraOps('n_camA'));
    s = applyAll(s, splitCameraOps('n_camB', { fov: 85 }));
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'n_sel',
      nodeType: 'CameraSelect',
      params: { active: 1 },
    }).next;
    for (const id of ['n_camA', 'n_camB']) {
      s = applyOp(s, {
        type: 'connect',
        from: { node: id, socket: 'out' },
        to: { node: 'n_sel', socket: 'cameras' },
      }).next;
    }
    const cam = evaluate(s, 'n_sel').value as CameraValue;
    expect(cam.kind).toBe('PerspectiveCamera');
    if (cam.kind !== 'PerspectiveCamera') throw new Error('unreachable');
    expect(cam.fov).toBe(85);
  });

  it.each(['BeautyPass', 'DepthPass', 'IDPass', 'NormalPass'])(
    '%s hashes the recomposed lens, not the Object shape',
    (passType) => {
      // The pass's `sourceHash` is a render-cache key. The claim is EQUALITY with the
      // fused camera's hash: same lens, same pose, same key — so migrating a project does
      // not invalidate its cache. A "the hash flips when fov changes" test would NOT
      // discriminate here, because the raw ObjectValue carries `data.fov` too and hashing
      // it flips just the same ([[H180]] vacuous negative).
      //
      // ⚠️ THE SCENE HERE IS DELIBERATELY CAMERA-LESS, and that is not tidiness. The
      // hash covers (passKind, params, scene, camera, time), so wiring the camera into
      // `scene.camera` as well — the obvious fixture, and what the first draft did — puts
      // it into the hash TWICE and the test reds whenever EITHER road breaks. Measured:
      // with `Scene`'s recompose removed and all four passes intact, all four of these
      // failed. That instrument cannot say which road broke. Feeding the camera only
      // through the pass's own `camera` socket makes each row sensitive to its own road
      // and nothing else.
      const build = (cameraOps: unknown[]) => {
        let s = applyAll(emptyDagState(), cameraOps);
        s = applyOp(s, { type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} }).next;
        s = applyOp(s, {
          type: 'addNode',
          nodeId: 'n_time',
          nodeType: 'TimeSource',
          params: {},
        }).next;
        s = applyOp(s, { type: 'addNode', nodeId: 'n_pass', nodeType: passType, params: {} }).next;
        for (const [from, socket] of [
          ['n_scene', 'scene'],
          ['n_cam', 'camera'],
          ['n_time', 'time'],
        ] as const) {
          s = applyOp(s, {
            type: 'connect',
            from: { node: from, socket: 'out' },
            to: { node: 'n_pass', socket },
          }).next;
        }
        return (evaluate(s, 'n_pass').value as ImageValue).sourceHash;
      };
      expect(build(splitCameraOps('n_cam'))).toBe(build([fusedCameraOp('n_cam')]));
    },
  );

  it('runRenderJob hands the encoder a recomposed CameraValue', () => {
    // The raw `evaluate` + cast — a road of its own, not a socket gather, so it needs its
    // own assertion. Observed on the RECEIVER'S side (the encoder's argument), which is
    // the only place the mistake is visible: the job itself would happily write PNGs.
    const seen: CameraValue[] = [];
    const spyEncoder: PassEncoder = async ({ camera }) => {
      seen.push(camera);
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    };

    let s = sceneWith(splitCameraOps('n_cam'), 'n_cam');
    s = applyOp(s, { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} }).next;
    s = applyOp(s, { type: 'addNode', nodeId: 'n_pass', nodeType: 'BeautyPass', params: {} }).next;
    for (const [from, socket] of [
      ['n_scene', 'scene'],
      ['n_cam', 'camera'],
      ['n_time', 'time'],
    ] as const) {
      s = applyOp(s, {
        type: 'connect',
        from: { node: from, socket: 'out' },
        to: { node: 'n_pass', socket },
      }).next;
    }
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'n_job',
      nodeType: 'RenderJob',
      params: { jobId: 'j', frameStart: 0, frameEnd: 0, fps: 30, outputPath: 'r/j' },
    }).next;
    for (const [from, socket] of [
      ['n_time', 'time'],
      ['n_pass', 'pass-input'],
    ] as const) {
      s = applyOp(s, {
        type: 'connect',
        from: { node: from, socket: 'out' },
        to: { node: 'n_job', socket },
      }).next;
    }

    return runRenderJob('n_job', s, { storage: new MemoryStorage(), encoder: spyEncoder }).then(
      () => {
        expect(seen).toHaveLength(1);
        expect(seen[0].kind).toBe('PerspectiveCamera');
        const cam = seen[0];
        if (cam.kind !== 'PerspectiveCamera') throw new Error('unreachable');
        expect(cam.fov).toBe(28);
        expect(cam.position).toEqual([7, 1, -4]);
      },
    );
  });
});
