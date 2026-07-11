// statefulOps — the stateful eval-contract replay seam (Epic 2, #297). Proves the
// PURE integration core (determinism / scrub-safety / seed / bounds) and the seam
// wiring: a stateful Lag node feeding a driver is DETECTED and routed to the replay,
// and the Lag's transform-source controller is threaded into the render subscription
// set (H48) and the cycle-guard deps (G6) — the two edge-less hops the input walk
// can't see. The animated end-to-end (render == read under scrub) is the live probe.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import {
  cachedIntegrate,
  integrate,
  integrateLag,
  makeStatefulDriverChannelValue,
  statefulSourceOf,
} from './statefulOps';
import { driverParamDeps, driverSubscriptionNodesForTarget } from './paramDrivers';
import { lerp } from '../nodes/valueMath';
import type { ParamDriverParams } from '../nodes/ParamDriver';

const SOLVER_ID = 'n_solver';
const PREV_ID = 'n_prev';
const INPUT_ID = 'n_input';
const MATH_ID = 'n_math';
const FPS = 60;

/** box + a scene-wired Null (tx=2) + a Solver whose sub-network is
 *  `Math(add){a←PrevFrame, b←SolverInput}` (a running accumulator of the live input),
 *  wired into a ParamDriver overlaying box.material.metalness. The Null is wired into
 *  the scene so its transform resolves (the Solver's live input reads its `tx`). */
function buildSolverAccumulatorState(): DagState {
  let state = buildDefaultDagState();
  const add = (op: Op) => {
    state = applyOp(state, op).next;
  };
  add({
    type: 'addNode',
    nodeId: NULL_ID,
    nodeType: 'Null',
    params: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  } as Op);
  add({
    type: 'connect',
    from: { node: NULL_ID, socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  } as Op);
  add({ type: 'addNode', nodeId: PREV_ID, nodeType: 'PrevFrame', params: {} } as Op);
  add({ type: 'addNode', nodeId: INPUT_ID, nodeType: 'SolverInput', params: {} } as Op);
  add({ type: 'addNode', nodeId: MATH_ID, nodeType: 'Math', params: { op: 'add' } } as Op);
  add({
    type: 'connect',
    from: { node: PREV_ID, socket: 'out' },
    to: { node: MATH_ID, socket: 'a' },
  } as Op);
  add({
    type: 'connect',
    from: { node: INPUT_ID, socket: 'out' },
    to: { node: MATH_ID, socket: 'b' },
  } as Op);
  add({
    type: 'addNode',
    nodeId: SOLVER_ID,
    nodeType: 'Solver',
    params: { seedFrame: 0, sourceTransform: { node: NULL_ID, channel: 'tx' } },
  } as Op);
  add({
    type: 'connect',
    from: { node: MATH_ID, socket: 'out' },
    to: { node: SOLVER_ID, socket: 'body' },
  } as Op);
  add({
    type: 'addNode',
    nodeId: DRV_ID,
    nodeType: 'ParamDriver',
    params: { target: BOX_ID, paramPath: 'material.metalness', blendMode: 'replace', order: 0 },
  } as Op);
  add({
    type: 'connect',
    from: { node: SOLVER_ID, socket: 'out' },
    to: { node: DRV_ID, socket: 'in' },
  } as Op);
  return state;
}

const BOX_ID = 'n_box';
const NULL_ID = 'n_null';
const LAG_ID = 'n_lag';
const CLAMP_ID = 'n_clamp';
const DRV_ID = 'n_drv';

/** box + a Null controller + a Lag (reading the Null's `tx`) wired into a ParamDriver
 *  that overlays box.material.metalness. This is the β wiring: driver ← (wired) Lag ←
 *  (transform param-ref) Null. */
// `null` source = a Lag with NO transform source (a bare wired lag); anything else is
// its `sourceTransform`. (Note: default params fire on `undefined`, so the no-source
// case must pass `null`, not `undefined`.)
function buildLagDrivenState(
  sourceTransform: unknown = { node: NULL_ID, channel: 'tx' },
): DagState {
  let state = buildDefaultDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: NULL_ID,
    nodeType: 'Null',
    params: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  } as Op).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: LAG_ID,
    nodeType: 'Lag',
    params:
      sourceTransform === null
        ? { factor: 0.3, seedFrame: 0 }
        : { factor: 0.3, seedFrame: 0, sourceTransform },
  } as Op).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: DRV_ID,
    nodeType: 'ParamDriver',
    params: { target: BOX_ID, paramPath: 'material.metalness', blendMode: 'replace', order: 0 },
  } as Op).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: LAG_ID, socket: 'out' },
    to: { node: DRV_ID, socket: 'in' },
  } as Op).next;
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('integrateLag — the pure interval/seed core', () => {
  const ramp = (f: number) => f; // input(f) = f (a rising sawtooth)

  it('seeds with the input at the seed frame (no lag at the seed)', () => {
    expect(integrateLag(ramp, 0, 0, 0.5)).toBe(0); // input(0) = 0
    expect(integrateLag((f) => f + 3, 5, 5, 0.5)).toBe(8); // input(5) = 8
  });

  it('closes `factor` of the gap toward the input each frame', () => {
    // seed out=0; f=1: lagStep(0,1,0.5)=0.5; f=2: lagStep(0.5,2,0.5)=1.25
    expect(integrateLag(ramp, 0, 1, 0.5)).toBe(0.5);
    expect(integrateLag(ramp, 0, 2, 0.5)).toBe(1.25);
  });

  it('factor 1 snaps to the input at the target frame (no lag)', () => {
    expect(integrateLag(ramp, 0, 10, 1)).toBe(10);
  });

  it('is deterministic / scrub-safe — same target frame, same value regardless of call order', () => {
    const at7a = integrateLag(ramp, 0, 7, 0.3);
    integrateLag(ramp, 0, 20, 0.3); // a "forward scrub" in between
    const at7b = integrateLag(ramp, 0, 7, 0.3); // back to 7
    expect(at7b).toBe(at7a);
  });

  it('trails a rising input (lagged value is BELOW the instantaneous input)', () => {
    const at10 = integrateLag(ramp, 0, 10, 0.3);
    expect(at10).toBeGreaterThan(0);
    expect(at10).toBeLessThan(10); // it trails — hasn't caught up to input(10)=10
  });

  it('backward of the seed there is nothing to integrate → raw input at that frame', () => {
    expect(integrateLag(ramp, 5, 2, 0.3)).toBe(2); // start=2, no loop → input(2)
  });

  it('bounds a pathological seed without diverging (the replay cap)', () => {
    const v = integrateLag((f) => (f % 2 === 0 ? 0 : 10), -1_000_000, 5, 0.3);
    expect(Number.isFinite(v)).toBe(true);
  });
});

