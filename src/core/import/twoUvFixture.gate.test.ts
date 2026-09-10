// The two-UV fixture must actually carry two DIFFERENT UV sets, and its control must not.
//
// 🔴 THIS GATE EXISTS BECAUSE THE ONLY PRE-EXISTING "SECOND UV SET" ASSET DOES NOT HAVE ONE.
// `sheen-quad.gltf` declares `TEXCOORD_1` pointing at accessor 1 — the SAME accessor as
// `TEXCOORD_0` — and its material declares no textures at all. It trips the importer's
// `'secondary UV set (TEXCOORD_1+)'` notice by ATTRIBUTE NAME while carrying nothing a second
// set could be told apart by, so anything asserted against it passes identically with the
// feature absent. A fixture that cannot discriminate is not a fixture; this gate is what stops
// these two from decaying into that.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { detectUnsupportedGltfFeatures } from './gltfImportChain';

const ASSETS = path.resolve(__dirname, '../../../public/assets');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ASSETS, f), 'utf8'));

// 🔴 DECODED FROM THE JSON RATHER THAN LOADED THROUGH `GLTFLoader`, AND THE REASON IS MEASURED:
// the loader HANGS in node on any asset whose material references a texture — it waits on an
// image decode that never resolves headless (observed as a 5 s timeout here, and on
// `albedo-textured-quad.gltf` before that, while texture-free `sheen-quad.gltf` parses fine).
// The texture is load-bearing for this fixture, so the gate reads the accessors itself. What
// the loader would add — that `TEXCOORD_1` surfaces as `uv1` — is a three.js mapping
// (`GLTFLoader.js:2228`), not a property of these files, and belongs to a browser test.
function floatsOf(file: string, accessorIndex: number, comps: number): number[] {
  const json = read(file);
  const a = json.accessors[accessorIndex];
  const bv = json.bufferViews[a.bufferView];
  const uri: string = json.buffers[bv.buffer ?? 0].uri;
  const bin = Buffer.from(uri.slice(uri.indexOf('base64,') + 7), 'base64');
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out: number[] = [];
  for (let i = 0; i < a.count * comps; i++)
    out.push(dv.getFloat32((bv.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * 4, true));
  return out;
}

function uvSetsOf(file: string): { readonly uv0: number[]; readonly uv1: number[] | null } {
  const attrs = read(file).meshes[0].primitives[0].attributes as Record<string, number>;
  return {
    uv0: floatsOf(file, attrs.TEXCOORD_0, 2),
    uv1: attrs.TEXCOORD_1 === undefined ? null : floatsOf(file, attrs.TEXCOORD_1, 2),
  };
}

const positionsOf = (file: string): number[] =>
  floatsOf(file, read(file).meshes[0].primitives[0].attributes.POSITION, 3);

// ── The embedded image, and what it has to be able to show ──────────────────────────────────
const SIDE = 4;
const BORDER = [0, 200, 0] as const; // the outer ring of texels — where set 0's samples land
const CENTRE = [255, 0, 255] as const; // the inner 2x2 — where set 1's land
/** The four points the browser spec samples, in the quad's local space. */
const SAMPLE_POINTS: readonly (readonly [number, number])[] = [
  [-0.35, -0.35],
  [0.35, -0.35],
  [-0.35, 0.35],
  [0.35, 0.35],
];

const embeddedPng = (file: string): Buffer => {
  const uri: string = read(file).images[0].uri;
  expect(uri.startsWith('data:image/png;base64,')).toBe(true);
  return Buffer.from(uri.slice(uri.indexOf('base64,') + 7), 'base64');
};

/** PNG's CRC-32, spelled out rather than imported — this is the check the file must survive. */
function crc32(buf: Buffer): number {
  let c = ~0 >>> 0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** The image as `[row][col] = [r,g,b]`. Assumes 8-bit RGB, filter 0 — both gated above. */
function texelsOf(file: string): number[][][] {
  const png = embeddedPng(file);
  let idat: Buffer | null = null;
  for (let i = 8; i < png.length; ) {
    const len = png.readUInt32BE(i);
    if (png.subarray(i + 4, i + 8).toString('latin1') === 'IDAT')
      idat = png.subarray(i + 8, i + 8 + len);
    i += 12 + len;
  }
  // Read the size out of the header rather than assuming it: a fixture that shrinks back to the
  // 2x2 that could not discriminate must red HERE with its size named, not several lines later
  // on an out-of-bounds read that reports `undefined`.
  expect([png.readUInt32BE(16), png.readUInt32BE(20)], `${file} image size`).toEqual([SIDE, SIDE]);
  const raw = zlib.inflateSync(idat!);
  const stride = 1 + SIDE * 3;
  return Array.from({ length: SIDE }, (_, y) =>
    Array.from({ length: SIDE }, (_, x) => [
      raw[y * stride + 1 + x * 3],
      raw[y * stride + 2 + x * 3],
      raw[y * stride + 3 + x * 3],
    ]),
  );
}

/** A UV set's value at a local point on the quad, by bilinear interpolation of its corners. */
function bilinear(pos: number[], uv: number[], lx: number, ly: number): [number, number] {
  const corner = (sx: number, sy: number): number => {
    const i = [0, 1, 2, 3].find(
      (v) => Math.sign(pos[v * 3]) === sx && Math.sign(pos[v * 3 + 1]) === sy,
    );
    expect(i, `the quad has no corner at (${sx}, ${sy})`).not.toBeUndefined();
    return i!;
  };
  const [s, t] = [lx + 0.5, ly + 0.5];
  const w: [number, number, number][] = [
    [corner(-1, -1), 1 - s, 1 - t],
    [corner(1, -1), s, 1 - t],
    [corner(-1, 1), 1 - s, t],
    [corner(1, 1), s, t],
  ];
  return [
    w.reduce((acc, [i, a, b]) => acc + uv[i * 2] * a * b, 0),
    w.reduce((acc, [i, a, b]) => acc + uv[i * 2 + 1] * a * b, 0),
  ];
}

/** Nearest sampling with REPEAT wrap — the sampler both fixtures declare (9728 / 10497). */
const texelAt = (px: number[][][], [u, v]: [number, number]): number[] =>
  px[((Math.floor(v * SIDE) % SIDE) + SIDE) % SIDE][((Math.floor(u * SIDE) % SIDE) + SIDE) % SIDE];

describe('the two-UV fixture is real', () => {
  it('the subject carries two UV sets and they DIFFER at every vertex', () => {
    const { uv0, uv1 } = uvSetsOf('two-uv-quad.gltf');
    expect(uv1).not.toBeNull();
    expect(uv0).toHaveLength(8);
    expect(uv1).toHaveLength(8);
    // The two sets must also be backed by DIFFERENT accessors — `sheen-quad.gltf` points both
    // names at accessor 1, which is the exact decay this gate exists to catch.
    const attrs = read('two-uv-quad.gltf').meshes[0].primitives[0].attributes;
    expect(attrs.TEXCOORD_1).not.toBe(attrs.TEXCOORD_0);
    // Not merely "not deep-equal" — no vertex may share a value, or a renderer binding the
    // wrong set could still look right at some corner and the fixture would under-report.
    for (let v = 0; v < 4; v++)
      expect([uv0[v * 2], uv0[v * 2 + 1]]).not.toEqual([uv1![v * 2], uv1![v * 2 + 1]]);
  });

  it('the subject binds its base-colour map to TEXCOORD_1, the control to the default', () => {
    const subj = read('two-uv-quad.gltf');
    const ctrl = read('one-uv-quad.gltf');
    expect(subj.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord).toBe(1);
    // Absent, not 0 — glTF's default. A fixture that spells the default explicitly would not
    // exercise the "no texCoord stated" path the importer actually takes for every other asset.
    expect(ctrl.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord).toBeUndefined();
  });

  it('the CONTROL carries exactly one UV set — so a passing assertion means something', () => {
    const { uv0, uv1 } = uvSetsOf('one-uv-quad.gltf');
    expect(uv0).toHaveLength(8);
    expect(uv1).toBeNull();
  });

  // 🔴 THE IMAGE IS DECODED TOO, AND THE THREE ROWS ABOVE ARE WHY IT HAS TO BE. They decode the
  // ACCESSORS, so they were green while the first draft of these fixtures embedded a 2x2 PNG that
  // NO BROWSER WOULD LOAD — an IDAT chunk with a wrong CRC over a truncated deflate stream, plus a
  // clipped IEND. Chrome refused it (`THREE.GLTFLoader: Couldn't load texture data:image/png…`)
  // and mounted the quad with no map at all, so the first browser observation of #997 measured a
  // material that had nothing to sample. Python's imaging library had accepted the same bytes,
  // which is how the generation step produced them without complaint. A gate covers only what it
  // decodes, and the texture is the whole point of this fixture.
  //
  // 🔴 AND WELL-FORMED IS NOT ENOUGH — THE IMAGE MUST BE ABLE TO TELL THE TWO SETS APART. The
  // repaired 2x2 could not: at 2x2 both sets' corners land on the SAME four texels (0.25 and 0.75
  // both floor into the same texel a 0 or 1 does), so a renderer binding the wrong set drew a
  // pixel-identical picture. That is the same decay as `sheen-quad.gltf` one layer in — real
  // accessors, an image that cannot show the difference — so it is gated here rather than trusted.
  it.each(['two-uv-quad.gltf', 'one-uv-quad.gltf'])(
    '%s embeds a PNG a browser will actually decode',
    (file) => {
      const png = embeddedPng(file);
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      // Chunk walk with CRC verification — the check a browser applies and PIL does not.
      const chunks: { type: string; data: Buffer }[] = [];
      for (let i = 8; i < png.length; ) {
        const len = png.readUInt32BE(i);
        const type = png.subarray(i + 4, i + 8).toString('latin1');
        expect(i + 12 + len, `${type} chunk runs past the end of the file`).toBeLessThanOrEqual(
          png.length,
        );
        expect(crc32(png.subarray(i + 4, i + 8 + len)), `${type} CRC`).toBe(
          png.readUInt32BE(i + 8 + len),
        );
        chunks.push({ type, data: png.subarray(i + 8, i + 8 + len) });
        i += 12 + len;
      }
      expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
      const ihdr = chunks[0].data;
      // width, height, bit depth, colour type 2 (RGB) — the shape `texelsOf` below assumes.
      expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9]]).toEqual([4, 4, 8, 2]);
      const raw = zlib.inflateSync(chunks[1].data);
      expect(raw.length).toBe(SIDE * (1 + SIDE * 3));
      // Filter type 0 on every row, which is what makes the unfilter in `texelsOf` a plain slice.
      for (let y = 0; y < SIDE; y++) expect(raw[y * (1 + SIDE * 3)]).toBe(0);
    },
  );

  it('the embedded image tells the two sets apart at the points a renderer samples', () => {
    const px = texelsOf('two-uv-quad.gltf');
    // Symmetric under a V flip on purpose: the row a texture coordinate lands on depends on the
    // renderer's flip convention, and this gate must not have to model it. With the image
    // symmetric, the lookup below is convention-independent and the claim is about the image.
    for (let y = 0; y < SIDE; y++)
      for (let x = 0; x < SIDE; x++) expect(px[y][x]).toEqual(px[SIDE - 1 - y][x]);

    const { uv0, uv1 } = uvSetsOf('two-uv-quad.gltf');
    // Asserted, not asserted-away with a `!`: this row is meaningless without the second set,
    // and the row above already proves it is there. Saying so here keeps the narrowing honest
    // if these rows are ever reordered or one is skipped.
    expect(uv1, 'the subject has no second UV set to compare against').not.toBeNull();
    const pos = positionsOf('two-uv-quad.gltf');
    // ⚠️ SAMPLED IN THE QUAD'S INTERIOR, NOT AT ITS VERTICES, AND THAT IS FORCED. The second set
    // spans [0.25, 0.75] — exactly the boundary of the image's centre band — so a vertex-exact
    // lookup sits on a texel edge and answers by rounding. These are the four points the browser
    // spec samples (`p997-replaced-map-uv-set.spec.ts`), which is what makes the two tiers one
    // argument rather than two.
    for (const [lx, ly] of SAMPLE_POINTS) {
      const a = texelAt(px, bilinear(pos, uv0, lx, ly));
      const b = texelAt(px, bilinear(pos, uv1!, lx, ly));
      expect(a, `set 0 at (${lx}, ${ly}) must be the border colour`).toEqual(BORDER);
      expect(b, `set 1 at (${lx}, ${ly}) must be the centre colour`).toEqual(CENTRE);
    }
  });

  it('the importer flags the subject and stays silent on the control', () => {
    expect(detectUnsupportedGltfFeatures(read('two-uv-quad.gltf'))).toContain(
      'secondary UV set (TEXCOORD_1+)',
    );
    expect(detectUnsupportedGltfFeatures(read('one-uv-quad.gltf'))).not.toContain(
      'secondary UV set (TEXCOORD_1+)',
    );
  });
});
