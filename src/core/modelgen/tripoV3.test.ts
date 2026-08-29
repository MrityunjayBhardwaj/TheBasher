// The v3 transport — what goes out, what comes back, and every place it differs
// from v2.
//
// 🔴 A NOTE ON WHAT THIS FILE CAN AND CANNOT PROVE. v2's suite asserts a wire
// read out of Tripo's own SDK source. This one asserts a wire read out of
// Tripo's DOCUMENTATION, because there is no v3 source to read and the vendor's
// machine-readable schema is published behind authentication. So these tests pin
// what we BELIEVE v3's contract is, and they will hold that belief steady
// through refactors — which is worth having — but a green run here is not
// evidence about the running service. The moment a working key exists, fetch the
// authenticated schema and re-verify this file against it.
//
// The tests that DO carry full weight regardless are the cross-version ones: a
// v2-shaped response read by the v3 dialect, and the reverse. Those assert an
// internal consistency that does not depend on the vendor being described
// correctly.
//
// Same licence-gate mock as tripoTransport.test.ts, for the same reason: this
// file asks "given permission, what does it say on the wire?" The refusal is
// tested for real in modelgen.test.ts.
//
// REF: https://developers.tripo3d.ai/en/docs; src/core/modelgen/tripoDialect.ts;
//      issue #797.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../licensing/allowedModels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../licensing/allowedModels')>();
  return {
    ...actual,
    assertModelAllowed: () => ({ id: 'tripo-api', verdict: 'ALLOWED' }),
  };
});

const { TripoModelGenerationCapability } = await import('./TripoModelGenerationCapability');
const { synthesiseGlb } = await import('./StubModelGenerationCapability');
const { synthesiseRiggedGlb } = await import('../rigging/StubRiggingCapability');
const {
  TRIPO_V2_DIALECT,
  TRIPO_V3_DIALECT,
  TRIPO_V3_BASE_URL,
  TRIPO_V3_DEFAULT_MODEL_VERSION,
  DEFAULT_TRIPO_API_VERSION,
} = await import('./tripoDialect');

const KEY = 'tcli_whatever_the_console_issues';
const TEXT = { source: 'text', prompt: 'a red chair' } as const;

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
}

/** A fetch that answers create → poll → download, recording every request. */
function transport(
  output: Record<string, unknown>,
  glb: ArrayBuffer = synthesiseGlb(TEXT),
): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? 'GET';
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
    sent.push({ url: href, method, body });

    if (href.includes('/account/balance')) {
      return new Response(JSON.stringify({ data: { balance: 100, frozen: 0 } }), { status: 200 });
    }
    if (href.includes('/files')) {
      return new Response(JSON.stringify({ data: { file_token: 'ftok' } }), { status: 200 });
    }
    if (method === 'POST') {
      return new Response(JSON.stringify({ data: { task_id: 'task-1' } }), { status: 200 });
    }
    if (href.includes('/tasks/')) {
      return new Response(JSON.stringify({ data: { status: 'success', progress: 100, output } }), {
        status: 200,
      });
    }
    return new Response(glb, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function client(fetchImpl: typeof fetch, over: Record<string, unknown> = {}) {
  return new TripoModelGenerationCapability({
    apiKey: KEY,
    apiVersion: 'v3',
    baseUrl: 'http://tripo.test',
    pollIntervalMs: 0,
    fetchImpl,
    sleepImpl: async () => {},
    ...over,
  });
}

/** A v3-shaped successful output. */
const V3_OUTPUT = { model_url: 'http://cdn.test/model.glb' };

describe('v3 is the version the client speaks by default', () => {
  it('defaults to v3, and to v3’s host', () => {
    // Stated as a test because it is a behavioural default: a silent revert to
    // v2 would otherwise change every request the app makes and break nothing
    // that is currently asserted.
    expect(DEFAULT_TRIPO_API_VERSION).toBe('v3');
    expect(TRIPO_V3_BASE_URL).toBe('https://openapi.tripo3d.ai/v3');
  });

  it('a client constructed with no version walks v3’s paths', async () => {
    const { fetchImpl, sent } = transport(V3_OUTPUT);
    // No apiVersion, no baseUrl override beyond the test host.
    const cap = new TripoModelGenerationCapability({
      apiKey: KEY,
      baseUrl: 'http://tripo.test',
      pollIntervalMs: 0,
      fetchImpl,
      sleepImpl: async () => {},
    });
    await cap.generate(TEXT);
    expect(sent[0].url).toBe('http://tripo.test/generation/text-to-model');
    expect(sent[1].url).toBe('http://tripo.test/tasks/task-1');
  });
});

describe('create → poll → download, on v3’s paths', () => {
  it('posts to the per-source path and carries NO type discriminator', async () => {
    const { fetchImpl, sent } = transport(V3_OUTPUT);
    await client(fetchImpl).generate(TEXT);

    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).toBe('http://tripo.test/generation/text-to-model');
    // v2 posts everything to /task and discriminates on `type`. v3 gives each
    // source its own path, so a `type` field would be a stray v2-ism.
    expect(sent[0].body).not.toHaveProperty('type');
    expect(sent[0].body).toMatchObject({ prompt: 'a red chair' });

    expect(sent[1].method).toBe('GET');
    expect(sent[1].url).toBe('http://tripo.test/tasks/task-1');
    expect(sent[2].url).toBe('http://cdn.test/model.glb');
  });

  it('reads the balance from /account/balance, not v2’s /user/balance', async () => {
    const { fetchImpl, sent } = transport(V3_OUTPUT);
    await expect(client(fetchImpl).getBalance()).resolves.toEqual({ balance: 100, frozen: 0 });
    expect(sent[0].url).toBe('http://tripo.test/account/balance');
  });
});

