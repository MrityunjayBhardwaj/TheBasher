// #1190 — the transform on the node ABOVE an FBX rig's root is part of where the rig stands.
//
// Blender writes an armature as a `Null` above the bones and puts its axis and unit conversion
// there: −90° about X and ×100 on a Blender export. Read from the bones down, the rig came in
// 100× small and lying along +Z. The transform is folded into the rig — the root's rest and
// keys, and every length below — so the stand-in Object keeps reading identity, as Blender's
// armature Object does on re-import.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { parseFbx } from './fbx';
import { specToThreeSkeleton } from './threeAdapter';
import type { AnimationKeyframe, BoneSpec } from '../../nodes/types';

const fixture = (name: string) => resolve(process.cwd(), 'public/fixtures/anim', name);
const readBinary = (name: string): ArrayBuffer => {
  const buf = readFileSync(fixture(name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};
const FIXTURE = readFileSync(fixture('rig-two-skins.fbx'), 'utf8');

/**
 * The fixture with Hips also turning — one key per entry, spread over the same second as its X
 * move. Three builds a rotation track only when all three axes have a curve.
 */
function turningHips(
  text: string,
  x: readonly number[],
  y: readonly number[],
  z: readonly number[],
): string {
  const anchor = '\tAnimationCurve: 1300';
  const layerLink = '\tC: "OO",1200,1100\n';
  if (!text.includes(anchor) || !text.includes(layerLink))
    throw new Error('fixture no longer animates Hips where this expects it');
  const n = y.length;
  const second = 46186158000;
  const times = y.map((_, i) => Math.round((i / (n - 1)) * second));
  const curve = (
    id: number,
    values: readonly number[],
  ) => `\tAnimationCurve: ${id}, "AnimCurve::", "" {
\t\tDefault: 0
\t\tKeyVer: 4009
\t\tKeyTime: *${n} {
\t\t\ta: ${times.join(',')}
\t\t}
\t\tKeyValueFloat: *${n} {
\t\t\ta: ${values.join(',')}
\t\t}
\t}
`;
  const blocks =
    `\tAnimationCurveNode: 1210, "AnimCurveNode::R", "" {
\t\tProperties70:  {
\t\t\tP: "d|X", "Number", "", "A",0
\t\t\tP: "d|Y", "Number", "", "A",0
\t\t\tP: "d|Z", "Number", "", "A",0
\t\t}
\t}
` +
    curve(1310, x) +
    curve(1311, y) +
    curve(1312, z);
  return text
    .replace(anchor, blocks + anchor)
    .replace(
      layerLink,
      layerLink +
        '\tC: "OO",1210,1100\n\tC: "OP",1210,100, "Lcl Rotation"\n\tC: "OP",1310,1210, "d|X"\n\tC: "OP",1311,1210, "d|Y"\n\tC: "OP",1312,1210, "d|Z"\n',
    );
}

/** Hips turning about Y through 0 → 170°, past 90° where an XYZ Euler changes branch. */
const FLAT = [0, 0, 0, 0, 0];
const TWO_SKINS = turningHips(FIXTURE, FLAT, [0, 50, 100, 150, 170], FLAT);

/** Hips turning on all three axes at 24 scattered angles, Y through several whole turns. */
const SCATTER = Array.from({ length: 24 }, (_, i) => i);
const SCATTERED = turningHips(
  FIXTURE,
  SCATTER.map((i) => ((i * 37) % 80) - 40 + 0.37),
  SCATTER.map((i) => i * 47 + 0.61),
  SCATTER.map((i) => ((i * 29) % 70) - 35 + 0.13),
);

/** World positions of every bone, posed by the keys at `time` (rest where a bone has none). */
function worldAt(
  bones: readonly BoneSpec[],
  keys: readonly AnimationKeyframe[],
  time: number,
): Vector3[] {
  const rig = specToThreeSkeleton(bones).bones;
  for (const k of keys) {
    if (k.time !== time) continue;
    rig[k.bone].position.set(...k.position);
    rig[k.bone].quaternion.setFromEuler(new Euler(...k.rotation, 'XYZ'));
  }
  rig[0].updateMatrixWorld(true);
  return rig.map((b) => new Vector3().setFromMatrixPosition(b.matrixWorld));
}

/** `rig-two-skins.fbx` with a Null above Hips carrying translation, rotation and scale. */
function underANull(t: string, r: string, s: string, base = TWO_SKINS): ArrayBuffer {
  const hipsLink = '\tC: "OO",100,0\n';
  if (!base.includes(hipsLink) || !base.includes('\tGeometry: 3000'))
    throw new Error('fixture no longer has the shape this builds on');
  const armature = `\tModel: 900, "Model::Armature", "Null" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",${t}
\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",${r}
\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",${s}
\t\t}
\t}
`;
  const text = base
    .replace('\tGeometry: 3000', armature + '\tGeometry: 3000')
    .replace(hipsLink, '\tC: "OO",900,0\n\tC: "OO",100,900\n');
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('#1190 — a Blender export stands where Blender stands it', () => {
  // `null-in-chain.fbx`: Hips → Mid → Tip exported by Blender, under the armature node `Rig`
  // (−90° X, ×100). Blender 5.1.1 re-imports it with the armature Object at location 0,
  // rotation 0, scale 1 and the heads at (0,0,0), (0,0,1), (0,0,1.5) in its Z-up — here, Y-up.
  it('upright, at 1 m and 1.5 m', () => {
    const bones = parseFbx(readBinary('null-in-chain.fbx'), 'rig').skeletonParams.bones;
    const heads = worldAt(bones, [], 0);
    const expected = [
      [0, 0, 0],
      [0, 1, 0],
      [0, 1.5, 0],
    ];
    expect(bones.map((b) => b.name)).toEqual(['Hips', 'Mid', 'Tip']);
    heads.forEach((h, i) => {
      for (let a = 0; a < 3; a++) expect(h.getComponent(a)).toBeCloseTo(expected[i][a], 9);
    });
  });
});

describe('#1190 — folding the node above the root keeps every pose', () => {
  const plain = parseFbx(new TextEncoder().encode(TWO_SKINS).buffer as ArrayBuffer, 'rig');

  it("every bone at every key stands where the node's transform puts the plain rig", () => {
    // 3 file units along X, then −90° X, ×100 — and the fixture's own keyed Hips curve.
    const folded = parseFbx(underANull('3,0,0', '-90,0,0', '100,100,100'), 'rig');
    expect(folded.clipParams.keyframes.length).toBe(plain.clipParams.keyframes.length);
    const times = [...new Set(plain.clipParams.keyframes.map((k) => k.time))];
    expect(times.length, 'the clip has more than one pose to compare').toBeGreaterThan(1);

    const turn = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0));
    const offset = new Vector3(0.03, 0, 0); // 3 file units, in metres
    for (const time of times) {
      const want = worldAt(plain.skeletonParams.bones, plain.clipParams.keyframes, time).map((p) =>
        p.multiplyScalar(100).applyQuaternion(turn).add(offset),
      );
      const got = worldAt(folded.skeletonParams.bones, folded.clipParams.keyframes, time);
      got.forEach((g, i) =>
        expect(g.distanceTo(want[i]), `bone ${i} at ${time}s`).toBeLessThan(1e-9),
      );
    }
    const moved = worldAt(folded.skeletonParams.bones, [], 0)[1].distanceTo(
      worldAt(plain.skeletonParams.bones, [], 0)[1],
    );
    expect(moved, 'the fold actually moved the rig off the plain one').toBeGreaterThan(0.5);
  });

  it("the root's keys stay on one Euler branch, so playback never turns the long way round", () => {
    // The sampler interpolates Euler components linearly, so two neighbouring keys written on
    // different branches spin the bone the long way (#867). The fold writes new angles for the
    // root and must keep them continuous.
    const steps = (r: ReturnType<typeof parseFbx>) => {
      const root = r.clipParams.keyframes
        .filter((k) => k.bone === 0)
        .sort((a, b) => a.time - b.time);
      expect(root.length, 'the root carries the turning keys').toBeGreaterThanOrEqual(5);
      let worst = 0;
      for (let i = 1; i < root.length; i++)
        for (let a = 0; a < 3; a++)
          worst = Math.max(worst, Math.abs(root[i].rotation[a] - root[i - 1].rotation[a]));
      return worst;
    };
    // Control: without a node above, the import road already keeps the keys continuous.
    expect(steps(plain), 'the unfolded keys are continuous').toBeLessThan(Math.PI / 2);
    expect(steps(parseFbx(underANull('0,0,0', '-90,0,0', '100,100,100'), 'rig'))).toBeLessThan(
      Math.PI / 2,
    );
  });

  it('refuses a non-uniform scale rather than distorting the bones', () => {
    expect(() => parseFbx(underANull('0,0,0', '0,0,0', '100,50,100'), 'rig')).toThrow(
      /not one uniform scale/,
    );
  });

  it('leaves a rig under an identity node exactly as it was', () => {
    // Identity in, identical out: the fold runs, and changes nothing a rig or its keys hold.
    const scattered = parseFbx(new TextEncoder().encode(SCATTERED).buffer as ArrayBuffer, 'rig');
    expect(scattered.clipParams.keyframes.filter((k) => k.bone === 0).length).toBe(24);
    expect(parseFbx(underANull('0,0,0', '0,0,0', '1,1,1', SCATTERED), 'rig')).toEqual(scattered);
  });
});
