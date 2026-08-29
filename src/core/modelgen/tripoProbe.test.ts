// The probe keeps its reason, and the fall-through to the stub says so.
//
// The defect these pin: `isAvailable()` answered false for four unrelated
// situations, `pickModelGeneration` then returned a stub whose own
// `isAvailable()` is unconditionally true, and the stub emits a real GLB that
// imports and renders. A configured key and a synthesised mesh were
// indistinguishable from a successful generation.

import { describe, it, expect, vi } from 'vitest';
import {
  TripoModelGenerationCapability,
  describeTripoUnavailable,
  pickModelGeneration,
  StubModelGenerationCapability,
  type ModelGenerationFallback,
  type TripoFallback,
  type TripoUnavailable,
} from './index';
import { pickRigging, StubRiggingCapability } from '../rigging';

const KEY = 'tsk_test_key_that_is_long_enough_to_pass';

/** A fetch that answers with one status and body. */
function respondWith(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

/** A fetch that never completes — what a blocked preflight looks like to JS. */
function failToFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch): TripoModelGenerationCapability {
  return new TripoModelGenerationCapability({ apiKey: KEY, fetchImpl });
}

describe('probe names WHY, where isAvailable only said no', () => {
  it('ok, with the balance, when the service answers', async () => {
    const probe = await client(
      respondWith(200, { code: 0, data: { balance: 2430, frozen: 0 } }),
    ).probe();
    expect(probe).toEqual({ ok: true, balance: 2430, frozen: 0 });
  });

  it('key-rejected on 401 — the reader can fix this one', async () => {
    const probe = await client(
      respondWith(401, { code: 1002, message: 'Authentication failed' }),
    ).probe();
    expect(probe.ok).toBe(false);
    expect(probe.ok === false && probe.cause).toBe('key-rejected');
  });

  it('key-rejected on 403 too', async () => {
    const probe = await client(respondWith(403, { code: 1002, message: 'Forbidden' })).probe();
    expect(probe.ok === false && probe.cause).toBe('key-rejected');
  });

  it('unreachable when the request never completes — the CORS case', async () => {
    const probe = await client(failToFetch()).probe();
    expect(probe.ok).toBe(false);
    expect(probe.ok === false && probe.cause).toBe('unreachable');
    // The underlying text is kept, so a report can quote what actually happened.
    expect(probe.ok === false && probe.detail).toContain('Failed to fetch');
  });

  it('service-error when the host answers with something else', async () => {
    const probe = await client(respondWith(500, { code: 9, message: 'boom' })).probe();
    expect(probe.ok === false && probe.cause).toBe('service-error');
  });

  it('key-shape before anything leaves the process', async () => {
    const fetchImpl = failToFetch();
    const empty = new TripoModelGenerationCapability({ apiKey: '   ', fetchImpl });
    const probe = await empty.probe();
    expect(probe.ok === false && probe.cause).toBe('key-shape');
    // Load-bearing: a shape failure must not cost a round trip.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('isAvailable stays the same question, answered by the probe', async () => {
    expect(await client(respondWith(200, { code: 0, data: { balance: 1 } })).isAvailable()).toBe(
      true,
    );
    expect(await client(failToFetch()).isAvailable()).toBe(false);
  });
});

describe('every cause gets a sentence a person can act on', () => {
  const causes = ['key-shape', 'key-rejected', 'unreachable', 'service-error'] as const;

  it.each(causes)('%s reads as something other than a bare code', (cause) => {
    const result: TripoUnavailable = { ok: false, cause, detail: 'the underlying text' };
    const sentence = describeTripoUnavailable(result);
    expect(sentence.length).toBeGreaterThan(20);
    // Never leaks the enum member to a reader.
    expect(sentence).not.toContain(cause);
  });

  it('the sentences are distinct — otherwise classifying bought nothing', () => {
    const said = causes.map((cause) => describeTripoUnavailable({ ok: false, cause, detail: 'd' }));
    expect(new Set(said).size).toBe(causes.length);
  });

  it('the unreachable sentence names the proxy, which is the actual fix', () => {
    const sentence = describeTripoUnavailable({
      ok: false,
      cause: 'unreachable',
      detail: 'Failed to fetch',
    });
    expect(sentence).toMatch(/proxy/i);
    expect(sentence).toMatch(/CORS/i);
  });
});

