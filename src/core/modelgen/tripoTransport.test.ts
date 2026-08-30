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

describe('a network failure names its stage and says whether the URL was proxied (#829)', () => {
  // Observed live as `asset failed: image-to-3D — rigged generation failed:
  // Failed to fetch`. That string is every network call in the chain collapsed
  // into one, because a browser `TypeError` carries no status, no body and no
  // URL. Six fetches, six different remedies, one sentence.
  //
  // The discriminator being thrown away is WHETHER THE CALL WAS PROXIED. Five
  // of the six go through the same-origin `/__tripo` path; `download` is
  // deliberately direct to the asset host. "The dev server's proxy did not
  // answer" and "a cross-origin download was blocked" are different problems,
  // and only the URL's shape says which happened.
  const PROXIED = { baseUrl: '/__tripo/v2' };
  const IMAGE = {
    source: 'image',
    image: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
  } as const;

  /** What a browser throws when a request never becomes a response. */
  const offline = () => Promise.reject(new TypeError('Failed to fetch'));

  /** Succeeds through create+poll, then dies on the direct download. */
  function dieOnDownload() {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
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
      return offline();
    });
  }

  it('names the proxied stage that failed, and says the path is dev-server-only', async () => {
    const err = await client(offline, PROXIED)
      .generate(TEXT)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('Tripo POST /task');
    expect(message).toContain('/__tripo/v2/task');
    expect(message).toContain('production');
    // The raw browser string survives as the cause, so nothing is hidden.
    expect(message).toContain('Failed to fetch');
  });

  it('names the DIRECT host on a download, and points at the missing CORS header', async () => {
    const err = await client(dieOnDownload(), PROXIED)
      .generate(TEXT)
      .catch((e: unknown) => e);

    const message = (err as Error).message;
    expect(message).toContain('Downloading the generated model');
    expect(message).toContain('cdn');
    expect(message).toContain('DIRECTLY');
    expect(message).toContain('access-control-allow-origin');
  });

  it('names the image upload, which is the stage only an image request reaches', async () => {
    const err = await client(offline, PROXIED)
      .generate(IMAGE)
      .catch((e: unknown) => e);

    expect((err as Error).message).toContain('Uploading the reference image');
  });

  it('🔑 FALSIFICATION: the proxied and the direct failure do not read the same', async () => {
    // This is the whole defect. Before the fix BOTH of these were the string
    // "Failed to fetch" — identical, and therefore useless for deciding which
    // of the two completely different faults had occurred. If a future change
    // collapses them again, this goes red.
    const proxied = (await client(offline, PROXIED)
      .generate(TEXT)
      .catch((e: unknown) => e)) as Error;
    const direct = (await client(dieOnDownload(), PROXIED)
      .generate(TEXT)
      .catch((e: unknown) => e)) as Error;

    expect(proxied.message).not.toEqual(direct.message);
    // And neither is the bare browser string that started this.
    expect(proxied.message).not.toEqual('Failed to fetch');
    expect(direct.message).not.toEqual('Failed to fetch');
  });

  it('does NOT reclassify a service that answered — an HTTP error stays an API error', async () => {
    // The pair. A wrapper that swallowed every failure into "unreachable" would
    // satisfy the tests above and destroy the distinction they exist to make:
    // "the host never answered" and "the host said no" have opposite remedies.
    const refuse = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 2, message: 'Invalid API key' }), { status: 401 }),
    );
    const err = await client(refuse, PROXIED)
      .generate(TEXT)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TripoApiError);
    expect((err as Error).message).not.toContain('never got a reply');
  });

  it('re-throws an abort untouched, so a timeout is not dressed up as an unreachable host', async () => {
    const aborted = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
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
      const abort = new Error('The operation was aborted.');
      abort.name = 'AbortError';
      throw abort;
    });

    const err = (await client(aborted, PROXIED)
      .generate(TEXT)
      .catch((e: unknown) => e)) as Error;

    expect(err.name).toBe('AbortError');
    expect(err.message).not.toContain('never got a reply');
  });
});

