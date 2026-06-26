import { describe, expect, it } from 'vitest';
import { HttpComfyUICapability } from './HttpComfyUICapability';
import { comfyHasNodeTypes, probeComfyUI } from './index';
import { StubComfyUICapability } from './StubComfyUICapability';
import type { ComfyInputs } from './ComfyUICapability';

const baseInputs: ComfyInputs = {
  images: { beauty: Uint8Array.of(1, 2, 3, 4) },
  scalars: { prompt: 'a cube', frame: 0 },
};

describe('StubComfyUICapability', () => {
  it('isAvailable returns true', async () => {
    const stub = new StubComfyUICapability();
    expect(await stub.isAvailable()).toBe(true);
  });

  it('returns deterministic bytes for identical (workflowJson, inputs) on twice-call', async () => {
    const stub = new StubComfyUICapability();
    const wf = { nodes: { '1': { class: 'KSampler' } } };
    const a = await stub.submit(wf, baseInputs);
    const b = await stub.submit(wf, baseInputs);
    expect(a.frame).toEqual(b.frame);
    expect(a.jobId).not.toEqual(b.jobId); // job ids advance; bytes don't.
  });

  it('produces different bytes when prompt scalar changes', async () => {
    const stub = new StubComfyUICapability();
    const wf = { nodes: {} };
    const a = await stub.submit(wf, baseInputs);
    const b = await stub.submit(wf, {
      images: baseInputs.images,
      scalars: { prompt: 'a sphere', frame: 0 },
    });
    expect(a.frame).not.toEqual(b.frame);
  });

  it('produces different bytes when image content changes (not just key)', async () => {
    const stub = new StubComfyUICapability();
    const wf = { nodes: {} };
    const a = await stub.submit(wf, {
      images: { beauty: Uint8Array.of(1, 2, 3) },
      scalars: {},
    });
    const b = await stub.submit(wf, {
      images: { beauty: Uint8Array.of(9, 8, 7) },
      scalars: {},
    });
    expect(a.frame).not.toEqual(b.frame);
  });

  it('produces different bytes when workflow JSON changes', async () => {
    const stub = new StubComfyUICapability();
    const a = await stub.submit({ nodes: { '1': { class: 'KSampler' } } }, baseInputs);
    const b = await stub.submit({ nodes: { '1': { class: 'CLIPTextEncode' } } }, baseInputs);
    expect(a.frame).not.toEqual(b.frame);
  });

  it('returns byte-identical bytes regardless of object key insertion order', async () => {
    const stub = new StubComfyUICapability();
    const a = await stub.submit({ a: 1, b: 2 }, baseInputs);
    const b = await stub.submit({ b: 2, a: 1 }, baseInputs);
    expect(a.frame).toEqual(b.frame);
  });

  it('throws from errorQueue when configured (one entry consumed per submit)', async () => {
    const stub = new StubComfyUICapability({
      errorQueue: [new Error('boom')],
    });
    await expect(stub.submit({}, baseInputs)).rejects.toThrow('boom');
    // After the queued error is consumed the next submit succeeds — proves
    // the failure is not sticky and the loop in runComfyUIWorkflow can
    // resume on retry.
    const ok = await stub.submit({}, baseInputs);
    expect(ok.frame.length).toBeGreaterThan(0);
  });

  it('cancel marks the job as cancelled (test-only inspection)', async () => {
    const stub = new StubComfyUICapability();
    const result = await stub.submit({}, baseInputs);
    await stub.cancel(result.jobId);
    expect(stub.wasCancelled(result.jobId)).toBe(true);
  });

  it('produces bytes that begin with a valid PNG signature', async () => {
    const stub = new StubComfyUICapability();
    const result = await stub.submit({}, baseInputs);
    const sig = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(result.frame.subarray(0, sig.length)).toEqual(sig);
  });

  it('submitBatch returns N frames sized to the workflow batch dimension (design §8)', async () => {
    const stub = new StubComfyUICapability();
    // batch_size on EmptyLatentImage = the schedule length the compiler sets.
    const wf = { '5': { class_type: 'EmptyLatentImage', inputs: { batch_size: 4 } } };
    const { frames, jobId } = await stub.submitBatch(wf, baseInputs);
    expect(frames).toHaveLength(4);
    expect(jobId).toMatch(/^stub_/);
    // each frame is a valid PNG
    const sig = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    for (const f of frames) expect(f.subarray(0, sig.length)).toEqual(sig);
  });

  it('submitBatch frames are deterministic and distinct per batch index', async () => {
    const stub = new StubComfyUICapability();
    const wf = { s: { class_type: 'BasherValueSchedule', inputs: { frame_count: 3 } } };
    const a = await stub.submitBatch(wf, baseInputs);
    const b = await stub.submitBatch(wf, baseInputs);
    expect(a.frames).toHaveLength(3);
    // deterministic across calls (same graph+inputs → same frames)
    a.frames.forEach((f, i) => expect(f).toEqual(b.frames[i]));
    // distinct per index (the schedule varies the value per frame)
    expect(a.frames[0]).not.toEqual(a.frames[1]);
    expect(a.frames[1]).not.toEqual(a.frames[2]);
  });

  it('submitBatch defaults to a single frame when no batch dimension is present', async () => {
    const stub = new StubComfyUICapability();
    const { frames } = await stub.submitBatch({ nodes: {} }, baseInputs);
    expect(frames).toHaveLength(1);
  });

  it('submitBatch emits synthetic progress events when onEvent is given (the UI seam)', async () => {
    const stub = new StubComfyUICapability();
    const wf = { '5': { class_type: 'EmptyLatentImage', inputs: { batch_size: 3 } } };
    const events: string[] = [];
    let previewBytes = 0;
    await stub.submitBatch(wf, baseInputs, (e) => {
      events.push(e.kind);
      if (e.kind === 'preview') previewBytes = e.bytes.length;
      if (e.kind === 'progress') expect(e.max).toBe(3);
    });
    expect(events).toEqual(['executing', 'progress', 'preview', 'progress']);
    expect(previewBytes).toBeGreaterThan(0); // a real (1×1 PNG) preview frame
  });
});

