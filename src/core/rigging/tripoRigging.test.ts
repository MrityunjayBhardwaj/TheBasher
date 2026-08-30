// The Tripo rigging transport: what goes out, what comes back, and what is
// refused. Every field asserted here is cited to the SDK source rather than
// guessed — see RiggingCapability.ts for the REF block.

import { describe, expect, it, vi } from 'vitest';
import { TripoModelGenerationCapability } from '../modelgen/TripoModelGenerationCapability';
import { StubRiggingCapability, synthesiseRiggedGlb } from './StubRiggingCapability';
import {
  RigRequestInvalidError,
  assertValidRigRequest,
  type RigRequest,
} from './RiggingCapability';

/**
 * Rename bones inside a GLB at the BYTE level, same width in and out.
 *
 * Not a decode/encode round trip: the BIN chunk is binary, so passing the whole
 * container through TextDecoder replaces every invalid UTF-8 sequence with U+FFFD
 * and the file comes back a different length and no longer parseable. Searching
 * for ASCII bytes touches only what matches and leaves every offset intact, which
 * is what keeps the container valid.
 */
function renameBonesInPlace(glb: ArrayBuffer, from: string, to: string): ArrayBuffer {
  expect(from.length).toBe(to.length);
  const bytes = new Uint8Array(glb.slice(0));
  const needle = [...from].map((c) => c.charCodeAt(0));
  const repl = [...to].map((c) => c.charCodeAt(0));
  let hits = 0;
  outer: for (let i = 0; i + needle.length <= bytes.length; i += 1) {
    for (let k = 0; k < needle.length; k += 1) if (bytes[i + k] !== needle[k]) continue outer;
    for (let k = 0; k < repl.length; k += 1) bytes[i + k] = repl[k];
    hits += 1;
  }
  // Non-vacuity: a patch that matched nothing would leave a VALID Mixamo rig and
  // the refusal test would pass for the opposite reason.
  expect(hits).toBeGreaterThan(0);
  return bytes.buffer as ArrayBuffer;
}

const KEY = 'tsk_test_key';
// v2 wire, stated rather than inherited from the client's default — which is
// now v3. See tripoV3.test.ts for the v3 half of the same contract.
const opts = {
  apiKey: KEY,
  apiVersion: 'v2' as const,
  baseUrl: 'http://tripo.test',
  pollIntervalMs: 0,
};

