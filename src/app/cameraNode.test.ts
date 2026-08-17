// cameraNode — the possession-keyed camera predicates (#387 C4 slice 3).
//
// Written when both forms existed: every predicate asserted the split Object+CameraData AND
// the fused camera, because a one-form test cannot tell a correct coexistence predicate from
// one that answers for the form the fixture happens to build.
//
// #476 — the fused camera types have now retired, so the fused half of each pair described a
// state the product cannot reach and has been removed rather than repaired. The discriminating
// power did not live there in the end: what separates a real possession test from a type test
// is the split BOX, which wears the identical node type 'Object' and must still read false.
// That control stays, and it is what every predicate below is really pinned by.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, emptyDagState, type DagState } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { splitOps } from '../test-utils/splitKinds';
import { cameraDataOf, cameraLensParams, cameraProjectionOf, isCameraNode } from './cameraNode';
import { enumerateCameraNodeIds } from './activeCamera';
import { buildSetActiveCameraOps } from './setActiveCamera';
import { resolveWorldTransform } from './resolveWorldTransform';
import { stripTargetRows } from '../timeline/NlaAddStripPopover';
import { resolveCameraPoseAt } from './activeCamera';
import { identify } from '../agent/identify/identify';
import { shotCreateMutator } from '../agent/mutators/builders/shotCreate';
import { validatePlan } from '../agent/mutators/validate';
import { addPassMutator } from '../agent/mutators/builders/addPass';

beforeAll(() => {
  registerAllNodes();
});

function applyAll(s: DagState, ops: unknown[]): DagState {
  for (const op of ops) s = applyOp(s, op as Parameters<typeof applyOp>[1]).next;
  return s;
}

/** An Object posing a CameraData. `projection` defaults to Perspective. */
function splitCamera(data: Record<string, unknown> = {}): DagState {
  return applyAll(
    emptyDagState(),
    splitOps(
      'camera',
      { objectId: 'n_cam' },
      {
        data: { fov: 28, near: 0.02, far: 250, lookAt: [0, 1, 0], ...data },
        object: { position: [7, 1, -4] },
      },
    ),
  );
}

/** An Object posing a BoxData — the node that must NOT read as a camera. */
function splitBox(): DagState {
  return applyAll(
    emptyDagState(),
    // `size` is BoxData's one required param (no zod default).
    splitOps('box', { objectId: 'n_box' }, { data: { size: [1, 1, 1] } }),
  );
}

describe('cameraNode — cameraDataOf', () => {
  // PINS the narrowing. Falsified: deleting the type test leaves the whole suite green,
  // because no other ObjectData kind declares a field named fov/near/far/lookAt/roll — so
  // a wrong lens reads as "absent" and lands on DEFAULT_CAMERA_POSE, the same 45 a total
  // read failure returns. The consequence is unobservable through the pose; the contract
  // is not, so it is pinned here rather than left as a defensive line nothing can fail.
  it('does not treat a non-camera data node as a lens', () => {
    expect(cameraDataOf(splitBox(), 'n_box')).toBeNull();
    // The positive control — without it a function that always returned null would pass.
    expect(cameraDataOf(splitCamera(), 'n_cam')?.type).toBe('CameraData');
  });

  it('is null for a missing node', () => {
    expect(cameraDataOf(emptyDagState(), 'nope')).toBeNull();
  });
});

describe('cameraNode — isCameraNode (possession, not identity)', () => {
  it('accepts a split camera in either projection', () => {
    // Both projections, because 'Object' is the node type either way — the projection is a
    // field on the data half, so it is the only axis left that can distinguish them, and a
    // predicate that keyed on the type would answer the same for both by accident.
    expect(isCameraNode(splitCamera(), 'n_cam'), 'split perspective').toBe(true);
    expect(
      isCameraNode(splitCamera({ projection: 'Orthographic' }), 'n_cam'),
      'split orthographic',
    ).toBe(true);
  });

  // THE FAIL-OPEN CASE, and the reason this predicate exists at all: post-split a camera
  // and a cube are BOTH nodeType 'Object'. A gate still spelled as a type test answers
  // `false` for every camera and `true` for none of them — or, written the other way
  // round ("is it an Object?"), true for the whole scene.
  it('rejects a split BOX, which wears the identical node type', () => {
    const s = splitBox();
    expect(s.nodes['n_box'].type, 'the fixture must actually be an Object').toBe('Object');
    expect(isCameraNode(s, 'n_box')).toBe(false);
  });

  it('rejects a missing node', () => {
    expect(isCameraNode(emptyDagState(), 'nope')).toBe(false);
  });
});

