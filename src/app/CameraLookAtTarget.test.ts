// CameraLookAtTarget — unit tests for the two decisions the dropdown makes
// (`lookAtTargetOptions` + `bindLookAtTargetOps`).
//
// The React shell is exercised by Playwright e2e — this project has no React Testing
// Library and new external deps are forbidden, so the decisions are tested directly.
// That split is not a convenience here: #387 makes this control span BOTH halves of a
// split camera, and both failure modes it introduces are SILENT. A Track-To authored
// against the lens half is a valid, saved, correctly-displayed constraint that no road
// reads; a self-exclusion against the lens half leaves the camera's own Object sitting
// in its own aim-target list. Neither raises an error, and the first is invisible in
// every surface except the viewport.
//
// REF: src/app/CameraLookAtTarget.tsx, src/app/nodeConstraints.ts (the stack the aim
//      resolver reads), src/app/activeCamera.ts (which enumerates constraints for the
//      OBJECT); #247 / #317 / #387.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, emptyDagState, type DagState } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { splitOps } from '../test-utils/splitKinds';
import { bindLookAtTargetOps, lookAtTargetOptions } from './CameraLookAtTarget';
import { makeSplitCube } from '../test-utils/splitCube';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';

beforeAll(() => {
  registerAllNodes();
});

const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** A split camera (`n_cam` Object posing `n_cam_data`) plus a targetable cube. The
 *  camera sits at a NON-default position so nothing here can coincide with a fallback. */
function buildScene(): DagState {
  let s = emptyDagState();
  for (const op of splitOps(
    'camera',
    { objectId: 'n_cam' },
    {
      data: { fov: 28, lookAt: [0, 1, 0] },
      object: { position: [7, 1, -4] },
    },
  )) {
    s = applyOp(s, op as Parameters<typeof applyOp>[1]).next;
  }
  // The aim target is a split cube. `lookAtTargetOptions` keeps only nodes carrying a vec3
  // `position` (CameraLookAtTarget.tsx:81), and a BoxData carries none — so the option list
  // has to leave the data half out. With a fused mesh there was no second node for that
  // filter to reject, and the exclusion was untested.
  s = makeSplitCube(s, { objectId: 'n_cube', position: [2, 0, 0], size: [1, 1, 1] }).state;
  return s;
}

const IDS = { nodeId: 'n_cam_data', poseNodeId: 'n_cam' };

/** `buildScene`, its camera aimed at the cube through the dropdown. */
function aimedAtCube(): DagState {
  let s = buildScene();
  for (const op of bindLookAtTargetOps(s, IDS, 'n_cube', CTX).ops) {
    s = applyOp(s, op as Parameters<typeof applyOp>[1]).next;
  }
  return s;
}

describe('lookAtTargetOptions', () => {
  it('offers other positioned objects and excludes the camera’s OWN Object', () => {
    const opts = lookAtTargetOptions(buildScene().nodes, 'n_cam');
    expect(opts.map((o) => o.id)).toEqual(['n_cube']);
  });

  // The failure the two-ids seam creates. Excluding the LENS half excludes nothing the
  // list would have contained anyway (a CameraData has no `position`), so the camera's
  // own Object survives the filter and a director can aim a camera at itself.
  it('excluding the LENS half instead leaves the camera’s Object in its own list', () => {
    const opts = lookAtTargetOptions(buildScene().nodes, 'n_cam_data');
    expect(opts.map((o) => o.id)).toContain('n_cam');
  });
});

