// The Tripo transport, exercised as if the service verdict were recorded.
//
// This file MOCKS the licence gate, deliberately and in one place, and that is
// why it is a separate file from `modelgen.test.ts`. The two ask different
// questions and must not be able to answer each other's:
//
//   - modelgen.test.ts  — "does the gate refuse, and is NO request issued?"
//                         Runs against the real gate. If it were mocked there,
//                         the refusal test would pass for the wrong reason.
//   - this file         — "given permission, does the client speak the API the
//                         official SDK documents?"
//
// The alternative — reaching into `MODEL_RECORDS` and pushing a row — was tried
// and rejected: it mutates production state from a test, it broke on a field the
// record derivation needs, and it is precisely the test-only backdoor this repo
// refuses. A file-scoped mock states the assumption in the open.
//
// Every field name, endpoint and status string asserted here is read from
// Tripo's official MIT SDK, mirrored at `ref/sources/tripo-python-sdk/`.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../licensing/allowedModels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../licensing/allowedModels')>();
  return {
    ...actual,
    // Permission granted, for this file only. The refusal itself is tested for
    // real in modelgen.test.ts.
    assertModelAllowed: () => ({ id: 'tripo-api', verdict: 'ALLOWED' }),
  };
});

const { TripoModelGenerationCapability, TripoTaskFailedError, TripoApiError, assertTripoKeyShape } =
  await import('./TripoModelGenerationCapability');
const { synthesiseGlb } = await import('./StubModelGenerationCapability');

const KEY = 'tsk_test_key';
const TEXT = { source: 'text', prompt: 'a red chair' } as const;

/** Every assertion in this file is about the v2 wire, so the version is STATED.
 *  It used to be the client's default; it is not any more, and a suite that
 *  silently followed the default would quietly stop testing what it names. */
function client(fetchImpl: unknown, over: Record<string, unknown> = {}) {
  return new TripoModelGenerationCapability({
    apiKey: KEY,
    apiVersion: 'v2',
    fetchImpl: fetchImpl as typeof fetch,
    sleepImpl: async () => {},
    ...over,
  });
}

describe('the key is checked for shape before anything else', () => {
  it('rejects a key that is not tsk_-prefixed UNDER v2, where the prefix is documented', () => {
    // A key pasted from the wrong field otherwise fails as an opaque 401 several
    // seconds later, which sends the reader to the wrong problem.
    expect(() => assertTripoKeyShape('sk-wrong-field', 'v2')).toThrow(/tsk_/);
    expect(() => assertTripoKeyShape(KEY, 'v2')).not.toThrow();
  });

  it('does NOT invent a prefix rule for v3, where the vendor documents none', () => {
    // The failing arm of the version scoping, constructed. v3's documentation
    // states no key format; a rule guessed from one observed key would refuse
    // valid keys of a form nobody here has seen, and say why with confidence.
    // The service's own 401 is the authority instead.
    expect(() => assertTripoKeyShape('tcli_whatever_the_console_issues', 'v3')).not.toThrow();
    expect(() => assertTripoKeyShape('sk-wrong-field', 'v3')).not.toThrow();
  });

  it('refuses an EMPTY key under both, because that one is not a guess', () => {
    // Emptiness means nothing was configured. That is knowable without any
    // vendor documentation, so it is the one shape rule both versions share.
    for (const version of ['v2', 'v3'] as const) {
      expect(() => assertTripoKeyShape('', version)).toThrow(/No Tripo API key/);
      expect(() => assertTripoKeyShape('   ', version)).toThrow(/No Tripo API key/);
    }
  });

  it('a malformed key issues no request', async () => {
    const fetchImpl = vi.fn();
    await expect(client(fetchImpl, { apiKey: 'nope' }).generate(TEXT)).rejects.toThrow(/tsk_/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('create → poll → download', () => {
  it('walks the three endpoints the SDK documents, in order', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/task') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 't1' } }), { status: 200 });
      }
      if (u.includes('/task/t1')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { status: 'success', progress: 100, output: { pbr_model: 'https://cdn/x.glb' } },
          }),
          { status: 200 },
        );
      }
      return new Response(synthesiseGlb(TEXT), { status: 200 });
    });

    const result = await client(fetchImpl).generate(TEXT);

    expect(result.taskId).toBe('t1');
    expect(result.glb.byteLength).toBeGreaterThan(0);
    expect(calls).toEqual([
      'POST https://api.tripo3d.ai/v2/openapi/task',
      'GET https://api.tripo3d.ai/v2/openapi/task/t1',
      'GET https://cdn/x.glb',
    ]);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ type: 'text_to_model', prompt: 'a red chair' });
  });

  it('keeps polling while the task is queued or running, then succeeds', async () => {
    const statuses = ['queued', 'running', 'running', 'success'];
    let i = 0;
    const seen: number[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/task') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 't1' } }), { status: 200 });
      }
      if (u.includes('/task/t1')) {
        const status = statuses[i++];
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              status,
              progress: i * 25,
              output: status === 'success' ? { model: 'https://cdn/x.glb' } : {},
            },
          }),
          { status: 200 },
        );
      }
      return new Response(synthesiseGlb(TEXT), { status: 200 });
    });

    await client(fetchImpl).generate(TEXT, (p) => seen.push(p.progress));
    expect(i).toBe(statuses.length);
    expect(seen).toEqual([25, 50, 75, 100]);
  });

  it('prefers pbr_model, then model, then base_model', async () => {
    const downloaded: string[] = [];
    const make = (output: Record<string, string>) =>
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/task') && init?.method === 'POST') {
          return new Response(JSON.stringify({ code: 0, data: { task_id: 't' } }), { status: 200 });
        }
        if (u.includes('/task/t')) {
          return new Response(
            JSON.stringify({ code: 0, data: { status: 'success', progress: 100, output } }),
            { status: 200 },
          );
        }
        downloaded.push(u);
        return new Response(synthesiseGlb(TEXT), { status: 200 });
      });

    await client(make({ pbr_model: 'P', model: 'M', base_model: 'B' })).generate(TEXT);
    await client(make({ model: 'M', base_model: 'B' })).generate(TEXT);
    await client(make({ base_model: 'B' })).generate(TEXT);
    expect(downloaded).toEqual(['P', 'M', 'B']);
  });

  it('fails legibly when a successful task carries no model URL', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) =>
      String(url).endsWith('/task') && init?.method === 'POST'
        ? new Response(JSON.stringify({ code: 0, data: { task_id: 't' } }), { status: 200 })
        : new Response(
            JSON.stringify({ code: 0, data: { status: 'success', progress: 100, output: {} } }),
            { status: 200 },
          ),
    );
    await expect(client(fetchImpl).generate(TEXT)).rejects.toThrow(/no model URL/);
  });
});

