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
import { registerAllNodes } from './registerAll';
import { splitOps } from '../test-utils/splitKinds';
import { CameraDataNode } from './CameraData';
import { recomposeCameraObject } from './cameraRecompose';
import { runRenderJob, type PassEncoder } from '../render/runRenderJob';
import type { CameraValue, ImageValue, SceneValue, ShotValue } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
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

/**
 * What the pre-split `PerspectiveCamera` produced for that same lens, written out by hand.
 *
 * It USED to be a live resolve of a fused node — the honest control while both forms could
 * coexist. Slice 8 retired the fused types (their `evaluate` throws), so that control cannot
 * be built any more, and this literal replaces it. The substitution is not a loss: a hand-
 * written expectation states the struct the split MUST produce, where the live control only
 * said "whatever the relic said", and a relic can no longer drift.
 */
const CANONICAL_PERSPECTIVE: CameraValue = {
  kind: 'PerspectiveCamera',
  fov: 28,
  near: 0.02,
  far: 250,
  position: [7, 1, -4],
  lookAt: [0, 1, 0],
  roll: 15,
};

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

  it('is byte-identical to what the fused camera produced for the same lens', () => {
    // The migration's real contract: a project that splits must produce the SAME value, or
    // every render cache keyed on it invalidates and every consumer sees a different struct
    // on load. Measured against the canonical struct rather than a live fused resolve — see
    // CANONICAL_PERSPECTIVE on why the control had to become a literal at slice 8.
    expect(sceneCamera(sceneWith(splitCameraOps('n_cam'), 'n_cam'))).toEqual(CANONICAL_PERSPECTIVE);
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
    // …and it must equal what the fused OrthographicCamera produced, same as above. Note
    // there is no `fov` on this arm — the orthographic value never carried one, so the
    // whole struct is asserted rather than field-by-field: an extra key is a difference.
    expect(cam).toEqual({
      kind: 'OrthographicCamera',
      zoom: 12,
      near: 0.02,
      far: 250,
      position: [7, 1, -4],
      lookAt: [0, 1, 0],
      roll: 15,
    });
  });

  it('leaves an Object that is NOT posing a CameraData untouched', () => {
    // The surviving half of what used to be the coexistence test. Until slice 8 this asked
    // "a still-FUSED camera passes through unrecomposed", which was the load-bearing claim
    // while unmigrated projects existed; the fused node can no longer evaluate, so that
    // subject is gone. The claim underneath it is not: the recompose declines anything that
    // is not an Object posing a CameraData, and the caller KEEPS THE ORIGINAL.
    //
    // Which of those two halves this row actually detects was measured, not assumed. Widening
    // the recompose's guard to accept any Object-with-data leaves this GREEN — the projection
    // switch has no arm for a BoxData, so it falls out returning undefined and the `??` keeps
    // the original anyway. The guard is doubly protected. The CALLER'S FALLBACK is not:
    // dropping Scene's `?? (inputs.camera as CameraValue)` reds exactly this row. So read it
    // as a pin on the pass-through, which is the single-guarded half and the realistic
    // mistake — a gather that trusts the recompose to answer for every value it is handed.
    const cam = sceneCamera(
      sceneWith(splitOps('box', { objectId: 'n_cam' }, { data: { size: [1, 1, 1] } }), 'n_cam'),
    );
    expect(cam.kind).toBe('Object');
    expect(cam).not.toHaveProperty('fov');
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
      // The pass's `sourceHash` is a render-cache key, and the claim is that it is keyed on
      // the RECOMPOSED lens rather than on the raw Object.
      //
      // It used to be phrased as equality with a live fused camera's hash — the migration
      // contract, exactly. Slice 8 retired the fused node, so the discriminator moved to the
      // other property that separates the two structs: a recomposed CameraValue has NO
      // `rotation`, while the raw ObjectValue does. Two split cameras differing ONLY in the
      // Object's rotation must therefore hash IDENTICALLY — which also means a rotate drag
      // cannot thrash the render cache. Note what the obvious alternative would not buy: "the
      // hash flips when fov changes" does NOT discriminate, because the raw ObjectValue
      // carries `data.fov` too and hashing it flips just the same ([[H180]] vacuous negative).
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
      const rotated = [
        ...splitCameraOps('n_cam'),
        { type: 'setParam', nodeId: 'n_cam', paramPath: 'rotation', value: [0, 45, 0] } as Op,
      ];
      expect(build(splitCameraOps('n_cam'))).toBe(build(rotated));
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

// The hydrate seam, and the reason it is a SEPARATE concern from the schema's default.
//
// Load parses the generic `NodeSchema` (`src/core/project/schema.ts`) and never a
// per-type `paramSchema`, so a hand-edited or corrupted save reaches `evaluate` with its
// params unvalidated. `?? 'Perspective'` only guards `undefined`/`null`; some OTHER string
// passes straight through, and `CameraDataValue.projection` is typed as a two-member
// union — so `evaluate` would be violating its own return type, and `recomposeCameraObject`
// would fall out of its switch returning `undefined`, which all nine call sites absorb with
// `?? (inputs.camera as CameraValue)`. The camera consumer then reads `fov` as `undefined`
// with nothing raised anywhere.
//
// Pinned at `evaluate` rather than at the switch on purpose: a `default:` arm there would
// silently swallow a future third projection that the exhaustiveness check is meant to turn
// into a compile error.
describe('#387 — an out-of-union `projection` is NORMALISED at evaluate, not passed through', () => {
  it('evaluates a corrupted discriminator to Perspective, so the value honours its own type', () => {
    const value = CameraDataNode.evaluate(
      { projection: 'Ortho', fov: 28, near: 0.01, far: 500 } as never,
      {} as never,
      {} as never,
    ) as { projection: string };
    expect(value.projection).toBe('Perspective');
  });

  it('so the recompose returns a real camera instead of undefined for such a bag', () => {
    const data = CameraDataNode.evaluate(
      { projection: 'Ortho', fov: 28, near: 0.01, far: 500 } as never,
      {} as never,
      {} as never,
    );
    const out = recomposeCameraObject({
      kind: 'Object',
      position: [1, 2, 3],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      data,
    });
    // NOT `toBeTruthy()`: `undefined` is what the bug produced, and only naming the kind
    // distinguishes "recomposed" from "fell out of the switch".
    expect(out?.kind).toBe('PerspectiveCamera');
    expect(out?.fov).toBe(28);
  });

  it('and a WELL-FORMED orthographic bag is untouched — the normalisation is not a clamp', () => {
    const value = CameraDataNode.evaluate(
      { projection: 'Orthographic', fov: 28, near: 0.01, far: 500 } as never,
      {} as never,
      {} as never,
    ) as { projection: string };
    expect(value.projection).toBe('Orthographic');
  });
});
