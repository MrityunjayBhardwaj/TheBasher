// cameraNode — the possession-keyed camera predicates (#387 C4 slice 3).
//
// Every test here asserts BOTH forms: the split Object+CameraData AND the fused camera
// that still exists until the fused types retire. A one-form test cannot tell a correct
// coexistence predicate from one that answers for the form the fixture happens to build.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, emptyDagState, type DagState } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { splitOps } from '../test-utils/splitKinds';
import { cameraDataOf, cameraLensParams, cameraProjectionOf, isCameraNode } from './cameraNode';
import { enumerateCameraNodeIds } from './activeCamera';
import { buildSetActiveCameraOps } from './setActiveCamera';
import { resolveWorldTransform } from './resolveWorldTransform';
import { stripTargetRows } from '../timeline/NlaAddStripPopover';

beforeAll(() => {
  __reseedAllNodesForTests();
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

function fusedCamera(type = 'PerspectiveCamera'): DagState {
  return applyOp(emptyDagState(), {
    type: 'addNode',
    nodeId: 'n_cam',
    nodeType: type,
    params: { fov: 28, position: [7, 1, -4], lookAt: [0, 1, 0] },
  }).next;
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

  it('is null for a fused camera (there is no data half) and for a missing node', () => {
    expect(cameraDataOf(fusedCamera(), 'n_cam')).toBeNull();
    expect(cameraDataOf(emptyDagState(), 'nope')).toBeNull();
  });
});

describe('cameraNode — isCameraNode (possession, not identity)', () => {
  it('accepts BOTH forms: the split Object and both fused types', () => {
    expect(isCameraNode(splitCamera(), 'n_cam'), 'split').toBe(true);
    expect(isCameraNode(fusedCamera('PerspectiveCamera'), 'n_cam'), 'fused persp').toBe(true);
    expect(isCameraNode(fusedCamera('OrthographicCamera'), 'n_cam'), 'fused ortho').toBe(true);
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

  it('maps both fused types onto the same vocabulary', () => {
    expect(cameraProjectionOf(fusedCamera('PerspectiveCamera'), 'n_cam')).toBe('Perspective');
    expect(cameraProjectionOf(fusedCamera('OrthographicCamera'), 'n_cam')).toBe('Orthographic');
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

  it('returns the node itself for a fused camera, which owns everything', () => {
    const params = cameraLensParams(fusedCamera(), 'n_cam');
    expect(params?.fov).toBe(28);
    expect(params?.position).toEqual([7, 1, -4]);
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
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'n_cam_fused',
      nodeType: 'OrthographicCamera',
      params: { zoom: 1, position: [0, 0, 5], lookAt: [0, 0, 0] },
    }).next;
    expect(enumerateCameraNodeIds(s)).toEqual(['n_cam', 'n_cam_fused']);
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