// S (#300) — the TUPLE-state Solver: a 2nd-order vec spring. State is TWO Vec3 slots
// (position + velocity); the sub-network is the semi-implicit Euler recurrence
//   newVel = prevVel + k·(target − prevPos) − c·prevVel   (slot 1)
//   newPos = prevPos + newVel                             (slot 0)
// built from Vec3Math nodes reading PrevFrameVec(slot)/SolverInputVec leaves. The
// controller (a keyframed Null stepping 0→5) is the live target.
const SPRING_NULL = 'n_sp_null';
function buildSpringState(k = 0.1, c = 0.1): { state: DagState; solverId: string } {
  let state = buildDefaultDagState();
  const add = (op: Op) => {
    state = applyOp(state, op).next;
  };
  const N = (t: string) => `sp_${t}`;
  add({
    type: 'addNode',
    nodeId: SPRING_NULL,
    nodeType: 'Null',
    params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  } as Op);
  add({
    type: 'connect',
    from: { node: SPRING_NULL, socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  } as Op);
  add({
    type: 'addNode',
    nodeId: N('chan'),
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 't',
      target: SPRING_NULL,
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 1 / 60, value: [5, 0, 0], easing: 'linear' },
      ],
    },
  } as Op);
  add({ type: 'addNode', nodeId: N('in'), nodeType: 'SolverInputVec', params: {} } as Op);
  add({ type: 'addNode', nodeId: N('pp'), nodeType: 'PrevFrameVec', params: { slot: 0 } } as Op);
  add({ type: 'addNode', nodeId: N('pv'), nodeType: 'PrevFrameVec', params: { slot: 1 } } as Op);
  const wire = (from: string, fs: string, to: string, ts: string) =>
    add({ type: 'connect', from: { node: from, socket: fs }, to: { node: to, socket: ts } } as Op);
  add({ type: 'addNode', nodeId: N('e'), nodeType: 'Vec3Math', params: { op: 'sub' } } as Op);
  wire(N('in'), 'out', N('e'), 'a');
  wire(N('pp'), 'out', N('e'), 'b');
  add({
    type: 'addNode',
    nodeId: N('ke'),
    nodeType: 'Vec3Math',
    params: { op: 'scale', scalar: k },
  } as Op);
  wire(N('e'), 'out', N('ke'), 'a');
  add({
    type: 'addNode',
    nodeId: N('cv'),
    nodeType: 'Vec3Math',
    params: { op: 'scale', scalar: c },
  } as Op);
  wire(N('pv'), 'out', N('cv'), 'a');
  add({ type: 'addNode', nodeId: N('acc'), nodeType: 'Vec3Math', params: { op: 'sub' } } as Op);
  wire(N('ke'), 'out', N('acc'), 'a');
  wire(N('cv'), 'out', N('acc'), 'b');
  add({ type: 'addNode', nodeId: N('nv'), nodeType: 'Vec3Math', params: { op: 'add' } } as Op);
  wire(N('pv'), 'out', N('nv'), 'a');
  wire(N('acc'), 'out', N('nv'), 'b');
  add({ type: 'addNode', nodeId: N('np'), nodeType: 'Vec3Math', params: { op: 'add' } } as Op);
  wire(N('pp'), 'out', N('np'), 'a');
  wire(N('nv'), 'out', N('np'), 'b');
  add({
    type: 'addNode',
    nodeId: N('solver'),
    nodeType: 'Solver',
    params: { seedFrame: 0, sourceTransformVec: { node: SPRING_NULL } },
  } as Op);
  wire(N('np'), 'out', N('solver'), 'bodies'); // slot 0 = new position
  wire(N('nv'), 'out', N('solver'), 'bodies'); // slot 1 = new velocity
  return { state, solverId: N('solver') };
}

