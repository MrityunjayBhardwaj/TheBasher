// The v3 transport — what goes out and what comes back. (Until #1403 this also pinned
// every place it differed from v2; v2 was retired at its feature freeze and removed.)
//
// 🔴 A NOTE ON WHAT THIS FILE CAN AND CANNOT PROVE. It asserts a wire read out of
// Tripo's DOCUMENTATION — there is no v3 source, and no machine-readable schema
// either: with a valid key every schema path answers 404, so the prose is the
// whole of it. (An earlier note here said the schema was published behind
// authentication. That was inferred from a 401 and measured false once a key
// existed — the 401 was an auth gate ahead of routing.) So these tests pin what
// we BELIEVE v3's contract is, and hold that belief steady through refactors,
// which is worth having — but a green run here is not evidence about the running
// service, and only a live call can now supply that.
//
// The tests that DO carry full weight regardless are the legacy-shape ones: a
// v2-shaped response (an output URL under `pbr_model`, an upload token under
// `image_token`) is NOT read as a v3 one. Those assert an internal consistency
// that does not depend on the vendor being described correctly.
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
  TRIPO_V3_DIALECT,
  TRIPO_V3_BASE_URL,
  TRIPO_V3_DEFAULT_MODEL_VERSION,
  TRIPO_V3_DEFAULT_RIG_MODEL,
  TRIPO_V3_RIG_MODEL_IGNORING_SPEC,
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
    baseUrl: 'http://tripo.test',
    pollIntervalMs: 0,
    fetchImpl,
    sleepImpl: async () => {},
    ...over,
  });
}

/** A v3-shaped successful output. */
const V3_OUTPUT = { model_url: 'http://cdn.test/model.glb' };