describe('a page fetches the generated model same-origin; a node harness does not (#832)', () => {
  const ASSET =
    'https://tripo-data.rg1.data.tripo3d.com/x/tripo_pbr_model_x.glb?Policy=P&Signature=S';

  /** Succeeds through create+poll and hands back a real asset-host URL. */
  function scripted(seen: string[]) {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      seen.push(u);
      if (u.endsWith('/task') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 't1' } }), { status: 200 });
      }
      if (u.includes('/task/t1')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { status: 'success', progress: 100, output: { pbr_model: ASSET } },
          }),
          { status: 200 },
        );
      }
      return new Response(synthesiseGlb(TEXT), { status: 200 });
    });
  }

  it('rewrites the download onto the same-origin forwarder when the API is proxied', async () => {
    const seen: string[] = [];
    await client(scripted(seen), { baseUrl: '/__tripo/v2' }).generate(TEXT);

    const download = seen[seen.length - 1];
    expect(download.startsWith('/__tripo-asset?url=')).toBe(true);
    // The signature must survive, or the download 403s as a plausible "expired
    // link" and sends the reader to the wrong problem.
    expect(decodeURIComponent(download.split('?url=')[1])).toBe(ASSET);
  });

  it('leaves the download DIRECT for a node harness, which has no same-origin policy', async () => {
    // The pair. A rewrite applied unconditionally would point the node harness
    // and the live probe at a dev-server route that does not exist for them.
    const seen: string[] = [];
    await client(scripted(seen)).generate(TEXT); // absolute dialect baseUrl

    expect(seen[seen.length - 1]).toBe(ASSET);
  });

  it('leaves a NON-asset host alone even from a page, so a refusal is not disguised', async () => {
    // A URL outside the allowlist would be refused by the forwarder anyway.
    // Rewriting it would replace the honest failure with a 400 from our own
    // middleware, which reads like our bug rather than the service's.
    const seen: string[] = [];
    const foreign = 'https://cdn.example.test/x.glb';
    const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      seen.push(u);
      if (u.endsWith('/task') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 't1' } }), { status: 200 });
      }
      if (u.includes('/task/t1')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { status: 'success', progress: 100, output: { pbr_model: foreign } },
          }),
          { status: 200 },
        );
      }
      return new Response(synthesiseGlb(TEXT), { status: 200 });
    });
    await client(f, { baseUrl: '/__tripo/v2' }).generate(TEXT);

    expect(seen[seen.length - 1]).toBe(foreign);
  });
});

describe('a task can be run WITHOUT collecting its output (#833)', () => {
  const ASSET = 'https://tripo-data.rg1.data.tripo3d.com/x/tripo_pbr_model_x.glb';

  function scripted(seen: string[]) {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      seen.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/task') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 't1' } }), { status: 200 });
      }
      if (u.includes('/task/t1')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { status: 'success', progress: 100, output: { pbr_model: ASSET } },
          }),
          { status: 200 },
        );
      }
      return new Response(synthesiseGlb(TEXT), { status: 200 });
    });
  }

  it('🔑 issues NO download request — the whole point', async () => {
    // The defect: the rigged road bound only `taskId` from the wide result, so a
    // measured 7,465,804-byte mesh was fetched and dropped. Asserting on the
    // CALLS rather than on the return value is what makes that visible — a
    // narrowed return type would look identical from the caller's side while
    // still paying for the transfer.
    const seen: string[] = [];
    const result = await client(scripted(seen), { baseUrl: '/__tripo/v2' }).generateTaskOnly(TEXT);

    expect(result).toEqual({ taskId: 't1', modelVersion: 'unspecified' });
    expect(seen).toEqual(['POST /__tripo/v2/task', 'GET /__tripo/v2/task/t1']);
    expect(seen.some((c) => c.includes('tripo-asset') || c.includes(ASSET))).toBe(false);
  });

  it('FALSIFICATION: `generate` on the same script DOES download', async () => {
    // The pair. Without it the test above passes for a client that cannot reach
    // the asset host at all, which is a different bug wearing the same green.
    const seen: string[] = [];
    const result = await client(scripted(seen), { baseUrl: '/__tripo/v2' }).generate(TEXT);

    expect(result.glb.byteLength).toBeGreaterThan(0);
    expect(seen.length).toBe(3);
    expect(seen[2]).toContain('/__tripo-asset?url=');
  });

  it('refuses the same requests `generate` refuses, at the same point', async () => {
    // Same validation, same ordering: a narrow road that skipped the gate would
    // be a way to reach the service around a refusal.
    const seen: string[] = [];
    await expect(
      client(scripted(seen), { baseUrl: '/__tripo/v2' }).generateTaskOnly({
        source: 'text',
        prompt: '   ',
      } as never),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it('reports progress, so a caller sees the task run', async () => {
    const seen: string[] = [];
    const progress: number[] = [];
    await client(scripted(seen), { baseUrl: '/__tripo/v2' }).generateTaskOnly(TEXT, (p) =>
      progress.push(p.progress),
    );
    expect(progress.length).toBeGreaterThan(0);
  });
});
