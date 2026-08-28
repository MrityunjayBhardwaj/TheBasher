// The conformance suite's arms — one per implementation, plus the properties that
// belong to a single implementation and therefore cannot live in the shared block.
//
// The HTTP arm replays a REAL backend's artefact shape rather than the stub's: a
// SOMA skeleton in centimetres with the world translation on `Hips`. That is the
// point of having two arms at all. A suite run only against the stub would state
// the properties correctly and still never see a clip shaped like the one a real
// generator returns.
//
// REF: src/core/motiongen/capabilityConformance.ts; issues #790, #792.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BVH_UNIT_SCALE_CENTIMETRES, parseBvh } from '../import/bvh';
import { readBvhProfile } from '../import/bvhProfile';
import { aBlockedRecord } from '../licensing/blockedModelForTests';
import { DEFAULT_MOTIONGEN_MODEL } from './index';
import { HttpMotionGenerationCapability } from './HttpMotionGenerationCapability';
import { StubMotionGenerationCapability } from './StubMotionGenerationCapability';
import { describeMotionCapabilityConformance, bindExtentMetres } from './capabilityConformance';
import type { MotionGenerationRequest } from './MotionGenerationCapability';

const BLOCKED_MODEL = aBlockedRecord().id;
const REQUEST: MotionGenerationRequest = {
  prompt: 'a person walks forward and turns left',
  model: DEFAULT_MOTIONGEN_MODEL,
  seconds: 2,
};

/** The generated-motion fixture: SOMA's 78 joints, centimetres, Hips-carried translation. */
const somaBvh = () =>
  readFileSync(resolve(process.cwd(), 'public/fixtures/anim/soma-generated.bvh'), 'utf8');

/**
 * A fetch that answers like a service returning a real backend's clip. Not a
 * hand-written payload: the BVH is the fixture generated from the exporter's own
 * skeleton, so the HTTP arm exercises the shape the transport will actually meet.
 */