describe('v3 is the version the client speaks', () => {
  it('speaks v3, at v3’s host', () => {
    expect(DEFAULT_TRIPO_API_VERSION).toBe('v3');
    expect(TRIPO_V3_BASE_URL).toBe('https://openapi.tripo3d.ai/v3');
  });

  it('a client walks v3’s paths', async () => {
    const { fetchImpl, sent } = transport(V3_OUTPUT);
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
  it('v3 states none', () => {
    // Read by TWO consumers: `assertTripoKeyShape` and the settings panel's
    // while-typing hint. Both derive it from here rather than typing `tsk_`,
    // because a hint that tells someone their VALID key looks wrong is worse
    // than no hint — it is a confident claim that sends them to re-copy a key
    // that was already right.
    expect(TRIPO_V3_DIALECT.keyPrefix).toBeUndefined();
  });
});

describe('a control v3 does not have is REFUSED before anything is sent (#1408)', () => {
  const IMAGE = {
    source: 'image',
    image: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
  } as const;

  // These were once DROPPED silently, on the reasoning that v3's field list reaches
  // us through vendor prose, so refusing on it would be a hard failure on a soft
  // reading. But the same reading already decided the field is not sent; refusing
  // changes only whether the caller is told. Were the prose wrong, the fix is to
  // forward the field — the same under either behaviour.
  it.each([
    ['style on a text request', { ...TEXT, style: 'person:person2cartoon' }, /style/],
    ['style on an image request', { ...IMAGE, style: 'person:person2cartoon' }, /style/],
    ['pose on a text request', { ...TEXT, pose: { headBodyHeightRatio: 2 } }, /pose/],
    [
      'textureAlignment on a text request',
      { ...TEXT, textureAlignment: 'geometry' },
      /textureAlignment/,
    ],
    ['orientation on a text request', { ...TEXT, orientation: 'align_image' }, /orientation/],
  ])('refuses %s, and nothing leaves the process', async (_label, request, field) => {
    const { fetchImpl, sent } = transport(V3_OUTPUT);
    await expect(client(fetchImpl).generate(request as never)).rejects.toThrow(field);
    expect(sent).toEqual([]);
  });

  it('forwards textureAlignment and orientation where v3 has them: image requests', async () => {
    const { fetchImpl, sent } = transport(V3_OUTPUT);
    await client(fetchImpl).generate({
      ...IMAGE,
      textureAlignment: 'geometry',
      orientation: 'align_image',
    });
    expect(sent[1].url).toBe('http://tripo.test/generation/image-to-model');
    expect(sent[1].body).toMatchObject({
      texture_alignment: 'geometry',
      orientation: 'align_image',
    });
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

  it('🔑 the rename is REAL: a v2-shaped output reads as NO url, not as a model', () => {
    // The concrete regression #797 named. It does not depend on the vendor
    // documentation being right — a reader that accepted the legacy field would
    // make a malformed response look like a model. Parsed from text, as wire data
    // is: the legacy field is not in the output type any more (#1403).
    const v2Shaped = JSON.parse('{"pbr_model":"http://cdn.test/v2.glb"}');
    const v3Shaped = { model_url: 'http://cdn.test/v3.glb' };

    expect(TRIPO_V3_DIALECT.modelUrlOf(v2Shaped)).toBeUndefined();
    expect(TRIPO_V3_DIALECT.modelUrlOf(v3Shaped)).toBe('http://cdn.test/v3.glb');
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
      // Required in practice, and the OLDER version on purpose — it is the only
      // one that honours `spec: mixamo`. See the rig-model describe block.
      model: TRIPO_V3_DEFAULT_RIG_MODEL,
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

  it('posts to /files and passes the token back as a PLAIN STRING `input`', async () => {
    const { fetchImpl, sent } = transport(V3_OUTPUT);
    await client(fetchImpl).generate(IMAGE);

    expect(sent[0].url).toBe('http://tripo.test/files');
    expect(sent[1].url).toBe('http://tripo.test/generation/image-to-model');
    // v3 unified `file`/`file_token`/`url`/`object` under one `input` and infers
    // the type. v2's `{type, file_token}` wrapper is not a v3 shape.
    expect(sent[1].body).toMatchObject({ input: 'ftok' });
    expect(sent[1].body).not.toHaveProperty('file');
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

describe('the auto-rigging model is sent, and the default is the OLDER one on purpose', () => {
  const args = { sourceTaskId: 'm', rigType: 'biped', spec: 'mixamo' } as const;

  it('always sends a model, because the service’s own default is not valid', () => {
    // Measured: omitting it returns 400 code 1004 "invalid model
    // 'v2.5-20250123'" — a version the request never mentioned.
    expect(TRIPO_V3_DIALECT.rigCall(args).body).toMatchObject({
      model: TRIPO_V3_DEFAULT_RIG_MODEL,
    });
  });

  it('🔑 defaults to the version that HONOURS spec: mixamo, not the newer one', () => {
    // Measured on the live service, same mesh, one field changed:
    //   v2.5-20260210 → tripo::Root, tripo::0_Left_Limb_0 …   spec ignored
    //   v1.0-20240301 → mixamorig:Hips, mixamorig:Spine …     spec honoured
    // Both echoed `spec: "mixamo"` back. Newer-is-better picks the broken one.
    expect(TRIPO_V3_DEFAULT_RIG_MODEL).toBe('v1.0-20240301');
    expect(TRIPO_V3_DEFAULT_RIG_MODEL).not.toBe(TRIPO_V3_RIG_MODEL_IGNORING_SPEC);
  });

  it('a caller’s explicit choice still wins', () => {
    expect(
      TRIPO_V3_DIALECT.rigCall({ ...args, modelVersion: TRIPO_V3_RIG_MODEL_IGNORING_SPEC }).body,
    ).toMatchObject({ model: TRIPO_V3_RIG_MODEL_IGNORING_SPEC });
  });
});

describe('a multiview hole is REFUSED on v3, not guessed', () => {
  const four = [1, 2, 3, 4].map((n) => ({ type: 'png', file_token: `t${n}` }));
  const multiview = {
    source: 'multiview',
    views: { front: { bytes: new Uint8Array([1]), mimeType: 'image/png' } },
  } as const;

  it('sends four positional plain-string tokens when all four are supplied', () => {
    expect(TRIPO_V3_DIALECT.modelCall(multiview, { views: four }).body).toMatchObject({
      inputs: ['t1', 't2', 't3', 't4'],
    });
  });

  it('throws rather than shifting the remaining views onto the wrong faces', () => {
    // The array is POSITIONAL and no reachable document says how v3 writes an
    // omitted slot. A wrong guess does not error — it returns a confidently
    // wrong model, with the left image treated as the back.
    const withHole = [four[0], null, four[2], four[3]];
    expect(() => TRIPO_V3_DIALECT.modelCall(multiview, { views: withHole })).toThrow(
      /needs all four views/,
    );
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