describe('bindLookAtTargetOps', () => {
  it('targets the OBJECT half — the node the aim resolver reads constraints for', () => {
    const { ops, atomic } = bindLookAtTargetOps(buildScene(), IDS, 'n_cube', CTX);
    expect(atomic).toBe(false);
    expect(ops).toHaveLength(1);
    const op = ops[0] as { type: string; nodeType: string; params: Record<string, unknown> };
    expect(op.type).toBe('addNode');
    expect(op.nodeType).toBe('TrackTo');
    // THE assertion. `target: 'n_cam_data'` would be a constraint nothing reads: saved,
    // displayed by this same dropdown, and ignored by every resolver.
    expect(op.params.target).toBe('n_cam');
    expect(op.params.aimNode).toBe('n_cube');
    // The seed aim point comes from the LENS half, where `lookAt` lives. Read off the
    // Object it is absent → [0,0,0] → the camera swings through the world origin.
    expect(op.params.aimPoint).toEqual([0, 1, 0]);
    expect(op.params.order).toBe(0);
  });

  it('re-targets the existing winner rather than stacking a second constraint', () => {
    let s = buildScene();
    for (const op of bindLookAtTargetOps(s, IDS, 'n_cube', CTX).ops) {
      s = applyOp(s, op as Parameters<typeof applyOp>[1]).next;
    }
    const again = bindLookAtTargetOps(s, IDS, 'n_cube', CTX);
    expect(again.atomic).toBe(true);
    expect(again.ops).toHaveLength(1);
    const op = again.ops[0] as { type: string; paramPath: string; value: unknown };
    expect(op.type).toBe('setParam');
    expect(op.paramPath).toBe('aimNode');
  });

  it('clear freezes the resolved aim onto the LENS half, then removes the constraint', () => {
    let s = buildScene();
    for (const op of bindLookAtTargetOps(s, IDS, 'n_cube', CTX).ops) {
      s = applyOp(s, op as Parameters<typeof applyOp>[1]).next;
    }
    const { ops, label } = bindLookAtTargetOps(s, IDS, '', CTX);
    expect(label).toBe('clear look-at target');
    const freeze = ops.find((o) => o.type === 'setParam') as
      | { nodeId: string; paramPath: string; value: unknown }
      | undefined;
    expect(freeze).toBeDefined();
    // `lookAt` is a CameraData param. Frozen onto the Object it lands where nothing
    // reads it, and the camera snaps back to its stale authored aim on clear.
    expect(freeze!.nodeId).toBe('n_cam_data');
    expect(freeze!.paramPath).toBe('lookAt');
    expect(ops.some((o) => o.type === 'removeNode')).toBe(true);
  });

  // The other half of the same failure, and the one that makes the assertion above
  // load-bearing rather than decorative: the constraint is looked up for the POSE half,
  // so asking with the lens half finds nothing and "clear" emits NOTHING AT ALL — no
  // freeze, no removal. The dropdown snaps back to the still-aimed target with no error.
  it('collapsing both ids onto the LENS half makes clear a silent no-op', () => {
    let s = buildScene();
    for (const op of bindLookAtTargetOps(s, IDS, 'n_cube', CTX).ops) {
      s = applyOp(s, op as Parameters<typeof applyOp>[1]).next;
    }
    const collapsed = { nodeId: 'n_cam_data', poseNodeId: 'n_cam_data' };
    expect(bindLookAtTargetOps(s, collapsed, '', CTX).ops).toEqual([]);
    // …while the correct pair does the work. Disjoint, on one state, in one test.
    expect(bindLookAtTargetOps(s, IDS, '', CTX).ops.length).toBeGreaterThan(0);
  });

  // #1772 — a keyed rotation, hidden while the Track-To aimed the camera, takes over the moment
  // the Track-To is gone: written as a plain param, the frozen rotation lost to its keys and the
  // camera jumped 29.7° here. It goes through the animated-edit road instead (a key with Auto-Key
  // on, a held edit with it off), which the shell runs.
  it('a keyed rotation: the frozen rotation is an animated edit, not a plain write', () => {
    let s = aimedAtCube();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'rot_keys',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'rotation',
        target: 'n_cam',
        paramPath: 'rotation',
        keyframes: [
          { time: 0, value: [0, 90, 0], easing: 'linear' },
          { time: 2, value: [0, 90, 0], easing: 'linear' },
        ],
      },
    } as Parameters<typeof applyOp>[1]).next;
    const drawn = resolveEvaluatedTransform(s, 'n_cam', CTX)!.rotation!;
    const { ops, animatedWrite } = bindLookAtTargetOps(s, IDS, '', CTX);
    expect(ops.some((o) => o.type === 'setParam' && o.paramPath === 'rotation')).toBe(false);
    expect(animatedWrite?.nodeId).toBe('n_cam');
    expect(animatedWrite?.paramPath).toBe('rotation');
    (animatedWrite!.value as number[]).forEach((v, i) => expect(v).toBeCloseTo(drawn[i], 9));
    // Written as the key at this frame, the camera looks where it looked.
    for (const op of ops) s = applyOp(s, op as Parameters<typeof applyOp>[1]).next;
    s = applyOp(s, {
      type: 'setParam',
      nodeId: 'rot_keys',
      paramPath: 'keyframes',
      value: [
        { time: 0, value: animatedWrite!.value, easing: 'linear' },
        { time: 2, value: [0, 90, 0], easing: 'linear' },
      ],
    } as Parameters<typeof applyOp>[1]).next;
    const after = resolveEvaluatedTransform(s, 'n_cam', CTX)!.rotation!;
    after.forEach((v, i) => expect(v).toBeCloseTo(drawn[i], 6));
  });

  it('control: an unkeyed rotation is frozen in the one atomic clear', () => {
    const s = aimedAtCube();
    const { ops, animatedWrite } = bindLookAtTargetOps(s, IDS, '', CTX);
    expect(animatedWrite).toBeUndefined();
    expect(ops.some((o) => o.type === 'setParam' && o.paramPath === 'rotation')).toBe(true);
  });

  it('clearing an unaimed camera emits nothing', () => {
    expect(bindLookAtTargetOps(buildScene(), IDS, '', CTX).ops).toEqual([]);
  });

  // #476 — a coexistence case lived here: "a FUSED camera (one id for both jobs) is
  // unchanged", asserting that the two-ids seam collapsed harmlessly when both ids named the
  // same node. Its premise was "until slice 7 flips creation, every camera in every project
  // is still fused". Slice 7 flipped and the fused types retired, so the one-id camera is not
  // a state any project can hold. Deleted rather than retargeted: pointing it at a split pair
  // would have made it a copy of the cases above. What it guarded — that a COLLAPSED pair
  // misbehaves — is still covered, by the lens-half collapse case above it, which asserts the
  // wrong collapse silently emits nothing.
});