describe('v3 REQUIRES a model version, so one is always sent', () => {
  it('supplies the documented default when the caller names none', async () => {
    const { fetchImpl, sent } = transport(V3_OUTPUT);
    await client(fetchImpl).generate(TEXT);
    // v3 marks `model` required. Omitting it makes the request malformed rather
    // than defaulted by the service, so a caller who does not care must still
    // get a valid request.
    expect(sent[0].body).toMatchObject({ model: TRIPO_V3_DEFAULT_MODEL_VERSION });
  });

  it('an explicit caller choice wins over the default', async () => {
    const { fetchImpl, sent } = transport(V3_OUTPUT);
    await client(fetchImpl).generate({ ...TEXT, modelVersion: 'v2.5-20250123' });
    expect(sent[0].body).toMatchObject({ model: 'v2.5-20250123' });
    // And under its v3 name — `model_version` is the v2 spelling.
    expect(sent[0].body).not.toHaveProperty('model_version');
  });
});

describe('the documented key prefix — and its absence — is a value, not a literal', () => {
  it('v2 states a prefix, v3 states none', () => {
    // Read by TWO consumers: `assertTripoKeyShape` and the settings panel's
    // while-typing hint. Both derive it from here rather than typing `tsk_`,
    // because a hint that tells someone their VALID key looks wrong is worse
    // than no hint — it is a confident claim that sends them to re-copy a key
    // that was already right.
    expect(TRIPO_V2_DIALECT.keyPrefix).toBe('tsk_');
    expect(TRIPO_V3_DIALECT.keyPrefix).toBeUndefined();
  });
});

describe('options v3 does not document are DROPPED, not forwarded', () => {
  it('drops `style`, which v3’s request schemas do not list', async () => {
    const { fetchImpl, sent } = transport(V3_OUTPUT);
    await client(fetchImpl).generate({ ...TEXT, style: 'person:person2cartoon' });
    // Pinned rather than left to chance. Sending a field a contract does not
    // name gets the request rejected wholesale or, worse, silently ignored.
    expect(sent[0].body).not.toHaveProperty('style');
    // 🔴 AND IT IS DROPPED SILENTLY, WHICH IS A KNOWN GAP, NOT A DECISION. It is
    // not a refusal because v3's field list reaches us through vendor prose, not
    // source — the same weak evidence that stopped us inventing a key-prefix
    // rule. Refusing on it would build a hard failure on a soft reading. See the
    // issue for the open question.
  });

  it('v2 still forwards `style`, so the drop is a v3 property and not a lost feature', () => {
    // The comparison arm: without it, "v3 omits style" is indistinguishable from
    // "style stopped working everywhere". Asserted against the dialect directly
    // — body assembly is a pure function of the request, which is the whole
    // reason uploading was split out of it.
    const styled = { ...TEXT, style: 'person:person2cartoon' } as const;
    expect(TRIPO_V2_DIALECT.modelCall(styled, {}).body).toMatchObject({
      style: 'person:person2cartoon',
    });
    expect(TRIPO_V3_DIALECT.modelCall(styled, {}).body).not.toHaveProperty('style');
  });
});

describe('the output URL moved, and reading the wrong one finds nothing', () => {
  it('reads model_url', async () => {
    const { fetchImpl, sent } = transport({ model_url: 'http://cdn.test/a.glb' });
    await client(fetchImpl).generate(TEXT);
    expect(sent[2].url).toBe('http://cdn.test/a.glb');
  });

  it('falls back to the first of model_urls', async () => {
    const { fetchImpl, sent } = transport({ model_urls: ['http://cdn.test/b.glb'] });
    await client(fetchImpl).generate(TEXT);
    expect(sent[2].url).toBe('http://cdn.test/b.glb');
  });

  it('🔑 the rename is REAL: each dialect finds nothing in the other’s output', () => {
    // The concrete regression the issue names, asserted in BOTH directions.
    // This is the one claim in this file that does not depend on the vendor
    // documentation being right — it is about our own two readers disagreeing,
    // which is exactly what would have made a v3 task run, bill, and then look
    // like a failure.
    const v2Shaped = { pbr_model: 'http://cdn.test/v2.glb' };
    const v3Shaped = { model_url: 'http://cdn.test/v3.glb' };

    expect(TRIPO_V2_DIALECT.modelUrlOf(v2Shaped)).toBe('http://cdn.test/v2.glb');
    expect(TRIPO_V3_DIALECT.modelUrlOf(v2Shaped)).toBeUndefined();

    expect(TRIPO_V3_DIALECT.modelUrlOf(v3Shaped)).toBe('http://cdn.test/v3.glb');
    expect(TRIPO_V2_DIALECT.modelUrlOf(v3Shaped)).toBeUndefined();
  });

  it('names the version’s own expected fields when a task carries no URL', async () => {
    const { fetchImpl } = transport({});
    // A failure that says "expected model_url or model_urls" sends the reader to
    // the right place; one that names v2's fields sends them to the wrong one.
    await expect(client(fetchImpl).generate(TEXT)).rejects.toThrow(/model_url or model_urls/);
  });
});

