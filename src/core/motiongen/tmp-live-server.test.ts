// THROWAWAY. Never staged. Boundary-pair observation for #775.
//
// Drives the REAL HttpMotionGenerationCapability against the REAL local Kimodo
// server. Every prior test in this area used a stub or an injected fetch, which
// can only prove this side of the boundary; the failures that cost time here are
// on the other side (a key the server ignores, an envelope it does not send).
//
// Requires the server. It FAILS LOUDLY when the server is absent rather than
// skipping: the first version of this file skipped, and reported three green
// tests in 22ms having contacted nothing — a non-run that was indistinguishable
// from a pass. Run with `--environment node`; jsdom enforces CORS and turns the
// health probe into a false negative.

import { describe, it, expect, beforeAll } from 'vitest';
import { HttpMotionGenerationCapability } from './HttpMotionGenerationCapability';
import { DEFAULT_MOTIONGEN_MODEL, pickMotionGeneration } from './index';

const URL = 'http://127.0.0.1:8600';
let live = false;

beforeAll(async () => {
  try {
    const r = await fetch(`${URL}/health`, { signal: AbortSignal.timeout(3000) });
    live = r.ok;
  } catch {
    live = false;
  }
});

describe('HttpMotionGenerationCapability against the live Kimodo server', () => {
  it('reports the server as available', async () => {
    expect(live, 'server not reachable at ' + URL).toBe(true);
    const cap = new HttpMotionGenerationCapability({ serverUrl: URL });
    expect(await cap.isAvailable()).toBe(true);
  });

  it('generates a real clip that satisfies the capability contract', async () => {
    expect(live, 'server not reachable').toBe(true);
    const cap = new HttpMotionGenerationCapability({ serverUrl: URL });
    const result = await cap.generate({
      prompt: 'a person walks forward',
      model: DEFAULT_MOTIONGEN_MODEL,
      seconds: 2,
      seed: 5,
    });
    // The contract the client refuses without.
    expect(typeof result.bvh).toBe('string');
    expect(result.bvh.startsWith('HIERARCHY')).toBe(true);
    expect(result.model).toBe(DEFAULT_MOTIONGEN_MODEL);
    // Centimetres — stated by the server, never defaulted here (#791).
    expect(result.unitScale).toBe(0.01);
    expect(result.jobId).not.toBe('unknown');

    // THE thing that makes this a generator and not a fixture: the requested
    // length reaches it. Before the server accepted `seconds`, every clip came
    // back 4s and nothing said so.
    const frames = (result.bvh.match(/Frames:\s*(\d+)/) ?? [])[1];
    expect(Number(frames)).toBe(60); // 2s @ 30fps
  }, 300_000);

  it('a different prompt produces different motion — not a digest of the request', async () => {
    expect(live, 'server not reachable').toBe(true);
    const cap = new HttpMotionGenerationCapability({ serverUrl: URL });
    const a = await cap.generate({ prompt: 'a person waves', model: DEFAULT_MOTIONGEN_MODEL, seconds: 2, seed: 5 });
    const b = await cap.generate({ prompt: 'a person kicks', model: DEFAULT_MOTIONGEN_MODEL, seconds: 2, seed: 5 });
    expect(a.bvh).not.toBe(b.bvh);
    // Same skeleton, different motion — the header block is identical, the
    // channel data is not. A hash-driven stub would differ in both.
    const head = (s: string) => s.slice(0, s.indexOf('MOTION'));
    expect(head(a.bvh)).toBe(head(b.bvh));
  }, 300_000);

  it('pickMotionGeneration selects the HTTP capability, not the stub', async () => {
    expect(live, 'server not reachable').toBe(true);
    // The app-level question. Everything above proves the client works when it is
    // used; this proves the app would actually reach for it.
    const cap = await pickMotionGeneration();
    expect(cap.kind).toBe('http');
    expect(cap.id).toBe('http-motion-generation');
  }, 60_000);
});
