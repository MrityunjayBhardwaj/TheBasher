// IBM round-trip fidelity test — Phase 7.11 Wave E (issue #100), the D-04 gate.
//
// Converts "the captured inverse-bind matrices SHOULD match" into an OBSERVED
// equality against three.js ground truth. We load the SAME committed fixture
// through the REAL `GLTFLoader` (the loader the app uses — drei's `useGLTF`
// drives this exact class) and read what three.js actually produced for the
// skin: `SkinnedMesh.skeleton.boneInverses[i]` — the `Matrix4[]` three computed
// at parse time. We then run our own `buildSkinMetadata` over the same parsed
// json+buffers and assert, joint-by-joint (matched by bone NAME, in
// `skin.joints[]` order) and element-by-element (16 each, column-major), that
//   captured `inverseBindMatrices[i]`  ==  three's `boneInverses[k].elements`.
//
// Why element-by-element (not Matrix4.equals): a transposed (row-major) capture
// would pass a structure-blind matrix compare on a symmetric matrix but fail
// element-by-element on the off-diagonal / translation row. The fixtures carry a
// non-identity translation (skinned-bar joint 1 → −1 Y; RESEARCH §B2) so a
// transpose is caught loudly. A falsification test (deliberate transpose →
// FAIL) pins this.
//
// three.js skin pipeline (the ground truth this test validates):
//   - `GLTFLoader.loadSkin` reads `skin.inverseBindMatrices` (a MAT4 accessor)
//     and slices `mat.fromArray(array, i*16)` per JOINT-LIST position `i`, then
//     builds `new Skeleton(bones, boneInverses)` with the two arrays parallel in
//     `skin.joints[]` order. (three.js 0.169 GLTFLoader.js:3930-3993, IBM at
//     3975, `new Skeleton` at 3989.)
//   - `Skeleton.calculateInverses` defines IBM = `bone.matrixWorld.invert()`,
//     but when authored IBMs are present the loader uses them verbatim — so this
//     equality validates our capture against the AUTHORED matrices three loaded,
//     not a reconstruction. (three.js Skeleton.js:64-78.)
//
// REF: PLAN.md Wave E (E1); RESEARCH.md §B1 (three.js skin parsing, file:line);
// CONTEXT D-04; H40 (boundary-pair — observe BOTH the producer side, our
// capture, AND the consumer side, three's boneInverses); H45 (render-side skin).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three-stdlib';
import { SkinnedMesh, type Skeleton } from 'three';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { parseGltfContainer, resolveBuffers, type GltfJson } from './glb';

/** Loads a committed fixture as an ArrayBuffer (vitest runs from repo root). */
function fixtureBuffer(name: string): ArrayBuffer {
  const node = readFileSync(resolve(process.cwd(), `public/assets/${name}`));
  return node.buffer.slice(node.byteOffset, node.byteOffset + node.byteLength) as ArrayBuffer;
}

/** Parse a fixture through the REAL GLTFLoader (the app's loader path) and
 *  return the SkinnedMesh's skeleton — three.js's ground-truth skin. */
async function loadSkeletonViaGltfLoader(name: string): Promise<Skeleton> {
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: { traverse: (cb: (o: unknown) => void) => void } }>(
    (res, rej) => loader.parse(fixtureBuffer(name), '', res as never, rej),
  );
  let mesh: SkinnedMesh | undefined;
  gltf.scene.traverse((o: unknown) => {
    if (o instanceof SkinnedMesh) mesh = o;
  });
  if (!mesh) throw new Error(`no SkinnedMesh found in ${name}`);
  return mesh.skeleton;
}

/** Our independent capture over the same parsed json+buffers. */
async function captureSkin(name: string) {
  const { json, bin } = parseGltfContainer(fixtureBuffer(name));
  const buffers = await resolveBuffers(json, bin);
  const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(
    json as GltfJson,
    `assets/${name}`,
  );
  const [skin] = buildSkinMetadata(json as GltfJson, buffers, keyByGltfNodeIndex, childHierarchy);
  return skin;
}

