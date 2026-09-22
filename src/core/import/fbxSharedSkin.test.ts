// #1181 — an FBX whose skeleton is shared by two skins reads its rest from the scene's bones.
//
// Mixamo exports two skinned meshes over one skeleton. Three's FBXLoader builds one Bone per
// skin and nests each earlier twin under the later one, so the first skin's `skeleton.bones`
// holds inner twins at [0, 0, 0], each under a parent of its own name. Read as they were, every
// rest offset was zero and every bone was its own parent.
//
// `rig-two-skins.fbx` is `rig.fbx` (Hips at 1, Spine 0.5 above it, one keyed curve) with two
// one-triangle meshes, each skinned to both bones: the smallest file with Mixamo's shape. It
// declares centimetres, so the file's 1 reads as 0.01 m.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { Matrix4, Vector3, type SkinnedMesh } from 'three';
import { parseFbx } from './fbx';
import { retargetClip } from './retarget';

const read = (name: string): ArrayBuffer => {
  const buf = readFileSync(resolve(process.cwd(), 'public/fixtures/anim', name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};
const TWO_SKINS = read('rig-two-skins.fbx');
const ONE_SKELETON = read('rig.fbx');

/**
 * The same file with Hips' Y translation keyed too (at its resting 1), so no axis of the
 * clip falls back to a default. A shared skin loses an UNKEYED axis's value inside three's
 * loader (#1182) — a different defect, which the rows that compare motion must not measure.
 */
function keyingEveryMovedAxis(buf: ArrayBuffer): ArrayBuffer {
  const text = new TextDecoder().decode(buf);
  const curve = `\tAnimationCurve: 1301, "AnimCurve::", "" {
\t\tDefault: 1
\t\tKeyVer: 4009
\t\tKeyTime: *2 {
\t\t\ta: 0,46186158000
\t\t}
\t\tKeyValueFloat: *2 {
\t\t\ta: 1,1
\t\t}
\t}
`;
  const link = '\tC: "OP",1300,1200, "d|X"\n';
  if (!text.includes('\tAnimationCurve: 1300') || !text.includes(link))
    throw new Error('fixture no longer keys Hips X where this expects it');
  const out = text
    .replace('\tAnimationCurve: 1300', curve + '\tAnimationCurve: 1300')
    .replace(link, link + '\tC: "OP",1301,1200, "d|Y"\n');
  return new TextEncoder().encode(out).buffer as ArrayBuffer;
}

function firstSkin(buf: ArrayBuffer): SkinnedMesh {
  let found: SkinnedMesh | null = null;
  new FBXLoader().parse(buf, '').traverse((o) => {
    if (!found && (o as SkinnedMesh).isSkinnedMesh) found = o as SkinnedMesh;
  });
  if (!found) throw new Error('fixture has no skinned mesh');
  return found;
}

describe('the fixture has the shape that broke', () => {
  it("the first skin's bones are inner twins, at the origin under a parent of their own name", () => {
    const bones = firstSkin(TWO_SKINS).skeleton.bones;
    expect(bones.map((b) => b.name)).toEqual(['Hips', 'Spine']);
    for (const b of bones) {
      expect(b.parent?.name).toBe(b.name);
      expect(b.position.toArray()).toEqual([0, 0, 0]);
    }
  });
});

describe('parseFbx — a shared skeleton parses as the one skeleton it is', () => {
  const bones = parseFbx(TWO_SKINS, 'rig').skeletonParams.bones;

  it('one root, each bone under its real parent, none under itself', () => {
    expect(bones.map((b) => [b.name, b.parent])).toEqual([
      ['Hips', -1],
      ['Spine', 0],
    ]);
  });

  it("rest offsets are the file's, in metres", () => {
    expect(bones[0].position[1]).toBeCloseTo(0.01, 9);
    expect(bones[1].position[1]).toBeCloseTo(0.005, 9);
  });

  it("the rest equals the reference's: each cluster's bind matrix, local to its parent's", () => {
    // Blender builds the rest from the cluster's TransformLink (`import_fbx.py:3480-3491`),
    // made local to the parent's (`:2562-2573`). The loader's bone inverses are those
    // TransformLinks inverted, so the bind-local offset is inv(parentBind) · bind. The parent
    // comes from the FILE (Spine under Hips), never from the parse under test — a parse that
    // made each bone its own parent would otherwise compare every bone with itself and pass.
    const FILE_PARENTS = [-1, 0];
    const skin = firstSkin(TWO_SKINS).skeleton;
    const bind = skin.boneInverses.map((inv) => new Matrix4().copy(inv).invert());
    const expected = FILE_PARENTS.map((parent, i) => {
      const parentBind = parent < 0 ? new Matrix4() : bind[parent].clone();
      return new Vector3()
        .setFromMatrixPosition(parentBind.invert().multiply(bind[i]))
        .multiplyScalar(0.01);
    });
    expect(expected[1].y, 'the bind rest has extent to compare against').toBeCloseTo(0.005, 9);
    bones.forEach((b, i) => {
      for (let a = 0; a < 3; a++) expect(b.position[a]).toBeCloseTo(expected[i].getComponent(a), 9);
    });
  });

  it('is the same skeleton the file reads as without the skins', () => {
    expect(bones).toEqual(parseFbx(ONE_SKELETON, 'rig').skeletonParams.bones);
  });

  it("a keyed bone's clip is the same as without the skins, when every moved axis is keyed", () => {
    const shared = parseFbx(keyingEveryMovedAxis(TWO_SKINS), 'rig').clipParams.keyframes;
    const plain = parseFbx(keyingEveryMovedAxis(ONE_SKELETON), 'rig').clipParams.keyframes;
    expect(shared.length).toBeGreaterThan(0);
    expect(shared).toEqual(plain);
  });

  // #1182 — reds (passes) once an unkeyed axis keeps its value on a shared skin.
  it.fails("#1182: an axis the curve leaves unkeyed keeps the bone's value", () => {
    expect(parseFbx(TWO_SKINS, 'rig').clipParams.keyframes).toEqual(
      parseFbx(ONE_SKELETON, 'rig').clipParams.keyframes,
    );
  });
});

describe('a bound character moves the same as from the same skeleton without the skins', () => {
  it('retargets to the same keyframes', () => {
    const target = parseFbx(ONE_SKELETON, 'rig').skeletonParams.bones;
    const nameMap = Object.fromEntries(target.map((b) => [b.name, b.name]));
    const run = (buf: ArrayBuffer) => {
      const src = parseFbx(keyingEveryMovedAxis(buf), 'rig');
      return retargetClip({
        sourceBones: src.skeletonParams.bones,
        sourceClip: src.clipParams,
        targetBones: target,
        nameMap,
      }).clipParams.keyframes;
    };
    const a = run(TWO_SKINS);
    const b = run(ONE_SKELETON);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBe(b.length);
    a.forEach((k, i) => {
      for (let j = 0; j < 3; j++) {
        expect(k.position[j]).toBeCloseTo(b[i].position[j], 9);
        expect(k.rotation[j]).toBeCloseTo(b[i].rotation[j], 9);
      }
    });
  });
});
