#!/usr/bin/env node
// Generator for the SOMA generated-motion fixture (phase A1).
//
// A1's capability contract is BVH text, and the text a real generator returns is
// not shaped like the BVH files already in this repo. Three differences, all read
// out of the generator's own source rather than its docs — the docs list NPZ,
// MuJoCo CSV and AMASS NPZ as the output formats and never mention BVH at all:
//
//   1. There is a wrapper joint named `Root` at the origin, ABOVE the skeleton's
//      own root. `kimodo/exports/bvh.py` builds it explicitly and gives Hips a
//      parent that no skeleton definition mentions, so a consumer counting joints
//      against the skeleton is off by one before it starts.
//   2. Leaf joints carry NO End Site block — the exporter strips them. Every BVH
//      fixture in this repo has them, so nothing here has ever exercised a leaf
//      without one.
//   3. Rotation channels are ZYX, not the XYZ our own fixtures use.
//
// Joint names and parentage are the 77 of SOMASkeleton77.bone_order_names_with_parents,
// transcribed from source and count-verified. The exporter names joints straight
// from that list with no namespace prefix, so a generated clip arrives on BARE
// names — which is why the somaToGltf / somaToMixamo presets are keyed on them.
//
// This fixture is not a licence question: it is 77 joint NAMES and synthesised
// rotations. No weights, no generated content, nothing downloaded.
//
// Output: public/fixtures/anim/soma-generated.bvh
// Run:    node scripts/gen-soma-motion-fixture.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

// REF: https://github.com/nv-tlabs/kimodo — kimodo/skeleton/definitions.py,
// class SOMASkeleton77, bone_order_names_with_parents.
const SOMA77 = [
  ['Hips', null],
  ['Spine1', 'Hips'],
  ['Spine2', 'Spine1'],
  ['Chest', 'Spine2'],
  ['Neck1', 'Chest'],
  ['Neck2', 'Neck1'],
  ['Head', 'Neck2'],
  ['HeadEnd', 'Head'],
  ['Jaw', 'Head'],
  ['LeftEye', 'Head'],
  ['RightEye', 'Head'],
  ['LeftShoulder', 'Chest'],
  ['LeftArm', 'LeftShoulder'],
  ['LeftForeArm', 'LeftArm'],
  ['LeftHand', 'LeftForeArm'],
  ['LeftHandThumb1', 'LeftHand'],
  ['LeftHandThumb2', 'LeftHandThumb1'],
  ['LeftHandThumb3', 'LeftHandThumb2'],
  ['LeftHandThumbEnd', 'LeftHandThumb3'],
  ['LeftHandIndex1', 'LeftHand'],
  ['LeftHandIndex2', 'LeftHandIndex1'],
  ['LeftHandIndex3', 'LeftHandIndex2'],
  ['LeftHandIndex4', 'LeftHandIndex3'],
  ['LeftHandIndexEnd', 'LeftHandIndex4'],
  ['LeftHandMiddle1', 'LeftHand'],
  ['LeftHandMiddle2', 'LeftHandMiddle1'],
  ['LeftHandMiddle3', 'LeftHandMiddle2'],
  ['LeftHandMiddle4', 'LeftHandMiddle3'],
  ['LeftHandMiddleEnd', 'LeftHandMiddle4'],
  ['LeftHandRing1', 'LeftHand'],
  ['LeftHandRing2', 'LeftHandRing1'],
  ['LeftHandRing3', 'LeftHandRing2'],
  ['LeftHandRing4', 'LeftHandRing3'],
  ['LeftHandRingEnd', 'LeftHandRing4'],
  ['LeftHandPinky1', 'LeftHand'],
  ['LeftHandPinky2', 'LeftHandPinky1'],
  ['LeftHandPinky3', 'LeftHandPinky2'],
  ['LeftHandPinky4', 'LeftHandPinky3'],
  ['LeftHandPinkyEnd', 'LeftHandPinky4'],
  ['RightShoulder', 'Chest'],
  ['RightArm', 'RightShoulder'],
  ['RightForeArm', 'RightArm'],
  ['RightHand', 'RightForeArm'],
  ['RightHandThumb1', 'RightHand'],
  ['RightHandThumb2', 'RightHandThumb1'],
  ['RightHandThumb3', 'RightHandThumb2'],
  ['RightHandThumbEnd', 'RightHandThumb3'],
  ['RightHandIndex1', 'RightHand'],
  ['RightHandIndex2', 'RightHandIndex1'],
  ['RightHandIndex3', 'RightHandIndex2'],
  ['RightHandIndex4', 'RightHandIndex3'],
  ['RightHandIndexEnd', 'RightHandIndex4'],
  ['RightHandMiddle1', 'RightHand'],
  ['RightHandMiddle2', 'RightHandMiddle1'],
  ['RightHandMiddle3', 'RightHandMiddle2'],
  ['RightHandMiddle4', 'RightHandMiddle3'],
  ['RightHandMiddleEnd', 'RightHandMiddle4'],
  ['RightHandRing1', 'RightHand'],
  ['RightHandRing2', 'RightHandRing1'],
  ['RightHandRing3', 'RightHandRing2'],
  ['RightHandRing4', 'RightHandRing3'],
  ['RightHandRingEnd', 'RightHandRing4'],
  ['RightHandPinky1', 'RightHand'],
  ['RightHandPinky2', 'RightHandPinky1'],
  ['RightHandPinky3', 'RightHandPinky2'],
  ['RightHandPinky4', 'RightHandPinky3'],
  ['RightHandPinkyEnd', 'RightHandPinky4'],
  ['LeftLeg', 'Hips'],
  ['LeftShin', 'LeftLeg'],
  ['LeftFoot', 'LeftShin'],
  ['LeftToeBase', 'LeftFoot'],
  ['LeftToeEnd', 'LeftToeBase'],
  ['RightLeg', 'Hips'],
  ['RightShin', 'RightLeg'],
  ['RightFoot', 'RightShin'],
  ['RightToeBase', 'RightFoot'],
  ['RightToeEnd', 'RightToeBase'],
];

