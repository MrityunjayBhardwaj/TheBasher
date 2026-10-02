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
import { alignedQuat, poseSamples } from '../../test-utils/poseSamples';

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
    const keys = poseSamples(parsed.clipParams.poses);
    const inMetres = poseSamples(metres.clipParams.poses);
    expect(keys.length).toBeGreaterThan(0);
    keys.forEach((k, i) => {
      const m = inMetres[i];
      for (let a = 0; a < 3; a++) expect(k.position![a]).toBeCloseTo(m.position![a] * 0.01, 9);
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
    const inMetres = poseSamples(m.clipParams.poses);
    poseSamples(cm.clipParams.poses).forEach((k, i) => {
      expect(k.quaternion).toEqual(inMetres[i].quaternion);
    });
  });

  it('a file whose declared unit is unusable fails the import, with the reason', () => {
    expect(() => parseFbx(rigDeclaring(0), 'rig')).toThrow(/UnitScaleFactor 0/);
  });
});

// #1296 — when every model sits under one group, FBXLoader returns THAT group as the scene
// (FBXLoader.js:907-913, r169), and it had recorded the file's unit on the scene it then threw away.
// Blender's default export of an armature is such a file. `walk-blender-default.fbx` declares 1,
// the default, so the loss could not show on it; the variant below declares 100 — one double
// changed in the binary, built here like `rigDeclaring`. Blender 5.1.1 imports the variant with
// the Hips at z 9781.89 at frame 1, exactly 100× its 97.82 for the file as exported (probe
// `unit_oracle.py`, import defaults, 2026-09-29).
const WALK_BYTES = readFileSync(
  resolve(process.cwd(), 'src/core/import/__fixtures__/walk-blender-default.fbx'),
);

/** The walk declaring `factor` centimetres per unit, in the binary's one `UnitScaleFactor` record. */
function walkDeclaring(factor: number): ArrayBuffer {
  const bytes = new Uint8Array(WALK_BYTES);
  const name = 'UnitScaleFactor';
  const record = new Uint8Array([0x53, name.length, 0, 0, 0, ...new TextEncoder().encode(name)]);
  const at = bytes.findIndex((_, i) => record.every((b, j) => bytes[i + j] === b));
  if (at < 0) throw new Error('the walk no longer states its unit where expected');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = at + record.length;
  // Three strings follow the name ("double", "Number", ""), then the value: 'D' + float64 LE.
  for (let s = 0; s < 3; s++) i += 5 + view.getUint32(i + 1, true);
  if (bytes[i] !== 0x44 || view.getFloat64(i + 1, true) !== 1)
    throw new Error('the walk no longer declares 1 as a double');
  view.setFloat64(i + 1, factor, true);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('a file whose models all sit under one group is read in its unit (#1296)', () => {
  it('the loader collapses the walk to its armature node — the case this row is about', () => {
    const group = new FBXLoader().parse(walkDeclaring(100), '');
    expect(group.name).toBe('walk');
    expect(group.userData.unitScaleFactor).toBe(100);
  });

  it('declaring 100 stands the walk at Blender’s 9781.89, 100× the file as exported', () => {
    const hipsOf = (buf: ArrayBuffer) =>
      parseFbx(buf, 'walk').skeletonParams.bones.find((b) => b.name === 'Hips')!.position;
    const asExported = hipsOf(walkDeclaring(1));
    const metres = hipsOf(walkDeclaring(100));
    expect(asExported[1]).toBeCloseTo(97.819, 3);
    expect(metres[1]).toBeCloseTo(9781.89, 1);
    for (let a = 0; a < 3; a++) expect(metres[a]).toBeCloseTo(asExported[a] * 100, 6);
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
      }).clipParams.poses;
    const a = poseSamples(run(cm));
    const b = poseSamples(run(m));
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBe(b.length);
    a.forEach((k, i) => {
      expect(k.bone).toBe(b[i].bone);
      const q = alignedQuat(k.quaternion!, b[i].quaternion!);
      for (let j = 0; j < 3; j++) expect(k.position![j]).toBeCloseTo(b[i].position![j], 6);
      for (let j = 0; j < 4; j++) expect(q[j]).toBeCloseTo(b[i].quaternion![j], 6);
    });
  });
});
