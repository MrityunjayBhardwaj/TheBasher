#!/usr/bin/env node
// Generator for the STAND-IN RIGGED CHARACTER — the fixture that lets the
// retarget seam's end-to-end gate run on CI (#850).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────
// `tests/e2e/generated-character-generated-motion.spec.ts` is the only gate
// that asserts at the CONSUMER for the seam where generated motion meets a
// generated character — the span that produced #828, #838, #839, #843, #844
// and #846, one after another. It ran against a real Tripo export: ~58 MB,
// licence uncleared, untracked, and therefore ABSENT on every runner. The
// spec skipped rather than failed, so every gate written for this seam was
// local-only and gated nothing.
//
// The move this repo already makes in `gen-mixamo-naming-fixture.mjs` is to
// GENERATE THE CHARACTERISTIC INSTEAD OF IMPORTING THE ASSET. A rigged
// character is a skeleton plus a handful of weighted vertices; the vendor's
// contribution is the mesh, and the mesh is the part the seam never touches.
//
// ─────────────────────────────────────────────────────────────────────────
// THE CHARACTERISTICS IT MUST CARRY, AND WHAT EACH ONE IS FOR
// ─────────────────────────────────────────────────────────────────────────
// A fixture that is degenerate on an axis cannot fail on that axis, and that
// is exactly how each of these defects reached a user past a green suite.
// Every row here was read off a real Tripo export and is reproduced in
// STRUCTURE, with numbers of this file's own choosing — a fixture that copied
// the asset's values would gate one asset instead of the property.
//
//   `mixamorig:` COLON NAMES — the vocabulary the somaToMixamo preset targets,
//       and the separator our sanitiser rewrites while three's removes.
//
//   A NON-IDENTITY CORRECTIVE ROOT — the real rig's `Root` carries the
//       quaternion that stands a Z-up skeleton upright inside a Y-up glTF.
//       #838 shipped because every fixture rig in the suite had an identity
//       root, which made a root that gets flattened unobservable.
//
//   A REAL T-POSE BIND, arms out along the character's sides — #844 is a
//       disagreement between the source's rest pose and the target's bind, and
//       a target whose bind pointed the same way as the source's rest could
//       not exhibit it.
//
//   A HIP OFFSET THAT IS NOT THE LEG CHAIN — 0.55 against 1.08. #846 was a
//       scale derived from the wrong one of those two, and on a rig where they
//       agree the two bases are indistinguishable. The gap is sized to match the
//       real pair's: against `soma-walk.bvh`'s nominal hip of 1.0 and legs of
//       1.70 the two bases differ by 13%, which is what the live rigs produced.
//       An earlier 0.60 left only 5.6% between them — still caught, but a
//       fixture should not be the reason a margin is thin.
//
//   LEGS OF UNEQUAL LENGTH — 0.55 and 0.53. Deriving the scale from the single
//       longest leg is a coin flip that a symmetric rig cannot catch.
//
//   A BOUND SKIN — vertices with JOINTS_0/WEIGHTS_0, so the import produces a
//       SkinnedMesh. A GLB that parses but carries no skin is a mesh that
//       arrived and a rig that did not, and the spec asserts the difference.
//
// Output: public/fixtures/rig/standin-character.glb
// Run:    node scripts/gen-standin-rig-fixture.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

// GLTFExporter touches FileReader on some paths; Node lacks it. The same tiny
// polyfill `gen-skinned-fixture.mjs` uses.
class NodeFileReader {
  readAsDataURL(blob) {
    blob
      .arrayBuffer()
      .then((buf) => {
        this.result = `data:application/octet-stream;base64,${Buffer.from(buf).toString('base64')}`;
        this.onload?.();
        this.onloadend?.();
      })
      .catch((err) => {
        this.onerror?.(err);
        this.onloadend?.();
      });
  }

  readAsArrayBuffer(blob) {
    blob
      .arrayBuffer()
      .then((buf) => {
        this.result = buf;
        this.onload?.();
        this.onloadend?.();
      })
      .catch((err) => {
        this.onerror?.(err);
        this.onloadend?.();
      });
  }
}
globalThis.FileReader = NodeFileReader;

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(ROOT, 'public/fixtures/rig');