describe('HttpComfyUICapability', () => {
  it('isAvailable returns false when fetch throws (no server)', async () => {
    const cap = new HttpComfyUICapability('http://127.0.0.1:65535', {
      fetchImpl: async () => {
        throw new Error('refused');
      },
    });
    expect(await cap.isAvailable()).toBe(false);
  });

  it('isAvailable returns true when /system_stats responds 200', async () => {
    const cap = new HttpComfyUICapability('http://example.invalid', {
      fetchImpl: async (input) => {
        if (typeof input === 'string' && input.endsWith('/system_stats')) {
          return new Response('{}', { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    expect(await cap.isAvailable()).toBe(true);
  });

  it('submit pipelines upload → prompt → poll → fetch in order', async () => {
    const calls: string[] = [];
    const cap = new HttpComfyUICapability('http://example.invalid', {
      pollIntervalMs: 1,
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        calls.push(url);
        if (url.endsWith('/upload/image')) {
          return new Response('{}', { status: 200 });
        }
        if (url.endsWith('/prompt')) {
          return new Response(JSON.stringify({ prompt_id: 'abc' }), { status: 200 });
        }
        if (url.endsWith('/history/abc')) {
          return new Response(
            JSON.stringify({
              abc: {
                outputs: { '9': { images: [{ filename: 'out.png', type: 'output' }] } },
              },
            }),
            { status: 200 },
          );
        }
        if (url.includes('/view?')) {
          return new Response(new Uint8Array([42, 42, 42]), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const result = await cap.submit({ nodes: {} }, baseInputs);
    expect(result.jobId).toBe('abc');
    expect(Array.from(result.frame)).toEqual([42, 42, 42]);
    expect(calls.some((c) => c.endsWith('/upload/image'))).toBe(true);
    const promptIdx = calls.findIndex((c) => c.endsWith('/prompt'));
    const historyIdx = calls.findIndex((c) => c.endsWith('/history/abc'));
    const viewIdx = calls.findIndex((c) => c.includes('/view?'));
    expect(promptIdx).toBeGreaterThan(-1);
    expect(historyIdx).toBeGreaterThan(promptIdx);
    expect(viewIdx).toBeGreaterThan(historyIdx);
  });

  it('submit throws when /prompt rejects', async () => {
    const cap = new HttpComfyUICapability('http://example.invalid', {
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        if (url.endsWith('/upload/image')) return new Response('{}', { status: 200 });
        if (url.endsWith('/prompt')) {
          return new Response('bad workflow', { status: 400 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    await expect(cap.submit({}, baseInputs)).rejects.toThrow(/rejected: 400/);
  });

  it('submitBatch collects EVERY output image across all nodes (design §8)', async () => {
    const cap = new HttpComfyUICapability('http://example.invalid', {
      pollIntervalMs: 1,
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        if (url.endsWith('/upload/image')) return new Response('{}', { status: 200 });
        if (url.endsWith('/prompt'))
          return new Response(JSON.stringify({ prompt_id: 'batch1' }), { status: 200 });
        if (url.endsWith('/history/batch1')) {
          // A batched SaveImage emits N images on ONE node; submitBatch must
          // gather them all (vs submit's first-node-first-image).
          return new Response(
            JSON.stringify({
              batch1: {
                outputs: {
                  '9': {
                    images: [
                      { filename: 'f0.png', type: 'output' },
                      { filename: 'f1.png', type: 'output' },
                      { filename: 'f2.png', type: 'output' },
                    ],
                  },
                },
              },
            }),
            { status: 200 },
          );
        }
        if (url.includes('/view?')) {
          const fname = new URL(url).searchParams.get('filename') ?? '';
          // byte tag = the frame index, so order is verifiable
          const tag = Number(fname.replace(/\D/g, '')) || 0;
          return new Response(new Uint8Array([tag, tag, tag]), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const { jobId, frames } = await cap.submitBatch({ nodes: {} }, baseInputs);
    expect(jobId).toBe('batch1');
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => f[0])).toEqual([0, 1, 2]);
  });

  it('submitBatch throws when the batch produced no images', async () => {
    const cap = new HttpComfyUICapability('http://example.invalid', {
      pollIntervalMs: 1,
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        if (url.endsWith('/upload/image')) return new Response('{}', { status: 200 });
        if (url.endsWith('/prompt'))
          return new Response(JSON.stringify({ prompt_id: 'empty1' }), { status: 200 });
        if (url.endsWith('/history/empty1'))
          return new Response(JSON.stringify({ empty1: { outputs: { '9': {} } } }), {
            status: 200,
          });
        return new Response('not found', { status: 404 });
      },
    });
    await expect(cap.submitBatch({}, baseInputs)).rejects.toThrow(/no output images/);
  });
});

describe('auth header (Inc 2 — guarded server)', () => {
  function captureHeaders() {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get('Authorization') });
      if (url.endsWith('/system_stats')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 200 });
    };
    return { seen, fetchImpl };
  }

  it('sends the Authorization header on every request when authHeader is set', async () => {
    const { seen, fetchImpl } = captureHeaders();
    const cap = new HttpComfyUICapability('http://example.invalid', {
      authHeader: 'Bearer secret',
      fetchImpl,
    });
    await cap.isAvailable();
    expect(seen.every((c) => c.auth === 'Bearer secret')).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('omits the Authorization header when authHeader is empty/whitespace', async () => {
    const { seen, fetchImpl } = captureHeaders();
    const cap = new HttpComfyUICapability('http://example.invalid', {
      authHeader: '   ',
      fetchImpl,
    });
    await cap.isAvailable();
    expect(seen.every((c) => c.auth === null)).toBe(true);
  });
});

describe('probeComfyUI (Inc 2 — Test Connection)', () => {
  it('reports reachable + version + device from /system_stats', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ system: { comfyui_version: '0.26.0' }, devices: [{ type: 'mps' }] }),
        { status: 200 },
      );
    const res = await probeComfyUI('http://127.0.0.1:8188', {}, fetchImpl);
    expect(res).toEqual({ reachable: true, version: '0.26.0', device: 'mps' });
  });

  it('reports unreachable with the status on a non-ok response (e.g. CORS 403)', async () => {
    const fetchImpl: typeof fetch = async () => new Response('Forbidden', { status: 403 });
    const res = await probeComfyUI('http://127.0.0.1:8188', {}, fetchImpl);
    expect(res.reachable).toBe(false);
    expect(res.error).toContain('403');
  });

  it('reports unreachable with the error message when fetch throws', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const res = await probeComfyUI('http://nope.invalid', {}, fetchImpl);
    expect(res).toEqual({ reachable: false, error: 'Failed to fetch' });
  });

  it('forwards the auth header to the probe', async () => {
    let seenAuth: string | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenAuth = new Headers(init?.headers).get('Authorization');
      return new Response('{}', { status: 200 });
    };
    await probeComfyUI('http://x', { authHeader: 'Bearer t' }, fetchImpl);
    expect(seenAuth).toBe('Bearer t');
  });
});

describe('comfyHasNodeTypes (Inc 4 — BasherSchedule presence detect, §16 Q-E)', () => {
  function objectInfoFetch(types: string[]): typeof fetch {
    return async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/object_info')) {
        const body: Record<string, unknown> = {};
        for (const t of types) body[t] = { input: {}, output: [] };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };
  }

  it('returns true when ALL requested node types are present', async () => {
    const fetchImpl = objectInfoFetch(['KSampler', 'BasherValueSchedule', 'CLIPTextEncode']);
    expect(
      await comfyHasNodeTypes(['BasherValueSchedule'], 'http://example.invalid', {}, fetchImpl),
    ).toBe(true);
  });

  it('returns false when any requested type is missing', async () => {
    const fetchImpl = objectInfoFetch(['KSampler', 'CLIPTextEncode']); // no Basher node
    expect(
      await comfyHasNodeTypes(['BasherValueSchedule'], 'http://example.invalid', {}, fetchImpl),
    ).toBe(false);
  });

  it('treats an empty request as satisfied (nothing to check)', async () => {
    const fetchImpl = objectInfoFetch([]);
    expect(await comfyHasNodeTypes([], 'http://example.invalid', {}, fetchImpl)).toBe(true);
  });

  it('returns false on a network error (can’t tell → not installed, the safe direction)', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('refused');
    };
    expect(
      await comfyHasNodeTypes(['BasherValueSchedule'], 'http://example.invalid', {}, fetchImpl),
    ).toBe(false);
  });
});