describe('the fall-through to the stub is announced', () => {
  it('reports when a key WAS configured and could not be used', async () => {
    const seen: ModelGenerationFallback[] = [];
    const cap = await pickModelGeneration(KEY, { fetchImpl: failToFetch() }, (f) => seen.push(f));

    expect(cap).toBeInstanceOf(StubModelGenerationCapability);
    expect(seen).toHaveLength(1);
    expect(seen[0].cause).toBe('unreachable');
    expect(seen[0].detail).toContain('Failed to fetch');
    expect(seen[0].message).toMatch(/proxy/i);
  });

  it('says NOTHING when no key is configured — that is the documented default', async () => {
    const seen: ModelGenerationFallback[] = [];
    for (const key of [undefined, '', '   ']) {
      const cap = await pickModelGeneration(key, {}, (f) => seen.push(f));
      expect(cap).toBeInstanceOf(StubModelGenerationCapability);
    }
    expect(seen).toEqual([]);
  });

  it('says nothing when the service IS reachable', async () => {
    const seen: ModelGenerationFallback[] = [];
    const cap = await pickModelGeneration(
      KEY,
      { fetchImpl: respondWith(200, { code: 0, data: { balance: 10, frozen: 0 } }) },
      (f) => seen.push(f),
    );
    expect(cap).toBeInstanceOf(TripoModelGenerationCapability);
    expect(seen).toEqual([]);
  });

  it('a rejected key reports its own cause, not the transport one', async () => {
    const seen: ModelGenerationFallback[] = [];
    await pickModelGeneration(
      KEY,
      { fetchImpl: respondWith(401, { code: 1002, message: 'Authentication failed' }) },
      (f) => seen.push(f),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].cause).toBe('key-rejected');
    expect(seen[0].message).toMatch(/api-keys/);
  });

  it('the callback is optional — a caller that does not pass one still gets a stub', async () => {
    const cap = await pickModelGeneration(KEY, { fetchImpl: failToFetch() });
    expect(cap).toBeInstanceOf(StubModelGenerationCapability);
  });
});

describe('pickRigging announces the same way — the sharper case', () => {
  // `StubRiggingCapability` returns a real skinned GLB with real bone names, so
  // a stub rig imports, binds, and a retarget onto it succeeds. Silence here
  // does not produce a visibly wrong result; it produces a plausible one.

  it('reports when a configured key could not be used', async () => {
    const seen: TripoFallback[] = [];
    const cap = await pickRigging(KEY, { fetchImpl: failToFetch() }, (f) => seen.push(f));
    expect(cap).toBeInstanceOf(StubRiggingCapability);
    expect(seen).toHaveLength(1);
    expect(seen[0].cause).toBe('unreachable');
  });

  it('says nothing with no key — same documented default', async () => {
    const seen: TripoFallback[] = [];
    const cap = await pickRigging('', {}, (f) => seen.push(f));
    expect(cap).toBeInstanceOf(StubRiggingCapability);
    expect(seen).toEqual([]);
  });

  it('returns the real capability when the service answers', async () => {
    const seen: TripoFallback[] = [];
    const cap = await pickRigging(
      KEY,
      { fetchImpl: respondWith(200, { code: 0, data: { balance: 5, frozen: 0 } }) },
      (f) => seen.push(f),
    );
    expect(cap).toBeInstanceOf(TripoModelGenerationCapability);
    expect(seen).toEqual([]);
  });

  it('both pickers report the SAME shape for the same failure', async () => {
    const opts = { fetchImpl: respondWith(401, { code: 1002, message: 'Authentication failed' }) };
    const fromModel: TripoFallback[] = [];
    const fromRig: TripoFallback[] = [];
    await pickModelGeneration(KEY, opts, (f) => fromModel.push(f));
    await pickRigging(KEY, opts, (f) => fromRig.push(f));
    // What a person reads must not depend on which entry point happened to probe.
    expect(fromRig).toEqual(fromModel);
  });
});