/**
 * The skeleton, as [name, parent, translation IN THE CHARACTER'S OWN FRAME]:
 * +Y up, +X to the character's left, +Z forward.
 *
 * That is NOT the frame the bones are written in — `toBoneFrame` below converts.
 * Authoring in character terms and converting once is deliberate: the corrective
 * root means "up" for a bone is not +Y, and a table that had to be read in the
 * rotated frame would be unreviewable. The first draft of this file skipped the
 * conversion, authored +Y up, and produced a fixture whose head sat at exactly
 * its hips' height — the #844 symptom, manufactured by the fixture itself.
 *
 * Segment lengths are chosen, not copied, and chosen so that no two of the
 * quantities the retarget might scale by are equal:
 *
 *     hip height          0.55
 *     left leg  0.30 + 0.25 = 0.55       right leg  0.26 + 0.27 = 0.53
 *     both legs summed             1.08
 *
 * The hips sitting at about one leg's length is what a real rig does — the
 * measured Tripo export has 0.5102 against a 0.4954 leg — and it is exactly why
 * the hip offset LOOKS like a usable stand-in for hip height until it meets a
 * source rig whose hip offset is a nominal constant.
 *
 * Arms run along ±X — a T-pose — while the spine runs along +Y, so the bind
 * is not axis-degenerate either.
 */
const SKELETON = [
  ['mixamorig:Hips', null, [0, 0.55, 0]],
  ['mixamorig:Spine', 'mixamorig:Hips', [0, 0.09, 0]],
  ['mixamorig:Spine1', 'mixamorig:Spine', [0, 0.1, 0]],
  ['mixamorig:Spine2', 'mixamorig:Spine1', [0, 0.1, 0]],
  ['mixamorig:Neck', 'mixamorig:Spine2', [0, 0.08, 0]],
  ['mixamorig:Head', 'mixamorig:Neck', [0, 0.11, 0]],
  // Left arm, out along +X.
  ['mixamorig:LeftShoulder', 'mixamorig:Spine2', [0.05, 0.06, 0]],
  ['mixamorig:LeftArm', 'mixamorig:LeftShoulder', [0.12, 0, 0]],
  ['mixamorig:LeftForeArm', 'mixamorig:LeftArm', [0.24, 0, 0]],
  ['mixamorig:LeftHand', 'mixamorig:LeftForeArm', [0.22, 0, 0]],
  // Right arm, the mirror.
  ['mixamorig:RightShoulder', 'mixamorig:Spine2', [-0.05, 0.06, 0]],
  ['mixamorig:RightArm', 'mixamorig:RightShoulder', [-0.12, 0, 0]],
  ['mixamorig:RightForeArm', 'mixamorig:RightArm', [-0.24, 0, 0]],
  ['mixamorig:RightHand', 'mixamorig:RightForeArm', [-0.22, 0, 0]],
  // Legs, down along -Y, deliberately unequal.
  ['mixamorig:LeftUpLeg', 'mixamorig:Hips', [0.09, -0.02, 0]],
  ['mixamorig:LeftLeg', 'mixamorig:LeftUpLeg', [0, -0.3, 0]],
  ['mixamorig:LeftFoot', 'mixamorig:LeftLeg', [0, -0.25, 0]],
  ['mixamorig:LeftToeBase', 'mixamorig:LeftFoot', [0, -0.04, 0.08]],
  ['mixamorig:RightUpLeg', 'mixamorig:Hips', [-0.09, -0.02, 0]],
  ['mixamorig:RightLeg', 'mixamorig:RightUpLeg', [0, -0.26, 0]],
  ['mixamorig:RightFoot', 'mixamorig:RightLeg', [0, -0.27, 0]],
  ['mixamorig:RightToeBase', 'mixamorig:RightFoot', [0, -0.04, 0.08]],
];

/**
 * The corrective root, and it is the point of having a root at all.
 *
 * A real Tripo export carries `Root` with the quaternion that maps a Z-up
 * skeleton into a Y-up glTF — measured `[-0.5, 0.5, 0.5, 0.5]`, which is a
 * −90° turn about X followed by +90° about Z. Driving that bone to identity
 * lays the whole character down, and #838 is exactly that happening silently.
 * This fixture carries the same rotation so a root that gets flattened is
 * VISIBLE here, which no other rig in the suite can say.
 */
