// #902 — the resolver: the only thing that performs a generation.
//
// The row that carries the phase is "a landed result escapes an already-warm
// evaluator cache". Without it every other row here still passes and the clip
// never reaches the screen, because a generation changes neither the node's
// params nor its inputs — so its cache key is unchanged and a warm cache keeps
// serving the `pending` value it already computed.

import { beforeEach, describe, expect, it } from 'vitest';
import { createEvaluatorCache, evaluate } from '../../core/dag/evaluator';
import { applyOp } from '../../core/dag/ops';
import { emptyDagState } from '../../core/dag/state';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetGeneratedClipsForTests } from '../../core/motiongen/generatedClipCache';
import {
  synthesiseBvh,
  STUB_UNIT_SCALE,
} from '../../core/motiongen/StubMotionGenerationCapability';
import type {
  MotionGenerationCapability,
  MotionGenerationRequest,
  MotionGenerationResult,
} from '../../core/motiongen/MotionGenerationCapability';
import type { AnimationClipValue } from '../../nodes/types';
import { resolvePendingMotionGenerations } from './resolveMotionGenerate';

/** A capability that COUNTS. The count is the measurement for every row about
 *  not paying twice — a boolean "did it work" cannot see a duplicate request. */
function countingCapability(opts: { fail?: string } = {}) {
  const requests: MotionGenerationRequest[] = [];
  const cap: MotionGenerationCapability = {
    id: 'counting',
    kind: 'stub',
    isAvailable: async () => true,
    async generate(request): Promise<MotionGenerationResult> {
      requests.push(request);
      if (opts.fail) throw new Error(opts.fail);
      return {
        jobId: `job-${requests.length}`,
        bvh: synthesiseBvh(request),
        model: request.model,
        unitScale: STUB_UNIT_SCALE,
        worldOffsetXZ: request.constraints?.waypoints ? [3, -1] : null,
      };
    },
    cancel: async () => {},
  };
  return { cap, requests };
}

function withGenerator(nodeId = 'gen', params: Record<string, unknown> = {}): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId,
    nodeType: 'MotionGenerate',
    params: { prompt: 'a slow walk', seed: 7, model: 'kimodo-base', ...params },
  } as Op).next;
  return s;
}

/** ...and one with a real curve wired through an Object, as a director would. */
function withPath(): DagState {
  let s = withGenerator();
  for (const op of [
    { type: 'addNode', nodeId: 'curve', nodeType: 'CurveData', params: {} },
    { type: 'addNode', nodeId: 'obj', nodeType: 'Object', params: {} },
    { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} },
    {
      type: 'connect',
      from: { node: 'curve', socket: 'out' },
      to: { node: 'obj', socket: 'data' },
    },
    { type: 'connect', from: { node: 'obj', socket: 'out' }, to: { node: 'gen', socket: 'path' } },
  ] as Op[]) {
    s = applyOp(s, op).next;
  }
  return s;
}

const clip = (s: DagState, id = 'gen', cache?: ReturnType<typeof createEvaluatorCache>) =>
  evaluate(s, id, cache ? { cache } : {}).value as AnimationClipValue;