describe('cameraNode — cameraProjectionOf', () => {
  it('reads the discriminator on the data half, not the node type', () => {
    expect(cameraProjectionOf(splitCamera(), 'n_cam')).toBe('Perspective');
    expect(cameraProjectionOf(splitCamera({ projection: 'Orthographic' }), 'n_cam')).toBe(
      'Orthographic',
    );
  });

  it('is null for a non-camera', () => {
    expect(cameraProjectionOf(splitBox(), 'n_box')).toBeNull();
    expect(cameraProjectionOf(emptyDagState(), 'nope')).toBeNull();
  });
});

describe('cameraNode — cameraLensParams', () => {
  it('returns the DATA half for a split camera — and not the Object, which owns position', () => {
    const params = cameraLensParams(splitCamera(), 'n_cam');
    expect(params?.fov).toBe(28);
    expect(params?.lookAt).toEqual([0, 1, 0]);
    // The bag is the lens, NOT the pose: `position` lives on the Object. A caller handed
    // the wrong bag would read `undefined` here and silently fall back to a default.
    expect(params).not.toHaveProperty('position');
  });

  it('is null for a non-camera', () => {
    expect(cameraLensParams(splitBox(), 'n_box')).toBeNull();
    expect(cameraLensParams(emptyDagState(), 'nope')).toBeNull();
  });
});

// ── The consumers, one targeted test per re-keyed site. Each asserts BOTH forms: the
//    split camera is the subject, the fused camera is the control that proves the
//    predicate did not simply start answering "yes" to everything.

describe('#387 slice 3 — the re-keyed consumers accept a split camera', () => {
  it('enumerateCameraNodeIds finds a split camera, and keeps insertion order', () => {
    // Order is not decoration: it is the index a CameraSelect addresses by, so the
    // filter may change and the Object.values walk may not. Two cameras, minted in a
    // known order, with a non-camera between them to prove filtering happens at all.
    let s = splitCamera();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'n_mid',
      nodeType: 'Group',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }).next;
    s = applyAll(
      s,
      splitOps(
        'camera',
        { objectId: 'n_cam_2' },
        { data: { fov: 28, projection: 'Orthographic', zoom: 1 }, object: { position: [0, 0, 5] } },
      ),
    );
    // The second camera is the OTHER projection, so the walk is asked to find two cameras
    // that share a node type and differ only on the data half's discriminator.
    expect(enumerateCameraNodeIds(s)).toEqual(['n_cam', 'n_cam_2']);
  });

  it('buildSetActiveCameraOps accepts a split camera as the target', () => {
    let s = splitCamera();
    s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
    s = { ...s, outputs: { ...s.outputs, scene: { node: 'scene', socket: 'out' } } };
    // Non-null = "this is a camera and it is not already active". A type-keyed gate
    // returns null here and the rewire silently does nothing.
    expect(buildSetActiveCameraOps(s, 'n_cam')).not.toBeNull();
    expect(buildSetActiveCameraOps(s, 'nope')).toBeNull();
  });

  // BOTH reaches in one test, because they fail independently and each alone looks fine:
  // the RAW read (lookAt moved to the data half) and the CHANNEL read (a channel on the
  // aim targets the data id). A non-origin lookAt is required — [0,0,0] is the fallback,
  // so an origin-aimed fixture passes with the raw reach completely broken.
  it('resolveWorldTransform reads a split camera aim from the data half — statically AND through a channel', () => {
    const s = splitCamera({ lookAt: [0, 5, 0] });
    const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };
    const staticWorld = resolveWorldTransform(s, 'n_cam', ctx);
    expect(staticWorld, 'a split camera resolves a world transform at all').not.toBeNull();
    expect(staticWorld!.position).toEqual([7, 1, -4]);

    // A channel on the DATA half's lookAt. Exact-id enumeration misses it entirely.
    const dataId = cameraDataOf(s, 'n_cam')!.id;
    const animated = applyOp(s, {
      type: 'addNode',
      nodeId: 'aim_ch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'lookAt',
        target: dataId,
        paramPath: 'lookAt',
        keyframes: [
          { time: 0, value: [0, 5, 0], easing: 'linear' },
          { time: 2, value: [20, 5, 0], easing: 'linear' },
        ],
      },
    }).next;
    const at0 = resolveWorldTransform(animated, 'n_cam', ctx);
    const at2 = resolveWorldTransform(animated, 'n_cam', {
      time: { frame: 120, seconds: 2, normalized: 0 },
    });
    // The camera does not MOVE (position is unchannelled) — it TURNS. So the discriminator
    // is the ORIENTATION, not the position: a missed aim channel leaves them identical.
    // Read the field off the WorldTransform contract (`quaternion`); a mistyped field name
    // compares undefined to undefined, which a positive assertion would pass vacuously.
    expect(at0!.quaternion, 'the fixture must produce an orientation at all').toHaveLength(4);
    expect(at0!.quaternion, 'a data-half aim channel turns the camera').not.toEqual(
      at2!.quaternion,
    );
  });

  it('the strip picker excludes a split camera NESTED IN A GROUP', () => {
    // ⚠️ FIXTURE CHOICE IS LOAD-BEARING. A TOP-LEVEL camera is wired into `scene.camera`,
    // so its row carries `parent.socket:'camera'` and the socket filter excludes it on its
    // own — that fixture passes even with the possession re-key deleted. Only a camera
    // carrying a GROUP's socket isolates the camera test.
    let s = splitCamera();
    s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'grp',
      nodeType: 'Group',
      params: { name: 'Rig', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'grp', socket: 'out' },
      to: { node: 'scene', socket: 'children' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'n_cam', socket: 'out' },
      to: { node: 'grp', socket: 'children' },
    }).next;
    s = { ...s, outputs: { ...s.outputs, scene: { node: 'scene', socket: 'out' } } };

    const ids = stripTargetRows(s).map((r) => r.id);
    expect(ids, 'the positive control — the Group IS offered').toContain('grp');
    expect(ids, 'a strip on a camera folds nothing, so it must not be offered').not.toContain(
      'n_cam',
    );
  });
});

