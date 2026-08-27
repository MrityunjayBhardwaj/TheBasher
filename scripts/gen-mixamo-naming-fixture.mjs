#!/usr/bin/env node
// Generator for the MIXAMO-NAMING fixtures — the corpus gap that let a total,
// silent retarget failure ship (#742).
//
// Every committed animation fixture was minimal on purpose: rig.fbx is 2 bones
// named `Hips`/`Spine`, walk.bvh is 1 joint and 2 frames. Minimal is the right
// instinct for the code PATH and the wrong one for the PROPERTY — not one of
// them carries a vendor namespace, so the whole class of namespace-handling bugs
// was unreachable by the suite, including a dedicated e2e import gate. The bug
// surfaced only when a real 3.7 MB Mixamo export was run through the same code
// by hand, and it had matched 0 of 22 preset keys and emitted 0 keyframes.
//
// Committing the real asset is the obvious move and the wrong one: its terms are
// not cleared for this repo, and the repo's own external-model gate would be
// right to object. So GENERATE the characteristic instead of importing the
// asset. These two files carry `mixamorig:`-style colon names across the SAME 22
// joints the shipped mixamoToGltf preset covers, in a few kilobytes, with no
// licence exposure at all.
//
// Two files because the colon is spelled differently on each road, and the whole
// bug lived in the gap between them:
//
//   .bvh  → three's BVHLoader, then OUR sanitizeBoneName, which REPLACES the
//           colon with `_`  →  mixamorig_Hips
//   .fbx  → three's FBXLoader, which calls PropertyBinding.sanitizeNodeName and
//           REMOVES the colon entirely  →  mixamorigHips
//
// A fixture on one road alone cannot see the disagreement, which is precisely
// how the disagreement survived.
//
// Output: public/fixtures/anim/mixamo-naming.bvh
//         public/fixtures/anim/mixamo-naming.fbx
// Run:    node scripts/gen-mixamo-naming-fixture.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const NS = 'mixamorig:';

// The 22 joints the shipped mixamoToGltf preset maps, and their real Mixamo
// parentage. Keeping the set identical to the preset's is deliberate: it makes
// "22 of 22 keys landed" an exact statement rather than an approximate one, and
// it is the same count the field failure reported as 0.
const JOINTS = [
  ['Hips', null, [0, 1.0, 0]],
  ['Spine', 'Hips', [0, 0.1, 0]],
  ['Spine1', 'Spine', [0, 0.12, 0]],
  ['Spine2', 'Spine1', [0, 0.12, 0]],
  ['Neck', 'Spine2', [0, 0.15, 0]],
  ['Head', 'Neck', [0, 0.1, 0]],
  ['LeftShoulder', 'Spine2', [0.05, 0.1, 0]],
  ['LeftArm', 'LeftShoulder', [0.12, 0, 0]],
  ['LeftForeArm', 'LeftArm', [0.26, 0, 0]],
  ['LeftHand', 'LeftForeArm', [0.24, 0, 0]],
  ['RightShoulder', 'Spine2', [-0.05, 0.1, 0]],
  ['RightArm', 'RightShoulder', [-0.12, 0, 0]],
  ['RightForeArm', 'RightArm', [-0.26, 0, 0]],
  ['RightHand', 'RightForeArm', [-0.24, 0, 0]],
  ['LeftUpLeg', 'Hips', [0.09, -0.05, 0]],
  ['LeftLeg', 'LeftUpLeg', [0, -0.4, 0]],
  ['LeftFoot', 'LeftLeg', [0, -0.4, 0]],
  ['LeftToeBase', 'LeftFoot', [0, -0.08, 0.12]],
  ['RightUpLeg', 'Hips', [-0.09, -0.05, 0]],
  ['RightLeg', 'RightUpLeg', [0, -0.4, 0]],
  ['RightFoot', 'RightLeg', [0, -0.4, 0]],
  ['RightToeBase', 'RightFoot', [0, -0.08, 0.12]],
];

const FPS = 30;
const FRAMES = 8;

const childrenOf = (name) => JOINTS.filter(([, parent]) => parent === name).map(([n]) => n);
const jointByName = (name) => JOINTS.find(([n]) => n === name);

/** Deterministic, so the fixture is byte-stable across regenerations. */
function angleFor(index, frame) {
  const phase = (index * 37) % 360;
  return Number((12 * Math.sin(((phase + frame * 15) * Math.PI) / 180)).toFixed(4));
}

