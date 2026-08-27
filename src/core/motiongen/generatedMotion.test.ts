// A1 — text-to-motion. These tests pin the one claim the phase makes: a generated
// clip is indistinguishable, downstream, from an imported one.
//
// The strongest of them is "the identical road": the Ops produced for a generated
// clip are deep-equal to the Ops `buildBvhImportOps` produces for the same text.
// Equality there is what makes a provenance branch unconstructible rather than
// merely absent today.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, evaluate } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildBvhImportOps, __resetBvhImportCounterForTests } from '../import/bvhImportChain';
import { retargetClip } from '../import/retarget';
import { parseBvh } from '../import/bvh';
import { StubMotionGenerationCapability, synthesiseBvh } from './StubMotionGenerationCapability';
import { HttpMotionGenerationCapability } from './HttpMotionGenerationCapability';
import { buildGeneratedMotionOps } from './generatedMotionChain';
import { ModelNotLicensedError } from '../licensing/allowedModels';
import { aBlockedRecord } from '../licensing/blockedModelForTests';
import type { AnimationClipValue, BoneSpec } from '../../nodes/types';
import type { DagState } from '../dag/state';

const ALLOWED_MODEL = 'Kimodo-SOMA-RP-v1.1';

// Derived, not spelled out — and not because of a lint rule. Naming a blocked
// checkpoint here would make the build-time gate red on this very file, and the
// gate is right to: it cannot tell "uses it" from "tests that we refuse it".
// Deriving removes the need for an exemption altogether, and keeps the test
// correct if a verdict ever changes. Four files now need this, so it lives in
// one place rather than being rediscovered per suite.
const BLOCKED_MODEL = aBlockedRecord().id;
const IDS = { skeleton: 'gen_skel', clip: 'gen_clip' };

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetBvhImportCounterForTests();
});

function stateWithTime(): DagState {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  return s;
}