const FIXTURES = ['skinned-bar.glb', 'many-bone-rig.glb'] as const;
const TOL = 1e-5;

describe('IBM round-trip: captured == GLTFLoader.boneInverses (P7.11 E1, D-04)', () => {
  for (const name of FIXTURES) {
    it(`${name}: captured IBM equals three's boneInverses, column-major, index-correct`, async () => {
      const skeleton = await loadSkeletonViaGltfLoader(name);
      const skin = await captureSkin(name);

      // three.js builds bones[] and boneInverses[] as parallel arrays in
      // skin.joints[] order; our jointKeys[] is also in skin.joints[] order.
      // Match by bone NAME (not raw index) so a name-mapping bug cannot
      // silently false-pass, then assert element-by-element.
      const renderNames = skeleton.bones.map((b) => b.name);
      expect(skin.inverseBindMatrices).toHaveLength(skin.jointKeys.length);
      // Sanity: every captured joint has a corresponding rendered bone.
      expect(skeleton.boneInverses).toHaveLength(skin.jointKeys.length);

      for (let i = 0; i < skin.jointKeys.length; i++) {
        const jointName = skin.jointKeys[i];
        const k = renderNames.indexOf(jointName);
        expect(
          k,
          `captured joint "${jointName}" (pos ${i}) has no rendered bone of that name`,
        ).toBeGreaterThanOrEqual(0);

        const captured = skin.inverseBindMatrices[i]; // number[16], column-major
        const threes = Array.from(skeleton.boneInverses[k].elements); // Matrix4, column-major
        expect(captured, `IBM length mismatch for "${jointName}"`).toHaveLength(16);
        for (let e = 0; e < 16; e++) {
          expect(
            captured[e],
            `IBM element ${e} mismatch for joint "${jointName}" (captured pos ${i}, render pos ${k})`,
          ).toBeCloseTo(threes[e], 5);
        }
      }
    });
  }

  it('H40 index discipline: render bones[i].name == captured jointKeys[i] (joints order)', async () => {
    // Both producer (capture) and consumer (render) order their joints by
    // skin.joints[] — so the index-by-index name equality holds directly, which
    // is what makes boneInverses[i] correspond to inverseBindMatrices[i]
    // without a name re-lookup. Asserting it here pins the order agreement
    // (the H40 boundary-pair on the IBM datum).
    for (const name of FIXTURES) {
      const skeleton = await loadSkeletonViaGltfLoader(name);
      const skin = await captureSkin(name);
      expect(skeleton.bones.map((b) => b.name)).toEqual(skin.jointKeys);
    }
  });

  it('FALSIFICATION: a transposed captured IBM FAILS the equality (no transpose hides)', async () => {
    const name = 'skinned-bar.glb';
    const skeleton = await loadSkeletonViaGltfLoader(name);
    const skin = await captureSkin(name);

    // Transpose joint 1's captured IBM (column-major <-> row-major swap). The
    // fixture's joint-1 IBM has a non-identity translation row, so the transpose
    // moves the −1 off the translation column → element-by-element mismatch.
    const transpose16 = (m: number[]): number[] => {
      const t = new Array<number>(16);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) t[c * 4 + r] = m[r * 4 + c];
      return t;
    };
    const renderNames = skeleton.bones.map((b) => b.name);
    const i = 1;
    const k = renderNames.indexOf(skin.jointKeys[i]);
    const bad = transpose16(skin.inverseBindMatrices[i]);
    const threes = Array.from(skeleton.boneInverses[k].elements);

    let anyMismatch = false;
    for (let e = 0; e < 16; e++) {
      if (Math.abs(bad[e] - threes[e]) > TOL) anyMismatch = true;
    }
    expect(anyMismatch, 'a transposed IBM must FAIL element-by-element').toBe(true);
  });
});