function buildBvh() {
  const lines = ['HIERARCHY'];

  const emit = (name, depth) => {
    const pad = '  '.repeat(depth);
    const [, , offset] = jointByName(name);
    const isRoot = depth === 0;
    lines.push(`${pad}${isRoot ? 'ROOT' : 'JOINT'} ${NS}${name}`);
    lines.push(`${pad}{`);
    lines.push(`${pad}  OFFSET ${offset.join(' ')}`);
    lines.push(
      isRoot
        ? `${pad}  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation`
        : `${pad}  CHANNELS 3 Xrotation Yrotation Zrotation`,
    );
    const kids = childrenOf(name);
    if (kids.length === 0) {
      // A leaf needs an End Site or the hierarchy has no length. Its name is not
      // ours to choose — three's BVHLoader calls every one of them ENDSITE, which
      // is itself worth having in the corpus.
      lines.push(`${pad}  End Site`);
      lines.push(`${pad}  {`);
      lines.push(`${pad}    OFFSET 0 0.05 0`);
      lines.push(`${pad}  }`);
    } else {
      for (const kid of kids) emit(kid, depth + 1);
    }
    lines.push(`${pad}}`);
  };
  emit('Hips', 0);

  lines.push('MOTION');
  lines.push(`Frames: ${FRAMES}`);
  lines.push(`Frame Time: ${(1 / FPS).toFixed(7)}`);
  for (let f = 0; f < FRAMES; f += 1) {
    const row = [];
    JOINTS.forEach(([, parent], i) => {
      if (parent === null) row.push(0, 1, Number((f * 0.02).toFixed(4)));
      row.push(0, angleFor(i, f), 0);
    });
    lines.push(row.join(' '));
  }
  return `${lines.join('\n')}\n`;
}

function buildFbx() {
  // Mirrors public/fixtures/anim/rig.fbx exactly in shape — same ASCII FBX 7.4.0
  // header, same LimbNode models, same connection style — so the only thing this
  // fixture changes relative to the one already proven to load is the NAMES.
  const idOf = (name) => 100 + JOINTS.findIndex(([n]) => n === name) * 10;

  const models = JOINTS.map(([name, , offset]) => {
    return [
      `\tModel: ${idOf(name)}, "Model::${NS}${name}", "LimbNode" {`,
      '\t\tVersion: 232',
      '\t\tProperties70:  {',
      `\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",${offset.join(',')}`,
      '\t\t}',
      '\t\tShading: T',
      '\t\tCulling: "CullingOff"',
      '\t}',
    ].join('\n');
  }).join('\n');

  // Child-to-parent, root last onto the scene node (0) — the ordering rig.fbx uses.
  const boneConnections = JOINTS.filter(([, parent]) => parent !== null)
    .map(([name, parent]) => `\tC: "OO",${idOf(name)},${idOf(parent)}`)
    .join('\n');

  const stop = 46186158000;
  return `; FBX 7.4.0 project file
; ----------------------------------------------------

FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
\tCreator: "basher-test"
}
GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UnitScaleFactor", "double", "Number", "",1
\t}
}

Definitions:  {
\tVersion: 100
\tCount: ${JOINTS.length + 4}
\tObjectType: "Model" {
\t\tCount: ${JOINTS.length}
\t}
\tObjectType: "AnimationStack" {
\t\tCount: 1
\t}
\tObjectType: "AnimationLayer" {
\t\tCount: 1
\t}
\tObjectType: "AnimationCurveNode" {
\t\tCount: 1
\t}
\tObjectType: "AnimationCurve" {
\t\tCount: 1
\t}
}

Objects:  {
${models}
\tAnimationStack: 1000, "AnimStack::Take 001", "" {
\t\tProperties70:  {
\t\t\tP: "LocalStop", "KTime", "Time", "",${stop}
\t\t}
\t}
\tAnimationLayer: 1100, "AnimLayer::BaseLayer", "" {
\t}
\tAnimationCurveNode: 1200, "AnimCurveNode::T", "" {
\t\tProperties70:  {
\t\t\tP: "d|X", "Number", "", "A",0
\t\t\tP: "d|Y", "Number", "", "A",0
\t\t\tP: "d|Z", "Number", "", "A",0
\t\t}
\t}
\tAnimationCurve: 1300, "AnimCurve::", "" {
\t\tDefault: 0
\t\tKeyVer: 4009
\t\tKeyTime: *2 {
\t\t\ta: 0,${stop}
\t\t}
\t\tKeyValueFloat: *2 {
\t\t\ta: 0,2
\t\t}
\t}
}

Connections:  {
${boneConnections}
\tC: "OO",${idOf('Hips')},0
\tC: "OO",1100,1000
\tC: "OO",1200,1100
\tC: "OP",1200,${idOf('Hips')}, "Lcl Translation"
\tC: "OP",1300,1200, "d|X"
}
`;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'fixtures', 'anim');
mkdirSync(outDir, { recursive: true });

for (const [file, text] of [
  ['mixamo-naming.bvh', buildBvh()],
  ['mixamo-naming.fbx', buildFbx()],
]) {
  const target = resolve(outDir, file);
  writeFileSync(target, text, 'utf8');
  console.log(
    `wrote ${target} (${Buffer.byteLength(text, 'utf8')} bytes, ${JOINTS.length} joints)`,
  );
}