function applyAll(state: DagState, ops: ReturnType<typeof buildBvhImportOps>['ops']): DagState {
  let s = state;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

describe('the stub is deterministic, and actually generates', () => {
  it('returns identical BVH for an identical request', async () => {
    const cap = new StubMotionGenerationCapability();
    const req = { prompt: 'a slow walk', model: ALLOWED_MODEL };
    const a = await cap.generate(req);
    const b = await cap.generate(req);
    expect(a.bvh).toBe(b.bvh);
  });

  it('returns different motion for a different prompt', async () => {
    const cap = new StubMotionGenerationCapability();
    const a = await cap.generate({ prompt: 'a slow walk', model: ALLOWED_MODEL });
    const b = await cap.generate({ prompt: 'a fast sprint', model: ALLOWED_MODEL });
    expect(a.bvh).not.toBe(b.bvh);
  });

  it('emits BVH the real parser accepts, not a placeholder token', async () => {
    // A stub returning a sentinel would let every test below pass while proving
    // nothing about whether generated motion can travel the import road.
    const cap = new StubMotionGenerationCapability();
    const { bvh } = await cap.generate({
      prompt: 'wave',
      model: ALLOWED_MODEL,
      fps: 30,
      seconds: 1,
    });
    const parsed = parseBvh(bvh, 'generated');
    expect(parsed.skeletonParams.bones.length).toBeGreaterThan(1);
    expect(parsed.clipParams.keyframes.length).toBeGreaterThan(0);
  });

  it('honours fps and duration in the frame count', async () => {
    const bvh = synthesiseBvh({ prompt: 'x', model: ALLOWED_MODEL, fps: 24, seconds: 2 });
    expect(bvh).toContain('Frames: 48');
  });
});

describe('the licence gate refuses at run time (#739)', () => {
  it('refuses a BLOCKED checkpoint', async () => {
    const cap = new StubMotionGenerationCapability();
    await expect(cap.generate({ prompt: 'walk', model: BLOCKED_MODEL })).rejects.toThrow(
      ModelNotLicensedError,
    );
  });

  it('refuses an UNRECORDED model rather than waving it through', async () => {
    // Default-deny. A newly published checkpoint, or a name an agent invented,
    // must not pass merely because no verdict has been written for it.
    const cap = new StubMotionGenerationCapability();
    await expect(cap.generate({ prompt: 'walk', model: 'SomeNewModel-v9' })).rejects.toThrow(
      /no recorded licence verdict/,
    );
  });

  it('allows a sibling checkpoint of the same release', async () => {
    // Six of the seven Kimodo checkpoints are usable; the refusal must be keyed
    // to the checkpoint, not to the family.
    const cap = new StubMotionGenerationCapability();
    await expect(cap.generate({ prompt: 'walk', model: 'Kimodo-G1-RP-v1' })).resolves.toBeTruthy();
  });

  it('refuses BEFORE issuing the request over HTTP', async () => {
    // A refusal after the call has gone out has already made the use it exists
    // to prevent — and for a non-commercial licence, the use IS the violation.
    const fetchImpl = vi.fn();
    const cap = new HttpMotionGenerationCapability({
      serverUrl: 'http://localhost:9999',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(cap.generate({ prompt: 'walk', model: BLOCKED_MODEL })).rejects.toThrow(
      ModelNotLicensedError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the identical road — the phase's discriminating observation", () => {
  it('produces Ops deep-equal to what an imported BVH of the same text produces', async () => {
    const cap = new StubMotionGenerationCapability();
    const state = stateWithTime();
    const generated = await buildGeneratedMotionOps(
      cap,
      { request: { prompt: 'a slow walk', model: ALLOWED_MODEL }, name: 'clip', ids: IDS },
      state,
    );
    const bvh = synthesiseBvh({ prompt: 'a slow walk', model: ALLOWED_MODEL });
    const imported = buildBvhImportOps({ text: bvh, name: 'clip', ids: IDS }, state);

    // Not "similar". Equal. The generated path calls the imported path.
    expect(generated.ops).toEqual(imported.ops);
    expect(generated.skeletonId).toBe(imported.skeletonId);
    expect(generated.clipId).toBe(imported.clipId);
  });

  it('yields no node type, param or socket an import does not also yield', async () => {
    const cap = new StubMotionGenerationCapability();
    const state = stateWithTime();
    const { ops } = await buildGeneratedMotionOps(
      cap,
      { request: { prompt: 'walk', model: ALLOWED_MODEL }, ids: IDS },
      state,
    );
    const nodeTypes = ops.filter((o) => o.type === 'addNode').map((o) => o.nodeType);
    expect(nodeTypes.sort()).toEqual(['AnimationClip', 'Skeleton']);
    // Nothing records provenance in the graph, because nothing may branch on it.
    expect(JSON.stringify(ops)).not.toMatch(/generated|provenance|kimodo/i);
  });

  it('evaluates to a working AnimationClip', async () => {
    const cap = new StubMotionGenerationCapability();
    let state = stateWithTime();
    const { ops, clipId } = await buildGeneratedMotionOps(
      cap,
      { request: { prompt: 'walk', model: ALLOWED_MODEL }, ids: IDS, timeSourceId: 'time' },
      state,
    );
    state = applyAll(state, ops);
    const clip = evaluate(state, clipId, {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    }).value as AnimationClipValue;
    // Same assertions the imported-BVH test makes on its clip, deliberately —
    // if a generated clip needed a weaker check, it would not be the same object.
    expect(clip.kind).toBe('AnimationClip');
    expect(clip.duration).toBeGreaterThan(0);
    expect(clip.pose.kind).toBe('PosedSkeleton');
    expect(clip.pose.poses.length).toBeGreaterThan(0);
  });

  it('retargets onto a different skeleton like any other clip', async () => {
    // The plain-language form of the claim: retarget does not know, and cannot
    // ask, that this motion was generated.
    const cap = new StubMotionGenerationCapability();
    const { bvh } = await cap.generate({ prompt: 'walk', model: ALLOWED_MODEL, seconds: 1 });
    const parsed = parseBvh(bvh, 'generated');
    const targetBones: BoneSpec[] = parsed.skeletonParams.bones.map((b, i) => ({
      ...b,
      name: `target_${i}`,
    }));
    const nameMap = Object.fromEntries(
      parsed.skeletonParams.bones.map((b, i) => [b.name, `target_${i}`]),
    );

    const result = retargetClip({
      sourceBones: parsed.skeletonParams.bones,
      sourceClip: {
        name: parsed.clipParams.name,
        duration: parsed.clipParams.duration,
        keyframes: parsed.clipParams.keyframes,
      },
      targetBones,
      nameMap,
    });

    expect(result.clipParams.keyframes.length).toBeGreaterThan(0);
    expect(result.unmappedSourceBones).toEqual([]);
  });
});

describe('the HTTP capability', () => {
  it('sends the prompt and asks for BVH', async () => {
    // Params are declared so `mock.calls[0]` is a typed tuple. Without them the
    // inferred call signature takes zero arguments and every read of the recorded
    // call is an `any`-shaped cast — which the project typecheck would not catch,
    // because it excludes test files.
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ jobId: 'j1', bvh: 'HIERARCHY', model: ALLOWED_MODEL }), {
          status: 200,
        }),
    );
    const cap = new HttpMotionGenerationCapability({
      serverUrl: 'http://localhost:9999/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await cap.generate({ prompt: 'a slow walk', model: ALLOWED_MODEL });
    expect(result.bvh).toBe('HIERARCHY');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:9999/generate'); // trailing slash normalised
    expect(JSON.parse(init?.body as string)).toMatchObject({
      prompt: 'a slow walk',
      format: 'bvh',
    });
  });

  it('throws a message naming the contract when the service returns no BVH', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ jobId: 'j1' }), { status: 200 }),
    );
    const cap = new HttpMotionGenerationCapability({
      serverUrl: 'http://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(cap.generate({ prompt: 'p', model: ALLOWED_MODEL })).rejects.toThrow(
      /no BVH text/,
    );
  });

  it('refuses a BLOCKED checkpoint the service says it ran, not just the one we asked for', async () => {
    // Constructed from the failure: the gate guarded `request.model` and then took
    // `payload.model` on trust, so a service that fell back to a blocked checkpoint
    // handed us its clip and we recorded it as the provenance. These terms forbid
    // USE, so the violation completes the moment the result is accepted.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ jobId: 'j1', bvh: 'HIERARCHY', model: BLOCKED_MODEL }), {
          status: 200,
        }),
    );
    const cap = new HttpMotionGenerationCapability({
      serverUrl: 'http://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(cap.generate({ prompt: 'p', model: ALLOWED_MODEL })).rejects.toThrow(
      ModelNotLicensedError,
    );
  });

  it('refuses an ALLOWED substitution too — a cleared checkpoint is not any checkpoint', async () => {
    // 'Kimodo-G1-RP-v1' is a sibling under the same verdict, so this is refused for
    // the substitution itself rather than for its terms. The `model` param is named
    // explicitly precisely so nothing downstream picks a checkpoint silently.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ jobId: 'j1', bvh: 'HIERARCHY', model: 'Kimodo-G1-RP-v1' }), {
          status: 200,
        }),
    );
    const cap = new HttpMotionGenerationCapability({
      serverUrl: 'http://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(cap.generate({ prompt: 'p', model: ALLOWED_MODEL })).rejects.toThrow(
      /was requested and licence-checked/,
    );
  });

  it('reports unavailable rather than throwing when the host is down', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const cap = new HttpMotionGenerationCapability({
      serverUrl: 'http://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(cap.isAvailable()).resolves.toBe(false);
  });
});