/** A fetch that answers the create → poll → download sequence. */
function transport(
  output: Record<string, unknown>,
  glb: ArrayBuffer | null = synthesiseRiggedGlb(),
): { fetchImpl: typeof fetch; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/task') && init?.method === 'POST') {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: { task_id: 'task-1' } }), { status: 200 });
    }
    if (href.includes('/task/')) {
      return new Response(JSON.stringify({ data: { status: 'success', progress: 100, output } }), {
        status: 200,
      });
    }
    // the model download
    return new Response(glb ?? new ArrayBuffer(0), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

describe('the pre-rig check', () => {
  it('asks animate_prerigcheck for the named mesh and reports both answers', async () => {
    const { fetchImpl, sent } = transport({ riggable: true, rig_type: 'quadruped' });
    const cap = new TripoModelGenerationCapability({ ...opts, fetchImpl });
    const check = await cap.checkRiggable({ sourceTaskId: 'mesh-9' });

    expect(sent[0]).toMatchObject({
      type: 'animate_prerigcheck',
      original_model_task_id: 'mesh-9',
    });
    expect(check.riggable).toBe(true);
    expect(check.detectedRigType).toBe('quadruped');
  });

  it('reports an unrecognised body plan as null, NOT as "others"', async () => {
    // "I could not tell" and "it is some other body plan" are different answers.
    // Collapsing them turns silence into a positive claim a caller would act on.
    const { fetchImpl } = transport({ riggable: true, rig_type: 'tentacled' });
    const cap = new TripoModelGenerationCapability({ ...opts, fetchImpl });
    expect((await cap.checkRiggable({ sourceTaskId: 'm' })).detectedRigType).toBeNull();
  });

  it('reports a missing riggable field as NOT riggable rather than assuming yes', async () => {
    const { fetchImpl } = transport({});
    const cap = new TripoModelGenerationCapability({ ...opts, fetchImpl });
    expect((await cap.checkRiggable({ sourceTaskId: 'm' })).riggable).toBe(false);
  });
});

describe('the rig call', () => {
  it('sends animate_rig, pins glb, and forwards the body plan and the spec', async () => {
    const { fetchImpl, sent } = transport({ model: 'http://tripo.test/out.glb' });
    const cap = new TripoModelGenerationCapability({ ...opts, fetchImpl });
    await cap.rig({ sourceTaskId: 'mesh-9', rigType: 'biped', spec: 'mixamo' });

    expect(sent[0]).toMatchObject({
      type: 'animate_rig',
      original_model_task_id: 'mesh-9',
      // Pinned, not exposed: the contract is that a rigged mesh takes the SAME
      // import road a dropped .glb takes, and fbx would fork it.
      out_format: 'glb',
      rig_type: 'biped',
      spec: 'mixamo',
    });
  });

  it('defaults to a biped rigged to mixamo — the combination anything downstream can drive', async () => {
    const { fetchImpl, sent } = transport({ model: 'http://tripo.test/out.glb' });
    const cap = new TripoModelGenerationCapability({ ...opts, fetchImpl });
    const result = await cap.rig({ sourceTaskId: 'mesh-9' });
    expect(sent[0]).toMatchObject({ rig_type: 'biped', spec: 'mixamo' });
    expect(result.requestedSpec).toBe('mixamo');
  });

  it('REFUSES a rig that came back in a vocabulary nothing can drive', async () => {
    // The check that keeps `requestedSpec` from being a lying label. A service
    // that accepted spec:mixamo and returned its own convention would otherwise
    // be invisible — the call succeeded, the field says mixamo, and the retarget
    // downstream silently binds nothing.
    const foreign = await new StubRiggingCapability().rig({ sourceTaskId: 'x' });
    const swapped = renameBonesInPlace(foreign.glb, 'mixamorig_', 'tripoRIGx_');

    const { fetchImpl } = transport({ model: 'http://tripo.test/out.glb' }, swapped);
    const cap = new TripoModelGenerationCapability({ ...opts, fetchImpl });
    await expect(cap.rig({ sourceTaskId: 'm', spec: 'mixamo' })).rejects.toThrow(/not Mixamo/);
  });

  it('accepts a rig that DID come back in the requested vocabulary', async () => {
    const { fetchImpl } = transport({ model: 'http://tripo.test/out.glb' });
    const cap = new TripoModelGenerationCapability({ ...opts, fetchImpl });
    const result = await cap.rig({ sourceTaskId: 'm', spec: 'mixamo' });
    expect(result.taskId).toBe('task-1');
    expect(result.glb.byteLength).toBeGreaterThan(0);
  });

  it('does NOT report a vocabulary mismatch for bytes it could not read at all', async () => {
    // An unparseable payload is a different failure with a different owner. The
    // ordinary import road names that one; reporting it as a wrong skeleton would
    // send whoever reads the message to the wrong place entirely.
    const { fetchImpl } = transport(
      { model: 'http://tripo.test/out.glb' },
      new TextEncoder().encode('not a glb at all').buffer as ArrayBuffer,
    );
    const cap = new TripoModelGenerationCapability({ ...opts, fetchImpl });
    await expect(cap.rig({ sourceTaskId: 'm', spec: 'mixamo' })).resolves.toBeTruthy();
  });

  it('refuses a rig whose task succeeded but carried no model URL', async () => {
    const { fetchImpl } = transport({});
    const cap = new TripoModelGenerationCapability({ ...opts, fetchImpl });
    await expect(cap.rig({ sourceTaskId: 'm' })).rejects.toThrow(/no model URL/);
  });
});

describe('the request contract', () => {
  it('refuses an empty source task id — a rig of nothing', () => {
    expect(() => assertValidRigRequest({ sourceTaskId: '   ' })).toThrow(RigRequestInvalidError);
  });

  it('refuses an unknown body plan and an unknown spec, by name', () => {
    expect(() =>
      assertValidRigRequest({ sourceTaskId: 'm', rigType: 'dragon' } as unknown as RigRequest),
    ).toThrow(/rigType/);
    expect(() =>
      assertValidRigRequest({ sourceTaskId: 'm', spec: 'unreal' } as unknown as RigRequest),
    ).toThrow(/spec/);
  });

  it('is STRICT — an unknown field is named rather than silently dropped', () => {
    // Same reasoning as the motion request: a permissive object would strip it
    // and succeed, so a caller asking for something we do not support would
    // believe it was honoured.
    expect(() =>
      assertValidRigRequest({ sourceTaskId: 'm', outFormat: 'fbx' } as unknown as RigRequest),
    ).toThrow(/outFormat/);
  });

  it('nothing reaches the network before the request is validated', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const cap = new TripoModelGenerationCapability({
      ...opts,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(cap.rig({ sourceTaskId: '' })).rejects.toThrow(RigRequestInvalidError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