const SPRING_DRIVER: ParamDriverParams = {
  target: BOX_ID,
  paramPath: 'position',
  blendMode: 'replace',
  order: 0,
} as unknown as ParamDriverParams;

function springX(state: DagState, solverId: string, frame: number): number {
  const ch = makeStatefulDriverChannelValue(state, SPRING_DRIVER, state.nodes[solverId]);
  const v = ch.sample(frame / FPS);
  return Array.isArray(v) ? v[0] : NaN;
}

describe('the tuple-state Solver — a 2nd-order vec spring (S, #300)', () => {
  it('overshoots the target then settles to it (a genuine 2nd-order response)', () => {
    const { state, solverId } = buildSpringState();
    const peak = Math.max(...Array.from({ length: 30 }, (_, i) => springX(state, solverId, i * 3)));
    expect(peak).toBeGreaterThan(5); // overshoots past the target (impossible for a 1st-order lag)
    expect(springX(state, solverId, 180)).toBeCloseTo(5, 1); // settles onto the target
  });

  it('is scrub-deterministic — a frame samples the same regardless of call order', () => {
    const { state, solverId } = buildSpringState();
    const a = springX(state, solverId, 30);
    springX(state, solverId, 200); // a forward "scrub" in between
    const b = springX(state, solverId, 30); // back to 30
    expect(b).toBe(a);
  });

  it('folds a Vec3 channel — a vec Solver drives a Vector3 target', () => {
    const { state, solverId } = buildSpringState();
    const ch = makeStatefulDriverChannelValue(state, SPRING_DRIVER, state.nodes[solverId]);
    expect(ch.valueType).toBe('vec3');
    expect(Array.isArray(ch.sample(1))).toBe(true);
  });

  it('statefulSourceOf detects a vec Solver wired to a driver inVec', () => {
    let { state } = buildSpringState();
    const { solverId } = buildSpringState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_vdrv',
      nodeType: 'ParamDriver',
      params: { target: BOX_ID, paramPath: 'position', blendMode: 'replace', order: 0 },
    } as Op).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: solverId, socket: 'outVec' },
      to: { node: 'n_vdrv', socket: 'inVec' },
    } as Op).next;
    expect(statefulSourceOf(state.nodes['n_vdrv'], state)?.id).toBe(solverId);
  });
});

