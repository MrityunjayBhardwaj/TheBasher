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
// ─────────────────────────────────────────────────────────────────────────
// TWO FILES, AND THEY ARE FOR DIFFERENT THINGS
// ─────────────────────────────────────────────────────────────────────────
// `soma-generated.bvh` is a CONFORMANCE fixture. Its job is the exporter's
// FORMAT — the wrapper Root, the missing End Site blocks, the ZYX channel
// order, the six-channel Hips — so its skeleton is deliberately a uniform
// stick and its motion deliberately tiny. Nothing about it should change to
// suit a consumer.
//
// `soma-walk.bvh` is an ANATOMY fixture, added for #850. The seam between a
// generated clip and a generated character has produced six defects, and the
// only end-to-end gate over it ran on 58 MB of untracked vendor output and so
// skipped on every runner. Standing that gate up needs a source clip that
// carries the two properties the conformance fixture has no reason to:
//
//   A DEGENERATE REST POSE. The real generator's OFFSETs put head, hands and
//       feet all at hip height along ±X — the figure is not upright in its rest
//       at all. The upright A-pose lives in the ROTATION CHANNELS. #844 is the
//       two rigs disagreeing about that, and a source whose rest already
//       pointed where the target's bind points cannot exhibit it.
//
//   MOTION A PERSON COULD SEE. #843 rendered every rotation at 1/57 of its
//       size, and the gate for it asserts bones swing by a visible amount.
//       Nine degrees of synthesised wobble cannot clear that bar, so it could
//       not tell the defect from the fixture.
//
// Both files come from ONE joint table, because two transcriptions of 77 joints
// would drift and the drift would be silent.
//
// Outputs: public/fixtures/anim/soma-generated.bvh
//          public/fixtures/anim/soma-walk.bvh
// Run:     node scripts/gen-soma-motion-fixture.mjs

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

/**
 * CENTIMETRES, because the real exporter emits centimetres.
 *
 * `kimodo/exports/bvh.py` multiplies both the neutral skeleton and the root
 * trajectory by 100 before writing, and defaults the pelvis offset to
 * `[0, 100, 0]` with the comment "1 m in cm". Measured on a real generated clip:
 * `Hips OFFSET 0.0 100.0 0.0`, hip channel 93-99, 4.58 m of travel in 4.0 s.
 *
 * The first version of this fixture used metres, because a skeleton DEFINITION
 * says nothing about units and metres is what a reader assumes. That is the shape
 * of the whole correction here: everything the source stated was transcribed
 * correctly, and everything it did not state was filled in with the plausible
 * default and was wrong. The numbers below are synthetic; the SCALE is measured.
 */
const HIP_HEIGHT_CM = 100;
const LIMB_OFFSET_CM = 10;

const childrenOf = (name) => SOMA77.filter(([, parent]) => parent === name).map(([n]) => n);

/** Deterministic — the fixture must be byte-stable across regenerations. */
const angleFor = (i, f) => Number((9 * Math.sin(((i * 29 + f * 20) * Math.PI) / 180)).toFixed(4));

// The exporter's channel order, not ours.
const POSED_CHANNELS = 'CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation';
const ROTATION_CHANNELS = 'CHANNELS 3 Zrotation Yrotation Xrotation';