describe('#387 slice 3 — the traps a passing re-key can still leave open', () => {
  // THE GIZMO TRAP, second half. The first half — that CameraGizmo MOUNTS for a split
  // camera — is a component concern and is an e2e obligation (slice 9/10). This is the
  // half that makes the trap visible at all: even with the right gizmo mounted, the
  // camera Object HAS a `rotation` param (every Object does), and the pose road does not
  // read it. A rotate drag would turn a gizmo while the rendered camera sat still.
  it('a `rotation` written on a camera Object does not move the rendered pose', () => {
    const s = splitCamera();
    const before = resolveCameraPoseAt(s, 'n_cam', 0);
    const rotated = applyOp(s, {
      type: 'setParam',
      nodeId: 'n_cam',
      paramPath: 'rotation',
      value: [0.7, 1.4, 0.2],
    }).next;
    expect(
      rotated.nodes['n_cam'].params.rotation,
      'the fixture must actually have written a rotation',
    ).toEqual([0.7, 1.4, 0.2]);
    // The aim stays on the data half (parity-first), so `rotation` is inert by design.
    // If this ever starts failing, the camera grew a second orientation source.
    expect(resolveCameraPoseAt(rotated, 'n_cam', 0)).toEqual(before);
  });

  it('the agent can identify a split camera, and a cube is not swept in', () => {
    let s = splitCamera();
    s = applyAll(s, splitOps('box', { objectId: 'n_box' }, { data: { size: [1, 1, 1] } }));
    const r = identify({ query: 'the camera' }, s);
    expect(r.type, 'a camera noun must resolve to something').toBe('match');
    if (r.type === 'match') expect(r.selectors).toEqual(['n_cam']);
  });

  it('the agent can target a split camera for a shot', () => {
    let s = splitCamera();
    s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
    s = applyOp(s, { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} }).next;
    // Through validatePlan — the road the agent actually travels. Calling
    // `preconditions()` directly would skip the contract_scope gate, which is a
    // SEPARATE type-keyed check; a test that stops at the precondition reports the
    // half that was fixed and cannot see the half that was not.
    const spec = {
      cameraId: 'n_cam',
      sceneId: 'scene',
      startTime: 0,
      endTime: 4,
      shotId: 'shot_1',
    };
    const res = validatePlan(shotCreateMutator, spec as never, s, 'shot on a split camera');
    expect(res.ok, `shotCreate refused a split camera: ${res.ok ? '' : res.reason}`).toBe(true);
  });

  // Same road, same reason: addPass resolves the camera IMPLICITLY (no cameraId given),
  // which is the case a type-keyed `findUnique` answers "none" for post-split.
  it('the agent can add a render pass that resolves a split camera implicitly', () => {
    let s = splitCamera();
    s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
    s = applyOp(s, { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'job1',
      nodeType: 'RenderJob',
      params: {},
    }).next;
    const res = validatePlan(
      addPassMutator,
      { jobId: 'job1', passKind: 'beauty' } as never,
      s,
      'add a beauty pass',
    );
    expect(res.ok, `addPass refused a split camera: ${res.ok ? '' : res.reason}`).toBe(true);
  });
});