describe('option names are mapped at this seam and nowhere else', () => {
  it('sends snake_case on the wire and never Basher camelCase', async () => {
    // Params declared so `mock.calls[0]` is a typed tuple. Without them the
    // inferred call signature takes zero arguments and every read of the recorded
    // call is an error the project typecheck cannot see — it excludes test files.
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: 0, data: { task_id: 't' } }), { status: 200 }),
    );
    await client(fetchImpl, { timeoutMs: 0 })
      .generate({ ...TEXT, quad: true, faceLimit: 5000, textureQuality: 'detailed' })
      .catch(() => undefined);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ quad: true, face_limit: 5000, texture_quality: 'detailed' });
    for (const leaked of ['faceLimit', 'textureQuality', 'modelVersion']) {
      expect(Object.keys(body)).not.toContain(leaked);
    }
  });

  it('omits an option the caller did not set, rather than sending undefined', async () => {
    // Params declared so `mock.calls[0]` is a typed tuple. Without them the
    // inferred call signature takes zero arguments and every read of the recorded
    // call is an error the project typecheck cannot see — it excludes test files.
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: 0, data: { task_id: 't' } }), { status: 200 }),
    );
    await client(fetchImpl, { timeoutMs: 0 })
      .generate(TEXT)
      .catch(() => undefined);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(Object.keys(body).sort()).toEqual(['prompt', 'type']);
  });
});

describe('terminal statuses and transport failures are distinguished', () => {
  const terminal = ['failed', 'cancelled', 'banned', 'expired', 'unknown'];
  for (const status of terminal) {
    it(`treats "${status}" as a task failure, not a transport error`, async () => {
      const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) =>
        String(url).endsWith('/task') && init?.method === 'POST'
          ? new Response(JSON.stringify({ code: 0, data: { task_id: 't1' } }), { status: 200 })
          : new Response(JSON.stringify({ code: 0, data: { status, progress: 0 } }), {
              status: 200,
            }),
      );
      await expect(client(fetchImpl).generate(TEXT)).rejects.toThrow(TripoTaskFailedError);
    });
  }

  it('surfaces the API message and suggestion on an error response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 2002, message: 'insufficient credits' }), {
          status: 402,
        }),
    );
    await expect(client(fetchImpl).generate(TEXT)).rejects.toThrow(/insufficient credits/);
  });

  it('reports unavailable rather than throwing when the host is down', async () => {
    const cap = client(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(cap.isAvailable()).resolves.toBe(false);
  });

  it('sends the Bearer key, and reads the balance the plugin shows', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: 0, data: { balance: 42, frozen: 3 } }), {
          status: 200,
        }),
    );
    await expect(client(fetchImpl).getBalance()).resolves.toEqual({ balance: 42, frozen: 3 });
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});

describe('cancel is honest about what it can and cannot do', () => {
  it('stops our polling, and the generation rejects as cancelled', async () => {
    // The SDK exposes NO cancel endpoint — `cancelled` is only a status the
    // service may report — so this asserts the local behaviour actually
    // implemented, not an invented contract.
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) =>
      String(url).endsWith('/task') && init?.method === 'POST'
        ? new Response(JSON.stringify({ code: 0, data: { task_id: 't1' } }), { status: 200 })
        : new Response(JSON.stringify({ code: 0, data: { status: 'running', progress: 10 } }), {
            status: 200,
          }),
    );
    const cap = client(fetchImpl);
    const run = cap.generate(TEXT, () => {
      void cap.cancel('t1');
    });
    await expect(run).rejects.toThrow(TripoTaskFailedError);
  });

  it('issues no cancel request, because no such endpoint exists', async () => {
    const fetchImpl = vi.fn();
    await client(fetchImpl).cancel('t1');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the whole generation is bounded', () => {
  it('gives up rather than polling for ever', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) =>
      String(url).endsWith('/task') && init?.method === 'POST'
        ? new Response(JSON.stringify({ code: 0, data: { task_id: 't1' } }), { status: 200 })
        : new Response(JSON.stringify({ code: 0, data: { status: 'running', progress: 1 } }), {
            status: 200,
          }),
    );
    await expect(client(fetchImpl, { timeoutMs: -1 }).generate(TEXT)).rejects.toThrow(
      TripoApiError,
    );
  });
});
