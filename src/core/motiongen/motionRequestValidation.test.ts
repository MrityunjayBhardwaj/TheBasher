// The request contract, enforced. Every arm below was constructed against the
// unvalidated code and produced a SUCCESSFUL result carrying nonsense — which is
// the whole hazard: nothing failed, so nothing surfaced, and NaN keyframes landed
// in the graph with nothing to point at.
//
// REF: ref/architecture/ai-track.md phase A1.

import { describe, expect, it } from 'vitest';
import {
  MAX_MOTION_SECONDS,
  MotionRequestInvalidError,
  assertValidMotionRequest,
} from './MotionGenerationCapability';
import type { MotionGenerationRequest } from './MotionGenerationCapability';
import { StubMotionGenerationCapability, synthesiseBvh } from './StubMotionGenerationCapability';
import { HttpMotionGenerationCapability } from './HttpMotionGenerationCapability';
import { aBlockedRecord } from '../licensing/blockedModelForTests';

// Derived, never spelled — see blockedModelForTests.
const BLOCKED = aBlockedRecord().id;

const ALLOWED = 'Kimodo-SOMA-RP-v1.1';
const ok = { prompt: 'a figure walks forward', model: ALLOWED };

describe('a well-formed request is accepted unchanged (#751)', () => {
  it('accepts the minimal request', () => {
    expect(() => assertValidMotionRequest(ok)).not.toThrow();
  });

  it('accepts every optional field at its boundary value', () => {
    expect(() =>
      assertValidMotionRequest({
        ...ok,
        seconds: MAX_MOTION_SECONDS,
        seed: -1,
        constraints: { waypoints: [{ x: 0, z: 0 }] },
      }),
    ).not.toThrow();
  });
});

describe('the sampling rate cannot be requested at all (#790)', () => {
  // `fps` used to be a field here, and the arms below used to be about its
  // degenerate values: `fps: 0` produced `Frames: 2 | Frame Time: Infinity |
  // 0 1 0 0 NaN 0 0 NaN 0`, well-formed BVH as far as any consumer could tell.
  //
  // It is gone, because the rate is the generator's to decide and two of the
  // three measured backends cannot honour a requested one. What is tested now is
  // one rung further up: not that a bad rate is refused, but that ASKING is.
  it('refuses the field by name rather than silently ignoring it', () => {
    // The whole point of a strict schema. A permissive object would STRIP the
    // unknown key and succeed, so the caller would believe a rate it named had
    // been honoured — which is exactly the quiet failure the removal ends.
    expect(() => assertValidMotionRequest({ ...ok, fps: 30 } as MotionGenerationRequest)).toThrow(
      /fps/,
    );
  });

  it('refuses it whatever its value — the value was never the problem', () => {
    for (const fps of [30, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e6]) {
      expect(() => assertValidMotionRequest({ ...ok, fps } as MotionGenerationRequest)).toThrow(
        MotionRequestInvalidError,
      );
    }
  });
});

describe('degenerate numbers are refused, not clamped (#751)', () => {
  it.each([
    ['seconds: -5 — was silently clamped to two frames', { seconds: -5 }],
    ['seconds: 0', { seconds: 0 }],
    ['seconds: NaN', { seconds: NaN }],
  ])('refuses %s', (_label, patch) => {
    expect(() => assertValidMotionRequest({ ...ok, ...patch })).toThrow(MotionRequestInvalidError);
  });

  it('bounds the clip length, the one number a caller still supplies', () => {
    // The bound used to guard a PAIR — `fps: 1e6, seconds: 60` asked for
    // 60,000,000 motion rows and hung the tab. With the rate no longer the
    // caller's, `seconds` alone decides how much gets synthesised, so the limit
    // moved onto it rather than being kept for a product that can no longer
    // be formed.
    expect(() => assertValidMotionRequest({ ...ok, seconds: MAX_MOTION_SECONDS + 1 })).toThrow(
      MotionRequestInvalidError,
    );
    expect(() => assertValidMotionRequest({ ...ok, seconds: MAX_MOTION_SECONDS })).not.toThrow();
  });

  it('refuses an empty prompt and an empty model', () => {
    expect(() => assertValidMotionRequest({ ...ok, prompt: '' })).toThrow(/prompt/);
    expect(() => assertValidMotionRequest({ ...ok, prompt: '   ' })).toThrow(/prompt/);
    expect(() => assertValidMotionRequest({ ...ok, model: '' })).toThrow(/model/);
  });

  it('refuses a non-integer seed — a determinism handle that is not one', () => {
    expect(() => assertValidMotionRequest({ ...ok, seed: 1.5 })).toThrow(/seed/);
  });

  it('refuses a non-finite waypoint, which would travel to the service as null', () => {
    expect(() =>
      assertValidMotionRequest({ ...ok, constraints: { waypoints: [{ x: NaN, z: 0 }] } }),
    ).toThrow(/waypoints/);
  });
});

describe('the refusal names the offending field, so a caller can learn from it', () => {
  it('reports the field path, not a generic failure', () => {
    try {
      assertValidMotionRequest({ ...ok, seconds: 0 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MotionRequestInvalidError);
      expect((error as MotionRequestInvalidError).issues).toEqual([
        expect.stringContaining('seconds'),
      ]);
    }
  });

  it('reports EVERY offending field, not just the first', () => {
    // A model authoring a request gets one round trip, not one field per round trip.
    try {
      assertValidMotionRequest({ prompt: '', model: ALLOWED, seconds: 0, seed: 1.5 });
      expect.unreachable('should have thrown');
    } catch (error) {
      const { issues } = error as MotionRequestInvalidError;
      expect(issues.join(' ')).toMatch(/prompt/);
      expect(issues.join(' ')).toMatch(/seconds/);
      expect(issues.join(' ')).toMatch(/seed/);
    }
  });
});

describe('both implementations enforce it, and so does the synthesiser', () => {
  it('the stub refuses at generate', async () => {
    const cap = new StubMotionGenerationCapability();
    await expect(cap.generate({ ...ok, seconds: 0 })).rejects.toThrow(MotionRequestInvalidError);
  });

  it('the http impl refuses BEFORE issuing the request', async () => {
    let calls = 0;
    const cap = new HttpMotionGenerationCapability({
      serverUrl: 'http://localhost:9999',
      fetchImpl: (async () => {
        calls += 1;
        throw new Error('the service must not have been reached');
      }) as unknown as typeof fetch,
    });
    await expect(cap.generate({ ...ok, seconds: 0 })).rejects.toThrow(MotionRequestInvalidError);
    expect(calls).toBe(0);
  });

  it('synthesiseBvh refuses directly — it is the function that builds the bytes', () => {
    // Exported from the barrel, so guarding only generate would leave the door
    // that actually produces the rows standing open. `Frame Time: Infinity` is no
    // longer reachable from here — the rate is the stub's own constant — but
    // `seconds` still decides the row count on its own.
    expect(() => synthesiseBvh({ ...ok, seconds: 0 })).toThrow(MotionRequestInvalidError);
  });

  it('the licence verdict is reported BEFORE the shape complaint', async () => {
    // A blocked checkpoint with a malformed field must report the block. Validating
    // first would bury the fact that matters behind whichever field also happened
    // to be wrong.
    const cap = new StubMotionGenerationCapability();
    await expect(cap.generate({ prompt: 'x', model: BLOCKED, seconds: 0 })).rejects.toThrow(
      /BLOCKED/,
    );
  });
});
