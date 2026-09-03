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
import { readBvhProfile } from '../import/bvhProfile';
import {
  StubMotionGenerationCapability,
  synthesiseBvh,
  STUB_MOTION_FPS,
} from './StubMotionGenerationCapability';
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

  it('does NOT vary with constraints, so it cannot fake A2 (#775)', async () => {
    // The one property this stub must NOT have. A2's discriminating observation
    // is "move a waypoint and the generated motion changes", chosen to show the
    // curve is an input to the generator rather than a path the output was
    // fitted to. While `constraints` was part of the digest, the stub satisfied
    // that observation with a hash — so A2 could have been closed green against
    // a generator that cannot walk a path at all.
    //
    // Invariance is the gate: the claim is now unconstructible offline, and only
    // a generator that actually honours the constraint can produce it.
    const cap = new StubMotionGenerationCapability();
    const base = { prompt: 'a figure walks a path', model: ALLOWED_MODEL } as const;
    const a = await cap.generate({ ...base, constraints: { waypoints: [{ x: 0, z: 0 }] } });
    const b = await cap.generate({ ...base, constraints: { waypoints: [{ x: 9, z: -4 }] } });
    expect(a.bvh).toBe(b.bvh);
    // The control: the digest is still live, so this is invariance under ONE
    // field rather than a stub that stopped responding to anything.
    const c = await cap.generate({ ...base, prompt: 'a figure sprints a path' });
    expect(c.bvh).not.toBe(a.bvh);
  });

  it('emits BVH the real parser accepts, not a placeholder token', async () => {
    // A stub returning a sentinel would let every test below pass while proving
    // nothing about whether generated motion can travel the import road.
    const cap = new StubMotionGenerationCapability();
    const { bvh } = await cap.generate({
      prompt: 'wave',
      model: ALLOWED_MODEL,
      seconds: 1,
    });
    const parsed = parseBvh(bvh, 'generated');
    expect(parsed.skeletonParams.bones.length).toBeGreaterThan(1);
    expect(parsed.clipParams.keyframes.length).toBeGreaterThan(0);
  });

  it('samples at ITS OWN rate, and the clip states it (#790)', async () => {
    // The rate is the stub's constant, not a request field, so the frame count
    // follows from the requested LENGTH and the implementation's own sampling.
    // Read back off the clip rather than compared to what was asked for: the
    // header is where a consumer will find it.
    const bvh = synthesiseBvh({ prompt: 'x', model: ALLOWED_MODEL, seconds: 2 });
    expect(bvh).toContain(`Frames: ${STUB_MOTION_FPS * 2}`);
    expect(readBvhProfile(bvh).fps).toBeCloseTo(STUB_MOTION_FPS, 5);
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
        new Response(
          JSON.stringify({
            jobId: 'j1',
            bvh: synthesiseBvh({ prompt: 'x', model: ALLOWED_MODEL, seconds: 1 }),
            model: ALLOWED_MODEL,
            unitScale: 1,
          }),
          { status: 200 },
        ),
    );
    const cap = new HttpMotionGenerationCapability({
      serverUrl: 'http://localhost:9999/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await cap.generate({ prompt: 'a slow walk', model: ALLOWED_MODEL });
    expect(result.bvh).toContain('HIERARCHY');
    expect(result.unitScale).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0];
    // Trailing slash normalised, AND the JSON envelope is ASKED for rather than
    // assumed (#775): a real generator may default to returning the clip as a raw
    // body — the local Kimodo server does — and the failure when it does is
    // `response.json()` throwing, which reads as a transport fault rather than as
    // a protocol mismatch.
    expect(url).toBe('http://localhost:9999/generate?format=json');
    // The two `format`s answer different questions and must not be conflated: the
    // query one names the HTTP ENVELOPE, the body one names the CLIP payload.
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

// #826/#730 — a world offset a CALLER cannot place is a REFUSAL, not a default.
//
// When a world path is requested, the generator canonicalises frame 0 to the
// origin and returns the offset needed to put the motion back where it was
// asked for. The clip looks entirely correct at the origin, so dropping the
// offset would put the character in the wrong place with nothing to notice.
//
// #730 took the placement decision — the offset goes to the bound character's
// root group — so the refusal NARROWED rather than disappeared. It now fires for
// a caller that cannot place, and the agent tool is exactly such a caller: it
// runs on a forked state and returns ops for the Diff without ever binding, so
// there is no character in its world to move. These rows hold that line: the
// gate has to keep refusing by DEFAULT, or the road that cannot place silently
// starts placing at the origin.
describe('#826 — an unplaceable world offset stops the import', () => {
  /** A capability that reports a world path was rebased away, as the server does. */
  function offsetCapability(worldOffsetXZ: readonly [number, number] | null) {
    const stub = new StubMotionGenerationCapability();
    return {
      id: 'offset-probe',
      kind: 'stub' as const,
      isAvailable: async () => true,
      cancel: async () => {},
      generate: async (request: Parameters<typeof stub.generate>[0]) => ({
        ...(await stub.generate(request)),
        worldOffsetXZ,
      }),
    };
  }

  const REQUEST = { prompt: 'a person walks', model: ALLOWED_MODEL, seconds: 2 };

  it('refuses, naming the offset it cannot apply', async () => {
    await expect(
      buildGeneratedMotionOps(
        offsetCapability([3, 1]),
        { request: REQUEST, ids: IDS },
        stateWithTime(),
      ),
    ).rejects.toThrow(/\[3, 1\]/);
  });

  it('refuses an offset AT the origin too — [0,0] is a placement, not an absence', async () => {
    // The trap this row guards: a truthiness check would let [0,0] through, and
    // it means "a world path was asked for and starts here", which is a claim,
    // not silence. Only `null` says nobody asked.
    await expect(
      buildGeneratedMotionOps(
        offsetCapability([0, 0]),
        { request: REQUEST, ids: IDS },
        stateWithTime(),
      ),
    ).rejects.toThrow(/cannot place it/);
  });

  // The narrowing, in both directions. A gate that only ever refuses is not a
  // gate that lets the right caller through, and one that only ever passes is not
  // a gate at all — so the SAME offset is run past it twice, differing in nothing
  // but the caller's declaration.
  it('lets a caller that can place through, and hands it the offset to apply', async () => {
    const { worldOffsetXZ, ops } = await buildGeneratedMotionOps(
      offsetCapability([3, 1]),
      { request: REQUEST, ids: IDS, appliesWorldOffset: true },
      stateWithTime(),
    );
    expect(worldOffsetXZ).toEqual([3, 1]);
    // The ops are the ordinary import ops and nothing more: the placement is the
    // CALLER's to dispatch, so nothing here may quietly encode a position.
    expect(ops.some((o) => o.type === 'setParam')).toBe(false);
  });

  it('keeps null distinct from [0,0] on the way out, not just on the way in', async () => {
    const { worldOffsetXZ } = await buildGeneratedMotionOps(
      offsetCapability(null),
      { request: REQUEST, ids: IDS, appliesWorldOffset: true },
      stateWithTime(),
    );
    // `[0,0]` would mean "a path was asked for and it starts at the origin".
    // Collapsing the two is what makes a character that was never given a path
    // indistinguishable from one that was.
    expect(worldOffsetXZ).toBeNull();
  });

  it('proceeds normally when no world path was requested', async () => {
    const { ops } = await buildGeneratedMotionOps(
      offsetCapability(null),
      { request: REQUEST, ids: IDS },
      stateWithTime(),
    );
    expect(ops.length).toBeGreaterThan(0);
  });
});