describe('statefulSourceOf — routing a stateful source to the replay', () => {
  it('detects a Lag wired into a driver’s `in`', () => {
    const state = buildLagDrivenState();
    const driver = state.nodes[DRV_ID];
    expect(statefulSourceOf(driver, state)?.id).toBe(LAG_ID);
  });

  it('returns null for a non-stateful (Clamp) source', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: CLAMP_ID,
      nodeType: 'Clamp',
      params: { min: 0.5, max: 1 },
    } as Op).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: DRV_ID,
      nodeType: 'ParamDriver',
      params: { target: BOX_ID, paramPath: 'material.metalness' },
    } as Op).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: CLAMP_ID, socket: 'out' },
      to: { node: DRV_ID, socket: 'in' },
    } as Op).next;
    expect(statefulSourceOf(state.nodes[DRV_ID], state)).toBeNull();
  });

  it('returns null for an unwired driver', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: DRV_ID,
      nodeType: 'ParamDriver',
      params: { target: BOX_ID, paramPath: 'material.metalness' },
    } as Op).next;
    expect(statefulSourceOf(state.nodes[DRV_ID], state)).toBeNull();
  });
});

describe('the two edge-less hops through a stateful source', () => {
  it('cycle-guard deps include the Lag → controller hop (G6)', () => {
    const state = buildLagDrivenState();
    const deps = driverParamDeps(state.nodes);
    // driver → target and Lag → controller are both present
    expect(deps[BOX_ID]).toContain(DRV_ID);
    expect(deps[LAG_ID]).toContain(NULL_ID);
  });

  it('render subscription set includes the Lag AND its controller (H48)', () => {
    const state = buildLagDrivenState();
    const subs = driverSubscriptionNodesForTarget(state.nodes, BOX_ID).map((n) => n.id);
    expect(subs).toContain(LAG_ID); // reached via the wired driver.in edge
    expect(subs).toContain(NULL_ID); // reached via the Lag's transform param-ref
  });

  it('omits the controller hop when the Lag has no transform source', () => {
    const state = buildLagDrivenState(null);
    const deps = driverParamDeps(state.nodes);
    expect(deps[LAG_ID]).toBeUndefined();
  });
});

describe('the Solver meta-op — a sub-network cooked every frame', () => {
  it('a Mix sub-network reproduces Lag EXACTLY (the engine proof)', () => {
    // The Solver step over `Mix{a←PrevFrame, b←SolverInput, factor}` is
    // lerp(prev, in, factor) == lagStep — so a Solver wrapping one Mix must produce the
    // byte-identical value Lag produces. Proven at the integrate core (pure, no state).
    const ramp = (f: number) => f;
    const factor = 0.3;
    const solverStep = (prev: number, f: number) => lerp(prev, ramp(f), factor);
    for (const target of [0, 1, 5, 12, 30]) {
      expect(integrate(0, target, ramp, solverStep)).toBe(integrateLag(ramp, 0, target, factor));
    }
  });

  it('the integrate core folds an arbitrary recurrence (accumulator)', () => {
    // A running accumulator of a constant input 2: seed=2, then +2 each frame.
    expect(
      integrate(
        0,
        0,
        () => 2,
        (prev) => prev + 2,
      ),
    ).toBe(2);
    expect(
      integrate(
        0,
        3,
        () => 2,
        (prev) => prev + 2,
      ),
    ).toBe(8);
  });

  it('cooks the sub-network per frame with Prev_Frame + live input injected (end-to-end)', () => {
    // The accumulator Solver: Math(add){PrevFrame, SolverInput=Null.tx=2}. seed=2, then
    // out(f) = out(f−1) + 2. Exercises closure discovery + evaluate overrides + the fold.
    const state = buildSolverAccumulatorState();
    const cv = makeStatefulDriverChannelValue(
      state,
      state.nodes[DRV_ID].params as ParamDriverParams,
      state.nodes[SOLVER_ID],
    );
    expect(cv.sample(0)).toBe(2); // seed = live input at seedFrame 0
    expect(cv.sample(1 / FPS)).toBe(4);
    expect(cv.sample(2 / FPS)).toBe(6);
    expect(cv.sample(3 / FPS)).toBe(8);
  });

  it('is scrub-deterministic — same frame lands the same value regardless of call order', () => {
    const state = buildSolverAccumulatorState();
    const cv = makeStatefulDriverChannelValue(
      state,
      state.nodes[DRV_ID].params as ParamDriverParams,
      state.nodes[SOLVER_ID],
    );
    const at3a = cv.sample(3 / FPS);
    cv.sample(20 / FPS); // a forward scrub in between
    expect(cv.sample(3 / FPS)).toBe(at3a); // back to 3 → identical
  });

  it('is detected as a stateful source + wires its body closure and controller (H48/G6)', () => {
    const state = buildSolverAccumulatorState();
    expect(statefulSourceOf(state.nodes[DRV_ID], state)?.id).toBe(SOLVER_ID);

    const subs = driverSubscriptionNodesForTarget(state.nodes, BOX_ID).map((n) => n.id);
    // The Solver, its whole sub-network (reached via the wired `body` closure), and the
    // controller (reached via the Solver's transform param-ref) all subscribe.
    expect(subs).toEqual(expect.arrayContaining([SOLVER_ID, MATH_ID, PREV_ID, INPUT_ID, NULL_ID]));

    const deps = driverParamDeps(state.nodes);
    expect(deps[BOX_ID]).toContain(DRV_ID);
    expect(deps[SOLVER_ID]).toContain(NULL_ID); // the Solver → controller hop (G6)
  });
});

