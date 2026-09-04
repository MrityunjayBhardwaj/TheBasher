// #826 — the SHAPE ON THE WIRE, asserted against what the server reads.
//
// This file exists because the defect it pins was invisible to every other test
// in this directory. `constraints` is typed, validated and round-tripped on our
// side, and none of that says anything about what the receiver does with it: we
// sent `constraints: { waypoints: [...] }`, an object, and the server reads
// `constraints` as a LIST and `waypoints` as a SEPARATE TOP-LEVEL key. Both ends
// were internally consistent, and the whole defect lived between them.
//
// So these rows assert the BYTES, not our types. The real end-to-end proof needs
// the live server and cannot run in CI (see tmp-826-live-waypoints); what CAN be
// held here forever is the request shape that proof validated, so a later
// refactor cannot quietly re-nest the key.
//
// Server-side anchors, read from source rather than assumed:
//   serve.py:96   constraints = authoring.validate(body.get("constraints") or [], n)
//   serve.py:99   waypoints    = body.get("waypoints")
//   authoring/constraints.py:82  waypoints: Iterable[Sequence[float]]  -- [x, z] pairs, metres
//   serve.py:202  meta.world_offset_xz -- the offset the caller must add back
//
// REF: issues #826, #894, #775.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpMotionGenerationCapability } from './HttpMotionGenerationCapability';
import { DEFAULT_MOTIONGEN_MODEL } from './index';
import { BVH_UNIT_SCALE_CENTIMETRES } from '../import/bvh';
import { MotionResultInvalidError } from './MotionGenerationCapability';

const somaBvh = () =>
  readFileSync(resolve(process.cwd(), 'public/fixtures/anim/soma-generated.bvh'), 'utf8');

/** Captures the request body so the rows below can assert the actual bytes. */
function capturingFetch(meta?: unknown) {
  const sent: Record<string, unknown>[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response('', { status: 200 });
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        jobId: 'wire-1',
        bvh: somaBvh(),
        model: DEFAULT_MOTIONGEN_MODEL,
        unitScale: BVH_UNIT_SCALE_CENTIMETRES,
        ...(meta === undefined ? {} : { meta }),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { sent, impl };
}

const REQ = {
  prompt: 'a person walks forward',
  model: DEFAULT_MOTIONGEN_MODEL,
  seconds: 2,
} as const;

describe('#826 — what actually goes on the wire', () => {
  it('sends waypoints at the TOP LEVEL, as [x, z] pairs', async () => {
    const { sent, impl } = capturingFetch();
    const cap = new HttpMotionGenerationCapability({ serverUrl: 'http://x', fetchImpl: impl });
    await cap.generate({
      ...REQ,
      constraints: {
        waypoints: [
          { x: 3, z: 1 },
          { x: 5, z: 1 },
        ],
      },
    });
    const body = sent[0];
    // The key the server actually reads, in the shape it actually parses.
    expect(body.waypoints).toEqual([
      [3, 1],
      [5, 1],
    ]);
  });

  it('does NOT send a `constraints` object — the server reads that key as a LIST', async () => {
    const { sent, impl } = capturingFetch();
    const cap = new HttpMotionGenerationCapability({ serverUrl: 'http://x', fetchImpl: impl });
    await cap.generate({ ...REQ, constraints: { waypoints: [{ x: 1, z: 2 }] } });
    // A dict is truthy, so the server's `or []` guard did not skip it: it either
    // raised or iterated the dict's KEYS as constraints. Sending the key at all
    // is the defect, so its ABSENCE is what this row holds.
    expect(body(sent).constraints).toBeUndefined();
  });

  it('omits waypoints entirely when the request carries none', async () => {
    const { sent, impl } = capturingFetch();
    const cap = new HttpMotionGenerationCapability({ serverUrl: 'http://x', fetchImpl: impl });
    await cap.generate(REQ);
    expect('waypoints' in body(sent)).toBe(false);
    expect('constraints' in body(sent)).toBe(false);
  });

  it('omits waypoints when the list is present but EMPTY', async () => {
    // An empty path is not a path. Sending `waypoints: []` would make the server
    // take its no-waypoints branch anyway, but only because `if waypoints:` is
    // falsy for an empty list — behaviour that reads as deliberate here and is
    // actually a coincidence of Python truthiness. Say it on this side.
    const { sent, impl } = capturingFetch();
    const cap = new HttpMotionGenerationCapability({ serverUrl: 'http://x', fetchImpl: impl });
    await cap.generate({ ...REQ, constraints: { waypoints: [] } });
    expect('waypoints' in body(sent)).toBe(false);
  });
});

describe('#826 — the world offset comes back off `meta`', () => {
  it('reads meta.world_offset_xz into the result', async () => {
    const { impl } = capturingFetch({ world_offset_xz: [3, 1] });
    const cap = new HttpMotionGenerationCapability({ serverUrl: 'http://x', fetchImpl: impl });
    const result = await cap.generate({ ...REQ, constraints: { waypoints: [{ x: 3, z: 1 }] } });
    expect(result.worldOffsetXZ).toEqual([3, 1]);
  });

  it('reports null — NOT [0,0] — when the server states no offset', async () => {
    // The distinction is the point: null means nobody asked for a world path,
    // while [0,0] means one was asked for and happened to start at the origin.
    const { impl } = capturingFetch({ world_offset_xz: null });
    const cap = new HttpMotionGenerationCapability({ serverUrl: 'http://x', fetchImpl: impl });
    expect((await cap.generate(REQ)).worldOffsetXZ).toBeNull();
  });

  it('reports null when the service sends no meta block at all', async () => {
    const { impl } = capturingFetch();
    const cap = new HttpMotionGenerationCapability({ serverUrl: 'http://x', fetchImpl: impl });
    expect((await cap.generate(REQ)).worldOffsetXZ).toBeNull();
  });

  it('REFUSES a malformed offset rather than treating it as none', async () => {
    // A service telling us where the motion belongs in a way we cannot read is
    // not the same as a service saying it belongs nowhere. Silently collapsing
    // the two puts the clip at the origin with full confidence.
    for (const bad of [[1], [1, 2, 3], ['a', 'b'], [Number.NaN, 0], 'nope', 42]) {
      const { impl } = capturingFetch({ world_offset_xz: bad });
      const cap = new HttpMotionGenerationCapability({ serverUrl: 'http://x', fetchImpl: impl });
      await expect(cap.generate(REQ), `should have refused ${JSON.stringify(bad)}`).rejects.toThrow(
        MotionResultInvalidError,
      );
    }
  });
});

function body(sent: Record<string, unknown>[]): Record<string, unknown> {
  expect(sent.length).toBe(1);
  return sent[0];
}
