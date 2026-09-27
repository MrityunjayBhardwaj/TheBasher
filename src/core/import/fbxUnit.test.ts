// #1086 — an FBX is read in the unit it declares.
//
// FBX's base unit is the centimetre: `UnitScaleFactor` is centimetres per file unit, and a file
// that omits it means 1. Blender reads it so and scales by `UnitScaleFactor / 100` for a metre
// scene (`io_scene_fbx/import_fbx.py:3132-3135`). Three's FBXLoader records it and does not
// apply it, so before this a Mixamo file parsed with its hips 99.67 units up.
//
// The committed `rig.fbx` is ASCII and declares 1 on one line, so the metre-declared variant is
// the same file with that line changed — built here, never committed as a second fixture that
// could drift from the first.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { fbxMetresPerUnit, parseFbx } from './fbx';
import { retargetClip } from './retarget';

const RIG_TEXT = readFileSync(resolve(process.cwd(), 'public/fixtures/anim/rig.fbx'), 'utf8');
const UNIT_LINE = 'P: "UnitScaleFactor", "double", "Number", "",1';

/** `rig.fbx` declaring `factor` centimetres per unit — or nothing at all when `null`. */
function rigDeclaring(factor: number | null): ArrayBuffer {
  if (!RIG_TEXT.includes(UNIT_LINE))
    throw new Error('rig.fbx no longer states its unit on the expected line');
  const text =
    factor === null
      ? RIG_TEXT.replace(`\t\t${UNIT_LINE}\n`, '')
      : RIG_TEXT.replace(UNIT_LINE, `P: "UnitScaleFactor", "double", "Number", "",${factor}`);
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** What the file says, before any unit is applied — the loader's own numbers. */
function rawHipsY(buf: ArrayBuffer): number {
  let y = NaN;
  new FBXLoader().parse(buf, '').traverse((o) => {
    if ((o as { isBone?: boolean }).isBone && o.name === 'Hips') y = o.position.y;
  });
  return y;
}

describe('fbxMetresPerUnit — the declared factor, in metres', () => {
  it('centimetres (1), the FBX default, is 0.01 m per unit', () => {
    expect(fbxMetresPerUnit({ userData: { unitScaleFactor: 1 } })).toBe(0.01);
  });
  it('a file that declares nothing means centimetres, as the reference reads it', () => {
    expect(fbxMetresPerUnit({ userData: {} })).toBe(0.01);
    expect(fbxMetresPerUnit({})).toBe(0.01);
  });
  it('metres (100) is 1, inches (2.54) is 0.0254', () => {
    expect(fbxMetresPerUnit({ userData: { unitScaleFactor: 100 } })).toBe(1);
    expect(fbxMetresPerUnit({ userData: { unitScaleFactor: 2.54 } })).toBeCloseTo(0.0254, 12);
  });
  it('a declared factor that is not a positive number is refused, not guessed over', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1'] as unknown[]) {
      expect(() => fbxMetresPerUnit({ userData: { unitScaleFactor: bad } })).toThrow(
        /UnitScaleFactor/,
      );
    }
  });
});

describe('parseFbx — lengths come out in metres, in the declared unit', () => {
  it('a centimetre file: rest offsets and keyed positions are 1/100 of the file', () => {
    const buf = rigDeclaring(1);
    expect(rawHipsY(buf), 'the file itself puts Hips at 1').toBeCloseTo(1, 9);
    const parsed = parseFbx(buf, 'rig');
    const hips = parsed.skeletonParams.bones.find((b) => b.name === 'Hips')!;
    expect(hips.position[1]).toBeCloseTo(0.01, 9);
    const metres = parseFbx(rigDeclaring(100), 'rig');
    const keys = parsed.clipParams.keyframes;
    expect(keys.length).toBeGreaterThan(0);
    keys.forEach((k, i) => {
      const m = metres.clipParams.keyframes[i];
      for (let a = 0; a < 3; a++) expect(k.position[a]).toBeCloseTo(m.position[a] * 0.01, 9);
    });
  });

  it('a metre file stands at its own numbers', () => {
    const hips = parseFbx(rigDeclaring(100), 'rig').skeletonParams.bones.find(
      (b) => b.name === 'Hips',
    )!;
    expect(hips.position[1]).toBeCloseTo(1, 9);
  });

  it('a file that omits the unit is read as centimetres', () => {
    // The variant really states nothing — otherwise this row could not tell "absent" from 1.
    const group = new FBXLoader().parse(rigDeclaring(null), '') as {
      userData: Record<string, unknown>;
    };
    expect(group.userData.unitScaleFactor).toBeUndefined();
    const hips = parseFbx(rigDeclaring(null), 'rig').skeletonParams.bones.find(
      (b) => b.name === 'Hips',
    )!;
    expect(hips.position[1]).toBeCloseTo(0.01, 9);
  });

  it('only LENGTHS move: rotations and bind scale are the same whatever the unit says', () => {
    const cm = parseFbx(rigDeclaring(1), 'rig');
    const m = parseFbx(rigDeclaring(100), 'rig');
    cm.skeletonParams.bones.forEach((b, i) => {
      expect(b.rotation).toEqual(m.skeletonParams.bones[i].rotation);
      expect(b.scale).toEqual(m.skeletonParams.bones[i].scale);
    });
    cm.clipParams.keyframes.forEach((k, i) => {
      expect(k.rotation).toEqual(m.clipParams.keyframes[i].rotation);
    });
  });

  it('a file whose declared unit is unusable fails the import, with the reason', () => {
    expect(() => parseFbx(rigDeclaring(0), 'rig')).toThrow(/UnitScaleFactor 0/);
  });
});

// The unit reaches the bind road too, and must not change what a character does: the retarget
// carries hip travel across by the ratio of the two rigs' leg lengths, so a source read 100×
// smaller moves its target exactly as much. A unit that leaked into rotations, or scaled rest
// offsets without the keys (or the reverse), would break this.
describe('the unit is invisible to a bound character', () => {
  it('the same file read in centimetres or in metres retargets to the same motion', () => {
    const cm = parseFbx(rigDeclaring(1), 'rig');
    const m = parseFbx(rigDeclaring(100), 'rig');
    const target = m.skeletonParams.bones;
    const nameMap = Object.fromEntries(target.map((b) => [b.name, b.name]));
    const run = (src: typeof cm) =>
      retargetClip({
        sourceBones: src.skeletonParams.bones,
        sourceClip: src.clipParams,
        targetBones: target,
        nameMap,
      }).clipParams.keyframes;
    const a = run(cm);
    const b = run(m);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBe(b.length);
    a.forEach((k, i) => {
      for (let j = 0; j < 3; j++) {
        expect(k.position[j]).toBeCloseTo(b[i].position[j], 6);
        expect(k.rotation[j]).toBeCloseTo(b[i].rotation[j], 6);
      }
    });
  });
});