describe('cachedIntegrate — the O(1) history cache (transparent + sound-by-epoch)', () => {
  // A distinct DagState identity per test is the epoch; only the object reference matters
  // to the cache, so a bare cast object is a faithful key.
  const epoch = () => ({}) as unknown as DagState;
  const ramp = (f: number) => f;
  const accum = (prev: number, f: number) => prev + f; // an order-sensitive recurrence

  it('returns EXACTLY the uncached integrate for every frame, regardless of sample order', () => {
    const st = epoch();
    // Sample a scrambled order (jump forward, back, mid) — each must equal the oracle.
    for (const f of [30, 5, 30, 12, 1, 30, 0, 25]) {
      expect(cachedIntegrate(st, 'n', 0, f, ramp, accum)).toBe(integrate(0, f, ramp, accum));
    }
  });

  it('a cached frame is a LOOKUP, not a recompute (the step is not re-invoked)', () => {
    const st = epoch();
    let stepCalls = 0;
    const counting = (prev: number, f: number) => {
      stepCalls++;
      return prev + f;
    };
    cachedIntegrate(st, 'n', 0, 100, ramp, counting); // builds frames 1..100
    expect(stepCalls).toBe(100);
    stepCalls = 0;
    cachedIntegrate(st, 'n', 0, 50, ramp, counting); // backward → pure lookup
    cachedIntegrate(st, 'n', 0, 100, ramp, counting); // already built → pure lookup
    expect(stepCalls).toBe(0);
  });

  it('extends forward incrementally (only the NEW frames cost a step)', () => {
    const st = epoch();
    let stepCalls = 0;
    const counting = (prev: number, f: number) => {
      stepCalls++;
      return prev + f;
    };
    cachedIntegrate(st, 'n', 0, 10, ramp, counting);
    expect(stepCalls).toBe(10);
    cachedIntegrate(st, 'n', 0, 15, ramp, counting); // only frames 11..15 are new
    expect(stepCalls).toBe(15);
  });

  it('a NEW epoch (state identity) drops the block — a changed recurrence is reflected', () => {
    const st1 = epoch();
    expect(cachedIntegrate(st1, 'n', 0, 3, ramp, accum)).toBe(integrate(0, 3, ramp, accum));
    // Same nodeId, a DIFFERENT state object (an edit), a DIFFERENT step → new value, no stale.
    const st2 = epoch();
    const doubleAccum = (prev: number, f: number) => prev + 2 * f;
    expect(cachedIntegrate(st2, 'n', 0, 3, ramp, doubleAccum)).toBe(
      integrate(0, 3, ramp, doubleAccum),
    );
  });

  it('frames before the seed bypass the cache (no recurrence there)', () => {
    const st = epoch();
    // seed=5, target=2 (before seed) → seedAt(2), matching the uncached integrate.
    expect(cachedIntegrate(st, 'n', 5, 2, ramp, accum)).toBe(integrate(5, 2, ramp, accum));
    expect(cachedIntegrate(st, 'n', 5, 2, ramp, accum)).toBe(2); // seedAt(2) = ramp(2)
  });

  it('two nodes in one epoch keep independent blocks', () => {
    const st = epoch();
    const a = cachedIntegrate(st, 'a', 0, 8, ramp, accum);
    const b = cachedIntegrate(st, 'b', 0, 8, ramp, (prev, f) => prev + 2 * f);
    expect(a).toBe(integrate(0, 8, ramp, accum));
    expect(b).toBe(integrate(0, 8, ramp, (prev, f) => prev + 2 * f));
    expect(a).not.toBe(b);
  });
});