function replayFetch(
  overrides: Record<string, unknown> = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response('', { status: 200 });
    return new Response(
      JSON.stringify({
        jobId: 'replay-1',
        bvh: somaBvh(),
        model: DEFAULT_MOTIONGEN_MODEL,
        unitScale: BVH_UNIT_SCALE_CENTIMETRES,
        ...overrides,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
}

describeMotionCapabilityConformance('stub', () => new StubMotionGenerationCapability(), {
  request: REQUEST,
  blockedModel: BLOCKED_MODEL,
  deterministic: true,
});

describeMotionCapabilityConformance(
  'http, replaying a real generator’s clip',
  () =>
    new HttpMotionGenerationCapability({
      serverUrl: 'http://127.0.0.1:8600',
      fetchImpl: replayFetch() as typeof fetch,
    }),
  {
    request: REQUEST,
    blockedModel: BLOCKED_MODEL,
    // A sampler is not required to be reproducible; the replay happens to be, and
    // asserting it would test the test double rather than the contract.
    deterministic: false,
  },
);

describe('what the two arms disagree about — and why that is allowed', () => {
  it('the stub emits metres and the real shape emits centimetres, and each says so', async () => {
    const stub = await new StubMotionGenerationCapability().generate(REQUEST);
    expect(stub.unitScale).toBe(1);

    const http = await new HttpMotionGenerationCapability({
      serverUrl: 'http://127.0.0.1:8600',
      fetchImpl: replayFetch() as typeof fetch,
    }).generate(REQUEST);
    expect(http.unitScale).toBe(0.01);

    // 100x apart in the payload, the same size once each declaration is applied.
    // That is the whole contract: implementations may differ on the unit, they
    // may not differ on whether they state it.
    const stubExtent = bindExtentMetres(
      parseBvh(stub.bvh, 's', stub.unitScale).skeletonParams.bones,
    );
    const httpExtent = bindExtentMetres(
      parseBvh(http.bvh, 'h', http.unitScale).skeletonParams.bones,
    );
    expect(stubExtent).toBeGreaterThan(0.5);
    expect(httpExtent).toBeGreaterThan(0.5);
    expect(stubExtent).toBeLessThan(3);
    expect(httpExtent).toBeLessThan(3);
  });

  it('they put the world translation on different joints, and both are named', async () => {
    const stub = await new StubMotionGenerationCapability().generate(REQUEST);
    const http = await new HttpMotionGenerationCapability({
      serverUrl: 'http://127.0.0.1:8600',
      fetchImpl: replayFetch() as typeof fetch,
    }).generate(REQUEST);

    // The stub's rig is two joints and its ROOT translates. A real SOMA clip
    // wraps the skeleton in a `Root` that is identically zero and puts every unit
    // of translation on `Hips`. A consumer reading the world path off "the root"
    // is correct for one and sees a character walking in place for the other.
    expect(readBvhProfile(stub.bvh).rootMotionJoint).toBe('Hips');
    expect(readBvhProfile(http.bvh).joints[0]).toBe('Root');
    expect(readBvhProfile(http.bvh).rootMotionJoint).toBe('Hips');
  });
});

describe('HTTP: the unit scale is required, never defaulted', () => {
  it('refuses a service that returns a clip without saying what unit it is in', async () => {
    const cap = new HttpMotionGenerationCapability({
      serverUrl: 'http://127.0.0.1:8600',
      fetchImpl: replayFetch({ unitScale: undefined }) as typeof fetch,
    });
    await expect(cap.generate(REQUEST)).rejects.toThrow(/unitScale/);
  });

  it('refuses a scale that is not a positive, finite number of metres per unit', async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cap = new HttpMotionGenerationCapability({
        serverUrl: 'http://127.0.0.1:8600',
        fetchImpl: replayFetch({ unitScale: bad }) as typeof fetch,
      });
      await expect(cap.generate(REQUEST)).rejects.toThrow(/unitScale/);
    }
  });

  it('refuses a clip whose own Frame Time is degenerate', async () => {
    const broken = somaBvh().replace(/Frame Time: .*/, 'Frame Time: 0');
    const cap = new HttpMotionGenerationCapability({
      serverUrl: 'http://127.0.0.1:8600',
      fetchImpl: replayFetch({ bvh: broken }) as typeof fetch,
    });
    await expect(cap.generate(REQUEST)).rejects.toThrow(/Frame Time/);
  });
});

describe('#792 — a posed joint’s rest offset is REPLACED, not added', () => {
  it('a Hips-posed clip lands at its animated pelvis height, not twice it', () => {
    const parsed = parseBvh(somaBvh(), 'soma', BVH_UNIT_SCALE_CENTIMETRES);
    const bones = parsed.skeletonParams.bones;
    const hips = bones.findIndex((b) => b.name === 'Hips');

    // The fixture's Hips carries the same quantity twice, exactly as the real
    // exporter writes it: OFFSET 100cm is the REST pelvis, and a 96cm position
    // channel is the ANIMATED pelvis.
    expect(bones[hips].position[1]).toBeCloseTo(1, 6);

    const keyed = parsed.clipParams.keyframes.filter((k) => k.bone === hips);
    expect(keyed.length).toBeGreaterThan(0);
    // 0.96 is the pelvis. 1.96 was the pelvis plus its own rest height — a
    // character floating exactly one rest offset off the floor for the whole clip.
    expect(keyed[0].position[1]).toBeCloseTo(0.96, 6);
  });

  it('a rotation-only joint keeps its OFFSET as its translation', () => {
    // The other half of the rule, and the one that would collapse the skeleton if
    // the correction were applied everywhere: a joint with no position channel has
    // no animated translation, so its OFFSET IS its local translation and must
    // survive untouched.
    const parsed = parseBvh(somaBvh(), 'soma', BVH_UNIT_SCALE_CENTIMETRES);
    const bones = parsed.skeletonParams.bones;
    const spine = bones.findIndex((b) => b.name === 'Spine1');
    expect(bones[spine].position[1]).toBeCloseTo(0.1, 6);

    const keyed = parsed.clipParams.keyframes.filter((k) => k.bone === spine);
    expect(keyed[0].position[1]).toBeCloseTo(0.1, 6);
  });
});