describe('the rig road, on v3', () => {
  it('pre-checks at /animations/rig-check with `input`, not `original_model_task_id`', async () => {
    const { fetchImpl, sent } = transport({ riggable: true, rig_type: 'biped' });
    const check = await client(fetchImpl).checkRiggable({ sourceTaskId: 'mesh-1' });

    expect(sent[0].url).toBe('http://tripo.test/animations/rig-check');
    expect(sent[0].body).toEqual({ input: 'mesh-1' });
    expect(check).toMatchObject({ riggable: true, detectedRigType: 'biped' });
  });

  it('rigs at /animations/rig, pins glb, and still asks for mixamo', async () => {
    // 🔑 The join premise, on the new version: `spec` survives into v3 unchanged,
    // so the rig road is version-independent. If this ever stops being true the
    // whole text-to-3D → motion path loses its middle.
    const { fetchImpl, sent } = transport({ model_url: 'http://cdn.test/rig.glb' }, riggedGlb());
    await client(fetchImpl).rig({ sourceTaskId: 'mesh-1' });

    expect(sent[0].url).toBe('http://tripo.test/animations/rig');
    expect(sent[0].body).toEqual({
      input: 'mesh-1',
      rig_type: 'biped',
      spec: 'mixamo',
      out_format: 'glb',
    });
  });

  it('still REFUSES a rig that came back in a vocabulary nothing can drive', async () => {
    // The refusal is dialect-independent by construction — it reads the GLB, not
    // the response envelope — but a version change is exactly when a safety
    // check quietly stops running, so it is asserted here too.
    const { fetchImpl } = transport({ model_url: 'http://cdn.test/rig.glb' }, foreignRigGlb());
    await expect(client(fetchImpl).rig({ sourceTaskId: 'm', spec: 'mixamo' })).rejects.toThrow(
      /bone names are not Mixamo's/,
    );
  });
});

describe('uploads moved too, and the token changed its name', () => {
  const IMAGE = {
    source: 'image',
    image: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
  } as const;

  it('posts to /files and reads data.file_token', async () => {
    const { fetchImpl, sent } = transport(V3_OUTPUT);
    await client(fetchImpl).generate(IMAGE);

    expect(sent[0].url).toBe('http://tripo.test/files');
    expect(sent[1].url).toBe('http://tripo.test/generation/image-to-model');
    expect(sent[1].body).toMatchObject({ file: { type: 'png', file_token: 'ftok' } });
  });

  it('a v2-shaped upload response is NOT accepted under v3', async () => {
    // The failing arm. v2 answers `data.image_token`; if the dialect's token
    // field were ignored, this would silently produce `file_token: undefined`
    // and the task would fail later for an unrelated-looking reason.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes('/files')) {
        return new Response(JSON.stringify({ data: { image_token: 'v2tok' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { task_id: 't' } }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).generate(IMAGE)).rejects.toThrow(/upload failed/);
  });
});

// --- helpers ---------------------------------------------------------------

/** A rigged GLB carrying Mixamo bone names. */
function riggedGlb(): ArrayBuffer {
  return synthesiseRiggedGlb();
}

/**
 * The same GLB with its bones renamed, so the vocabulary check has something to
 * refuse.
 *
 * A same-width BYTE patch, not a decode/encode round trip: the BIN chunk is
 * binary, so passing the container through TextDecoder replaces every invalid
 * UTF-8 sequence with U+FFFD and the file comes back a different length and no
 * longer parseable.
 */
function foreignRigGlb(): ArrayBuffer {
  const bytes = new Uint8Array(synthesiseRiggedGlb());
  const from = [...'mixamorig'].map((c) => c.charCodeAt(0));
  const to = [...'Bip01_Fig'].map((c) => c.charCodeAt(0));
  expect(from.length).toBe(to.length);
  let hits = 0;
  outer: for (let i = 0; i + from.length <= bytes.length; i += 1) {
    for (let k = 0; k < from.length; k += 1) if (bytes[i + k] !== from[k]) continue outer;
    for (let k = 0; k < to.length; k += 1) bytes[i + k] = to[k];
    hits += 1;
  }
  // Non-vacuity: a patch that matched nothing leaves a VALID Mixamo rig, and the
  // refusal test would then pass for the opposite reason.
  expect(hits).toBeGreaterThan(0);
  return bytes.buffer as ArrayBuffer;
}