describe('resolvePendingMotionGenerations (#902)', () => {
  beforeEach(() => {
    registerAllNodes();
    __resetGeneratedClipsForTests();
  });

  it('generates a pending node and the clip becomes ready with real keys', async () => {
    const s = withGenerator();
    expect(clip(s).generation?.status).toBe('pending');

    const { cap, requests } = countingCapability();
    const out = await resolvePendingMotionGenerations(s, cap);

    // #935 — a generated row carries the BYTES as well as the verdict. This call is
    // the only place they exist: the content store keeps parsed keyframes, and
    // nothing can turn those back into a file, so a row that dropped them would
    // make the clip unsaveable.
    expect(out).toEqual([
      {
        nodeId: 'gen',
        requestHash: expect.any(String),
        outcome: 'generated',
        bvh: expect.any(String),
        model: 'kimodo-base',
      },
    ]);
    expect(out[0].bvh!.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].prompt).toBe('a slow walk');
    expect(requests[0].seed).toBe(7);

    const after = clip(s);
    expect(after.generation?.status).toBe('ready');
    expect(after.keyframes.length).toBeGreaterThan(0);
    expect(after.skeleton.bones.length).toBeGreaterThan(0);
    expect(after.duration).toBeGreaterThan(0);
  });

  // ── THE ROW THE PHASE RESTS ON ──────────────────────────────────────────
  it('a landed result escapes an ALREADY-WARM evaluator cache', async () => {
    const s = withGenerator();
    const cache = createEvaluatorCache();

    // Warm it on the pending value, exactly as a render pass would.
    expect(clip(s, 'gen', cache).generation?.status).toBe('pending');
    expect(cache.size()).toBeGreaterThan(0);

    const { cap } = countingCapability();
    await resolvePendingMotionGenerations(s, cap);

    // Same graph, same cache, same cache KEY — the params and inputs did not
    // change. Only the epoch did.
    expect(clip(s, 'gen', cache).generation?.status).toBe('ready');
  });

  it('does not pay twice: a second pass over a resolved graph issues no request', async () => {
    const s = withGenerator();
    const { cap, requests } = countingCapability();
    await resolvePendingMotionGenerations(s, cap);
    const second = await resolvePendingMotionGenerations(s, cap);
    expect(requests).toHaveLength(1);
    expect(second).toEqual([]); // nothing is pending any more
  });

  it('two nodes with identical params share ONE generation', async () => {
    let s = withGenerator('a');
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'b',
      nodeType: 'MotionGenerate',
      params: { prompt: 'a slow walk', seed: 7, model: 'kimodo-base' },
    } as Op).next;

    const { cap, requests } = countingCapability();
    const out = await resolvePendingMotionGenerations(s, cap);

    expect(requests).toHaveLength(1);
    expect(out.map((r) => r.outcome)).toEqual(['generated', 'skipped']);
    // Both nodes are nevertheless ready — the shared hash IS the sharing.
    expect(clip(s, 'a').generation?.status).toBe('ready');
    expect(clip(s, 'b').generation?.status).toBe('ready');
  });

  // Found by falsification: disabling the in-flight guard reddened NOTHING, so
  // it had no coverage at all. The sequential loop records a hash before the
  // next node is considered, so only CONCURRENT passes can reach it — which is
  // the real case, since the resolver is called from a render-side reaction.
  it('two CONCURRENT passes issue one request, not two', async () => {
    const s = withGenerator();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const requests: MotionGenerationRequest[] = [];
    const cap: MotionGenerationCapability = {
      id: 'slow',
      kind: 'stub',
      isAvailable: async () => true,
      async generate(request) {
        requests.push(request);
        await gate; // still in flight when the second pass starts
        return {
          jobId: 'j',
          bvh: synthesiseBvh(request),
          model: request.model,
          unitScale: STUB_UNIT_SCALE,
          worldOffsetXZ: null,
        };
      },
      cancel: async () => {},
    };

    const first = resolvePendingMotionGenerations(s, cap);
    const second = resolvePendingMotionGenerations(s, cap);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(requests).toHaveLength(1);
    // The pair carries the claim: one pass generated, the other stood down
    // because the SAME request was already being paid for.
    expect([a[0].outcome, b[0].outcome].sort()).toEqual(['generated', 'skipped']);
    expect(b[0].reason ?? a[0].reason).toBe('already generating');
  });

  it('a refusal is terminal and is NOT retried on the next pass', async () => {
    const s = withGenerator();
    const { cap, requests } = countingCapability({ fail: 'motion service unreachable' });

    const first = await resolvePendingMotionGenerations(s, cap);
    expect(first[0].outcome).toBe('failed');
    expect(clip(s).generation?.status).toBe('failed');
    expect(clip(s).generation?.reason).toContain('unreachable');

    await resolvePendingMotionGenerations(s, cap);
    // The whole point: one unreachable server must not become a request stream.
    expect(requests).toHaveLength(1);
  });

  it('a wired curve reaches the capability as waypoints, and its offset comes back', async () => {
    const s = withPath();
    const { cap, requests } = countingCapability();
    await resolvePendingMotionGenerations(s, cap);

    const sent = requests[0].constraints?.waypoints;
    expect(sent).toBeTruthy();
    expect(sent!.length).toBeGreaterThan(1);
    // Waypoints are ground positions: an {x,z} pair, never a 3-wide point.
    expect(Object.keys(sent![0]).sort()).toEqual(['x', 'z']);
    // ANTI-VACUITY: the path must actually go somewhere, or "it sent waypoints"
    // is true of a curve collapsed to a single repeated point.
    expect(sent![0]).not.toEqual(sent![sent!.length - 1]);

    expect(clip(s).generation?.worldOffsetXZ).toEqual([3, -1]);
  });

  it('a generator with no path sends no constraints, and reports a null offset', async () => {
    const s = withGenerator();
    const { cap, requests } = countingCapability();
    await resolvePendingMotionGenerations(s, cap);
    expect(requests[0].constraints).toBeUndefined();
    // null, not [0,0] — "nobody asked" is not "it belongs at the origin".
    expect(clip(s).generation?.worldOffsetXZ).toBeNull();
  });
});