const ROOT_EULER = [-Math.PI / 2, 0, Math.PI / 2];

/**
 * Character frame → bone frame, the inverse of what the corrective root applies.
 *
 * Measured off that rotation rather than derived by hand: it takes local +Z to
 * world +Y, local −Y to world +X and local −X to world +Z. So a bone that should
 * stand UP in the world is written along +Z, and the real rig agrees — its hips
 * sit at `[0, 0, 0.5102]`, not `[0, 0.5102, 0]`.
 */
const toBoneFrame = ([x, y, z]) => [-z, -x, y];

function buildCharacter() {
  const byName = new Map();
  const ordered = [];

  const root = new THREE.Bone();
  root.name = 'Root';
  root.rotation.set(ROOT_EULER[0], ROOT_EULER[1], ROOT_EULER[2], 'XYZ');
  ordered.push(root);

  for (const [name, parent, t] of SKELETON) {
    const bone = new THREE.Bone();
    bone.name = name;
    const local = toBoneFrame(t);
    bone.position.set(local[0], local[1], local[2]);
    (parent === null ? root : byName.get(parent)).add(bone);
    byName.set(name, bone);
    ordered.push(bone);
  }

  // A minimal skin: one small quad per bone, placed at that bone's own rest
  // position and weighted 100% to it. Enough to make this a real SkinnedMesh
  // that deforms — which is what the import asserts — without being a model.
  const positions = [];
  const skinIndices = [];
  const skinWeights = [];
  const indices = [];
  root.updateMatrixWorld(true);
  const world = new THREE.Vector3();
  ordered.forEach((bone, boneIndex) => {
    // No quad on the corrective root, so VERTEX 0 SITS ON THE HIPS. The spec
    // reads vertex 0 to decide whether the character travelled at all (#839),
    // and a first vertex bound to a bone that never moves reports a still
    // character no matter what the rig is doing — the fixture answering for the
    // code, which is the failure this whole fixture exists to end.
    if (bone === root) return;
    world.setFromMatrixPosition(bone.matrixWorld);
    const base = positions.length / 3;
    for (const [dx, dy] of [
      [-0.02, -0.02],
      [0.02, -0.02],
      [-0.02, 0.02],
      [0.02, 0.02],
    ]) {
      positions.push(world.x + dx, world.y + dy, world.z);
      skinIndices.push(boneIndex, 0, 0, 0);
      skinWeights.push(1, 0, 0, 0);
    }
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.SkinnedMesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: '#8fa8c8', roughness: 0.7, metalness: 0 }),
  );
  mesh.name = 'StandInCharacter';
  mesh.add(root);
  // Bones need world matrices before Skeleton computes the bind inverses from
  // them — the ordering K42 names, and the defect #828/#838 were both under.
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(ordered));
  return { mesh, bones: ordered };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const { mesh, bones } = buildCharacter();
  const exporter = new GLTFExporter();
  const ab = await new Promise((res, rej) => {
    exporter.parse(
      mesh,
      (result) => {
        if (!(result instanceof ArrayBuffer)) {
          rej(new Error('expected ArrayBuffer for binary GLB export'));
          return;
        }
        res(result);
      },
      (err) => rej(err),
      { binary: true },
    );
  });
  const out = resolve(OUT_DIR, 'standin-character.glb');
  writeFileSync(out, Buffer.from(ab));

  const len = (n) => {
    const b = bones.find((x) => x.name === n);
    return Math.hypot(b.position.x, b.position.y, b.position.z);
  };
  const legs =
    len('mixamorig:LeftLeg') +
    len('mixamorig:LeftFoot') +
    len('mixamorig:RightLeg') +
    len('mixamorig:RightFoot');
  console.log(
    `wrote ${out} (${ab.byteLength} bytes)\n` +
      `  bones      ${bones.length} (Root + ${SKELETON.length})\n` +
      `  hip offset ${len('mixamorig:Hips').toFixed(4)}\n` +
      `  leg chains ${legs.toFixed(4)} summed — deliberately NOT the hip offset (#846)\n` +
      `  root       non-identity, [-90, 0, 90]° (#838)`,
  );
}

main().catch((err) => {
  console.error('gen-standin-rig-fixture failed:', err);
  process.exit(1);
});