const FPS = 30;
const FRAMES = 6;

const childrenOf = (name) => SOMA77.filter(([, parent]) => parent === name).map(([n]) => n);

/** Deterministic — the fixture must be byte-stable across regenerations. */
const angleFor = (i, f) => Number((9 * Math.sin(((i * 29 + f * 20) * Math.PI) / 180)).toFixed(4));

// The exporter's channel order, not ours.
const ROOT_CHANNELS = 'CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation';
const JOINT_CHANNELS = 'CHANNELS 3 Zrotation Yrotation Xrotation';

function buildBvh() {
  const lines = ['HIERARCHY', 'ROOT Root', '{', '  OFFSET 0 0 0', `  ${ROOT_CHANNELS}`];

  // Faithful to the exporter: leaves get NO End Site block. Our other fixtures
  // all have one, so this is the only file in the corpus that tests the absence.
  const emit = (name, depth) => {
    const pad = '  '.repeat(depth);
    lines.push(`${pad}JOINT ${name}`);
    lines.push(`${pad}{`);
    lines.push(`${pad}  OFFSET 0 0.1 0`);
    lines.push(`${pad}  ${JOINT_CHANNELS}`);
    for (const kid of childrenOf(name)) emit(kid, depth + 1);
    lines.push(`${pad}}`);
  };
  emit('Hips', 1);
  lines.push('}');

  lines.push('MOTION');
  lines.push(`Frames: ${FRAMES}`);
  lines.push(`Frame Time: ${(1 / FPS).toFixed(7)}`);
  for (let f = 0; f < FRAMES; f += 1) {
    // Root carries zero, exactly as the exporter writes it; Hips carries the
    // root motion; every other joint carries its local rotation.
    const row = [0, 0, 0, 0, 0, 0];
    SOMA77.forEach(([name], i) => {
      if (name === 'Hips') row.push(0, 1, Number((f * 0.03).toFixed(4)));
      row.push(0, angleFor(i, f), 0);
    });
    lines.push(row.join(' '));
  }
  return `${lines.join('\n')}\n`;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'fixtures', 'anim');
mkdirSync(outDir, { recursive: true });
const target = resolve(outDir, 'soma-generated.bvh');
const text = buildBvh();
writeFileSync(target, text, 'utf8');
console.log(
  `wrote ${target} (${Buffer.byteLength(text, 'utf8')} bytes, ${SOMA77.length} joints + Root)`,
);