function buildBvh() {
  const lines = ['HIERARCHY', 'ROOT Root', '{', '  OFFSET 0 0 0', `  ${POSED_CHANNELS}`];

  // Declaration order and the per-joint channel count, collected AS the hierarchy
  // is written rather than assumed alongside it. The previous version declared
  // Hips with 3 channels and then wrote 6 values for it, so the header promised
  // 237 channels and every row carried 240 — every joint after Hips read its
  // predecessor's rotation. Nothing caught it: three's loader does not check, and
  // the tests over this fixture assert names and parentage, which the shift does
  // not touch.
  const layout = [{ name: 'Root', channels: 6 }];

  // Faithful to the exporter: leaves get NO End Site block. Our other fixtures
  // all have one, so this is the only file in the corpus that tests the absence.
  const emit = (name, depth) => {
    const pad = '  '.repeat(depth);
    // Hips carries the root motion, so it is POSED (6 channels) exactly as the
    // exporter writes it. Its OFFSET is the pelvis's REST height; the position
    // channels are its ANIMATED height. Both are present in the real file, and
    // that they are the same quantity written twice is issue #792.
    const posed = name === 'Hips';
    lines.push(`${pad}JOINT ${name}`);
    lines.push(`${pad}{`);
    lines.push(`${pad}  OFFSET 0 ${posed ? HIP_HEIGHT_CM : LIMB_OFFSET_CM} 0`);
    lines.push(`${pad}  ${posed ? POSED_CHANNELS : ROTATION_CHANNELS}`);
    layout.push({ name, channels: posed ? 6 : 3 });
    for (const kid of childrenOf(name)) emit(kid, depth + 1);
    lines.push(`${pad}}`);
  };
  emit('Hips', 1);
  lines.push('}');

  const declared = layout.reduce((n, j) => n + j.channels, 0);

  lines.push('MOTION');
  lines.push(`Frames: ${FRAMES}`);
  // Full precision — a rounded 7 places reads back as 30.00003 fps, and the whole
  // contract is that a consumer DERIVES the rate from this line.
  lines.push(`Frame Time: ${1 / FPS}`);
  for (let f = 0; f < FRAMES; f += 1) {
    // Root carries zero, exactly as the exporter writes it; Hips carries the
    // root motion in centimetres; every other joint carries its local rotation.
    const row = [];
    for (const joint of layout) {
      const i = layout.indexOf(joint);
      if (joint.name === 'Root') row.push(0, 0, 0, 0, 0, 0);
      else if (joint.name === 'Hips')
        row.push(0, HIP_HEIGHT_CM - 4, Number((f * 3).toFixed(4)), 0, angleFor(i, f), 0);
      else row.push(0, angleFor(i, f), 0);
    }
    // The gate this file did not have. A row that disagrees with the header is
    // still valid-looking BVH that every reader accepts and silently misreads, so
    // the only place it can be caught is where both are constructed.
    if (row.length !== declared) {
      throw new Error(
        `fixture is malformed: header declares ${declared} channels, row ${f} carries ${row.length}`,
      );
    }
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

// ═════════════════════════════════════════════════════════════════════════
// soma-walk.bvh — the ANATOMY fixture (#850)
// ═════════════════════════════════════════════════════════════════════════

import * as THREE from 'three';

/** Frames of walk, at the same 30 fps — one full stride cycle over the second. */
const WALK_FRAMES = 31;
/** Centimetres travelled over the clip — a stride a stride-vs-leg gate can read. */
const WALK_TRAVEL_CM = 60;

/**
 * The REST skeleton, in centimetres, and it is deliberately not a figure.
 *
 * Every chain runs along ±X at hip height, which is what the real exporter
 * writes: measured on a generated clip, the head sits at `X 60.5 / Y 99.5` and
 * the left hand at `X 114.7 / Y 105.2` against hips at `Y 100`. Accumulating
 * these offsets gives a starfish, not a person. That is the property #844 is
 * about, and a fixture that quietly authored an upright rest would hide it.
 *
 * Left-side chains run +X and right-side −X, mirroring the real file. Joints
 * not named here — fingers, jaw, eyes, chain ends — take the default, which is
 * enough to give them a direction without pretending to anatomy.
 */
const WALK_REST_CM = {
  Hips: [0, 100, 0],
  Spine1: [5, 0, 0],
  Spine2: [7, 0, 0],
  Chest: [8, 0, 0],
  Neck1: [26, -1, 0],
  Neck2: [8, 0, 0],
  Head: [6, 0, 0],
  LeftShoulder: [23, 5, 2],
  LeftArm: [16, 0, 0],
  LeftForeArm: [29, 0, 0],
  LeftHand: [27, 0, 0],
  RightShoulder: [23, 5, -2],
  RightArm: [-16, 0, 0],
  RightForeArm: [-29, 0, 0],
  RightHand: [-27, 0, 0],
  LeftLeg: [-8, 3, 10],
  LeftShin: [-43, 0, 0],
  LeftFoot: [-42, 0, 0],
  LeftToeBase: [-14, 0, 0],
  RightLeg: [-8, 3, -10],
  RightShin: [-43, 0, 0],
  RightFoot: [-42, 0, 0],
  RightToeBase: [-14, 0, 0],
};

// 🔴 BOTH LEG CHAINS RUN −X, WHERE THE REAL FILE MIRRORS THEM. The first draft
// mirrored, and it parked the left thigh's calibration rotation at exactly ±180°
// — a chain running +X under a pelvis that has already turned +X onto +Y needs
// half a turn to point back down. The transported Euler then wrapped mid-clip
// (`-175°` to `+175°` between two frames), which interpolates the long way round
// and spins the leg. Running both legs against the spine instead puts their
// calibration at identity, as far from the singularity as it is possible to be.
//
// The property this fixture exists to carry is that the REST IS DEGENERATE and
// the upright figure lives in the channels. Which side of the X axis a leg lies
// on is not that property, and buying symmetry with it costs nothing.

const parentOf = Object.fromEntries(SOMA77.map(([name, parent]) => [name, parent]));
const restOf = (name) => WALK_REST_CM[name] ?? (name.startsWith('Right') ? [-4, 0, 0] : [4, 0, 0]);
/** The child that defines which way a joint POINTS — the first one declared. */
const primaryChild = (name) => childrenOf(name)[0];

const inLeg = (name) => /^(Left|Right)(Leg|Shin|Foot|Toe)/.test(name);
const inFoot = (name) => /^(Left|Right)(Foot|Toe)/.test(name);
const inArm = (name) => /^(Left|Right)(Shoulder|Arm|ForeArm|Hand)/.test(name);

/**
 * Where each joint's chain should POINT, in world space, at frame `f`.
 *
 * Frame 0 is the pure A-pose calibration: spine up, legs down, arms hanging out
 * and away. From frame 1 the legs swing and the arms counter-swing, which is
 * what makes the clip a walk rather than a pose.
 *
 * Expressing the motion as world DIRECTIONS and solving for the local rotations
 * is the whole trick here. Authoring local Euler triples by hand against a rest
 * pose that is already 90° away from anatomy is how a fixture ends up asserting
 * something nobody intended — and this file is being added precisely because
 * fixtures that could not exhibit the property under test kept shipping.
 */
function walkDirection(name, f) {
  const side = name.startsWith('Right') ? -1 : 1;
  // ONE stride cycle over the clip, not two, and the reason is aliasing. At two
  // cycles the swing's period is exactly half a second, so any observer sampling
  // at quarter-second marks — the first sample times anyone reaches for — lands
  // on a zero crossing every time and reads a character that never moves. A
  // fixture whose motion disappears under the most natural sampling is a fixture
  // that will one day be read as a dead feature.
  const phase = (f / (WALK_FRAMES - 1)) * Math.PI * 2;
  // Both zero at f = 0, so the first frame is the clean A-pose the retarget reads
  // as the source's calibration. Leaving the knee term ungated put a 34° bend in
  // the right leg's reference pose, and `restPoseLocalOffsets` would then have
  // carried that bend into every frame as if it were the rig's rest.
  const swing = f === 0 ? 0 : Math.sin(phase) * side;
  const knee = f === 0 ? 0 : 0.3 * (1 - Math.cos(phase + (side < 0 ? Math.PI : 0)));

  if (inFoot(name)) return new THREE.Vector3(1, -0.2, 0).normalize();
  if (inLeg(name)) {
    // Thigh and shin swing fore-and-aft about the lateral axis. The knee bend
    // VARIES — a constant one is a local rotation that never changes, so the
    // shins sat perfectly still while the thighs swung and the fixture had two
    // fewer moving bones than it looked like it had.
    // Side-shifted, so the two knees are not the same track. Identical left and
    // right values would make a swapped-sides defect invisible here.
    const bend = name.includes('Shin') ? knee : 0;
    return new THREE.Vector3(
      Math.sin(swing * 0.45 + bend),
      -Math.cos(swing * 0.45 + bend),
      0,
    ).normalize();
  }
  if (name.includes('Shoulder')) return new THREE.Vector3(0, 0.15, side).normalize();
  if (inArm(name)) {
    // An A-pose: down and away from the body, counter-swinging the legs.
    return new THREE.Vector3(Math.sin(-swing * 0.3), -0.9, side * 0.45).normalize();
  }
  return new THREE.Vector3(0, 1, 0); // spine, neck, head — up
}

/**
 * Solve each joint's LOCAL rotation so its chain points where `walkDirection`
 * asks, given everything above it is already solved.
 *
 * `Rlocal` takes the joint's rest direction onto the wanted one expressed in the
 * parent's frame — `setFromUnitVectors` gives the minimal such rotation. A joint
 * with no child has no direction to aim and stays identity, inheriting its
 * parent, which is the same answer Blender's constraint stack lands on.
 */
function solveFrame(f) {
  const world = new Map([[null, new THREE.Quaternion()]]);
  const local = new Map();
  for (const [name] of SOMA77) {
    const parentWorld = world.get(parentOf[name]) ?? new THREE.Quaternion();
    const child = primaryChild(name);
    let q = new THREE.Quaternion();
    if (child) {
      const rest = new THREE.Vector3(...restOf(child)).normalize();
      const want = walkDirection(name, f).clone().applyQuaternion(parentWorld.clone().invert());
      q = new THREE.Quaternion().setFromUnitVectors(rest, want.normalize());
    }
    local.set(name, q);
    world.set(name, parentWorld.clone().multiply(q));
  }
  return local;
}

/**
 * A local quaternion as the three numbers the exporter's `Zrotation Yrotation
 * Xrotation` channels carry, in degrees.
 *
 * The channel order is the exporter's, not ours, and three's BVHLoader composes
 * the channels in the order they are declared — so the Euler that reproduces a
 * given quaternion under that composition is the ZYX one. Read back and checked
 * rather than assumed: the generated file is parsed and its frame 0 measured
 * upright before it is committed.
 */
function toZyxDegrees(q) {
  const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
  const deg = (r) => Number(((r * 180) / Math.PI).toFixed(4));
  return [deg(e.z), deg(e.y), deg(e.x)];
}

function buildWalkBvh() {
  const lines = ['HIERARCHY', 'ROOT Root', '{', '  OFFSET 0 0 0', `  ${POSED_CHANNELS}`];
  const layout = [{ name: 'Root', channels: 6 }];

  const emit = (name, depth) => {
    const pad = '  '.repeat(depth);
    const posed = name === 'Hips';
    const off = restOf(name);
    lines.push(`${pad}JOINT ${name}`);
    lines.push(`${pad}{`);
    lines.push(`${pad}  OFFSET ${off[0]} ${off[1]} ${off[2]}`);
    lines.push(`${pad}  ${posed ? POSED_CHANNELS : ROTATION_CHANNELS}`);
    layout.push({ name, channels: posed ? 6 : 3 });
    for (const kid of childrenOf(name)) emit(kid, depth + 1);
    lines.push(`${pad}}`);
  };
  emit('Hips', 1);
  lines.push('}');

  const declared = layout.reduce((n, j) => n + j.channels, 0);
  lines.push('MOTION');
  lines.push(`Frames: ${WALK_FRAMES}`);
  lines.push(`Frame Time: ${1 / FPS}`);

  for (let f = 0; f < WALK_FRAMES; f += 1) {
    const local = solveFrame(f);
    const travel = Number(((WALK_TRAVEL_CM * f) / (WALK_FRAMES - 1)).toFixed(4));
    // A small vertical bob, so the hips carry more than one axis of motion and a
    // consumer that drops an axis is visible rather than merely smaller.
    const bob = Number((Math.sin((f / (WALK_FRAMES - 1)) * Math.PI * 8) * 1.5).toFixed(4));
    const row = [];
    for (const joint of layout) {
      if (joint.name === 'Root') row.push(0, 0, 0, 0, 0, 0);
      else if (joint.name === 'Hips')
        row.push(travel, HIP_HEIGHT_CM + bob, 0, ...toZyxDegrees(local.get('Hips')));
      else row.push(...toZyxDegrees(local.get(joint.name)));
    }
    if (row.length !== declared) {
      throw new Error(
        `walk fixture is malformed: header declares ${declared} channels, row ${f} carries ${row.length}`,
      );
    }
    lines.push(row.join(' '));
  }
  return `${lines.join('\n')}\n`;
}

const walkTarget = resolve(outDir, 'soma-walk.bvh');
const walkText = buildWalkBvh();
writeFileSync(walkTarget, walkText, 'utf8');
console.log(
  `wrote ${walkTarget} (${Buffer.byteLength(walkText, 'utf8')} bytes, ${WALK_FRAMES} frames, ${WALK_TRAVEL_CM} cm of travel)`,
);
