import { describe, expect, it } from 'vitest';
import { HttpComfyUICapability } from './HttpComfyUICapability';
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
});
