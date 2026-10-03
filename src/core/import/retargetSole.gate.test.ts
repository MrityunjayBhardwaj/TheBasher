// #1455 — A FOOT BOTH RIGS STAND ON KEEPS ITS SOLE, NOT ITS CHORD.
//
// #866 turned every target bone onto the source bone's rest DIRECTION, which is
// right for an arm whose rest is a different pose and wrong for a foot. Both
// rests stand flat on the floor; what differs is where each rig puts its ankle
// and ball joints under that sole. On the live vendor pair (Kimodo T-pose walk
// onto the Mixamo X Bot) the ankle→ball chord sits 21° below the sole on one rig
// and 39° on the other, so making the chords agree tilted the X Bot's sole 18°
// toes-up — measured on the rendered bones at all eight ground-contact frames:
// 14.0–20.7° against the source's 1.1–5.1°.
//
// The contract pinned here, on the tracked stand-in pair with the target's toe
// dropped so the two feet disagree the way the vendor rigs do:
//
//   SOLE       the target foot's bind-up, carried by its pose, agrees with the
//              source foot's (heading-turned) on every frame;
//   CHORD      the foot's direction gap is KEPT — about the drop — because that
//              is the anatomy, and pointing it away is what tilted the sole;
//   CENSUS     on the untouched pair the builder keeps exactly the four foot and
//              toe bones, and nothing above the ankle.
//
// The vendor pair is untracked, so it is measured when present and skipped
// otherwise; the stand-in rows carry the gate in CI.
//
// REF: src/core/import/restAlignment.ts (`bonesOnFloor`, `FLOOR_CONTACT_FRACTION`,
//      the `grounded` list of `alignedLocalOffsets`); issues #1455, #866.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quaternion, Vector3, type Bone } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import { retargetClip } from './retarget';
import { alignedLocalOffsets, solveRestAlignment } from './restAlignment';
import { getBoneNameMapPreset } from './boneNameMaps';
import type { BoneSpec, GltfSkinMetadata } from '../../nodes/types';

const STANDIN = resolve(process.cwd(), 'public/fixtures/rig/standin-character.glb');
const TPOSE = resolve(process.cwd(), 'public/fixtures/anim/soma-walk-tpose.bvh');
const XBOT = resolve(process.cwd(), 'public/assets/mixamo-xbot.glb');
const KIMODO = resolve(process.cwd(), 'public/assets/kimodo-walk-tpose.bvh');
const DEG = 180 / Math.PI;
const UP = new Vector3(0, 1, 0);
const FEET = ['mixamorig_LeftFoot', 'mixamorig_RightFoot'] as const;

async function rig(path: string): Promise<BoneSpec[]> {
  const buf = readFileSync(path);
  const { json, bin } = parseGltfContainer(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  const buffers = await resolveBuffers(json, bin);
  const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rig');
  const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
  return [...projectGltfSkeleton(skin as unknown as GltfSkinMetadata).bones];
}

/** Drop a foot's toe joint by `deg` about the foot's own lateral axis, at bind:
 *  the chord steepens, the toe stays on the floor, the sole the mesh would be
 *  skinned to is unchanged. The shape the X Bot has against the Kimodo rest. */
function dropToes(bones: BoneSpec[], deg: number): BoneSpec[] {
  const { bones: three } = specToThreeSkeleton(bones);
  three[0].updateMatrixWorld(true);
  return bones.map((b) => {
    if (b.parent < 0 || !/ToeBase$/.test(b.name)) return b;
    const foot = three[b.parent];
    const footWorld = new Quaternion();
    foot.matrixWorld.decompose(new Vector3(), footWorld, new Vector3());
    const local = new Vector3(...b.position);
    const lateral = new Vector3()
      .crossVectors(local.clone().applyQuaternion(footWorld), UP)
      .normalize()
      .applyQuaternion(footWorld.clone().invert());
    local.applyAxisAngle(lateral, (-deg * Math.PI) / 180);
    return { ...b, position: [local.x, local.y, local.z] as [number, number, number] };
  });
}

const worldRot = (b: Bone) => {
  const q = new Quaternion();
  b.matrixWorld.decompose(new Vector3(), q, new Vector3());
  return q;
};

interface SoleRow {
  /** worst angle between the two soles over the clip, per foot */
  readonly soleWorst: Record<string, number>;
  /** the foot's chord direction gap, target vs heading-turned source, worst */
  readonly chordWorst: Record<string, number>;
  readonly grounded: readonly string[];
  readonly frames: number;
}

async function measure(targetBones: BoneSpec[], bvhPath: string): Promise<SoleRow> {
  const preset = getBoneNameMapPreset('somaToMixamo')!;
  const parsed = parseBvh(readFileSync(bvhPath, 'utf8'), 'walk', BVH_UNIT_SCALE_CENTIMETRES);
  const out = retargetClip({
    sourceBones: parsed.skeletonParams.bones,
    sourceClip: {
      name: parsed.clipParams.name,
      duration: parsed.clipParams.duration,
      poses: parsed.clipParams.poses,
    },
    targetBones,
    nameMap: preset.map,
  });
  if (out.restReconciliation.kind !== 'aligned') throw new Error('this pair must align');
  const heading = out.restReconciliation.rotation;

  // The grounded list from the builder itself, on fresh bones — never re-derived.
  const sFresh = specToThreeSkeleton(parsed.skeletonParams.bones).bones;
  const tFresh = specToThreeSkeleton(targetBones).bones;
  const targetToSource: Record<string, string> = {};
  for (const [s, t] of Object.entries(preset.map)) {
    if (typeof t === 'string') targetToSource[t] = s;
  }
  const present = new Set(tFresh.map((b) => b.name));
  const sNames = new Set(sFresh.map((b) => b.name));
  for (const t of Object.keys(targetToSource)) {
    if (!present.has(t) || !sNames.has(targetToSource[t])) delete targetToSource[t];
  }
  const solved = solveRestAlignment(sFresh, tFresh, targetToSource);
  if (solved.kind !== 'aligned') throw new Error('the builder must see the same alignment');
  const { grounded } = alignedLocalOffsets(sFresh, tFresh, targetToSource, solved.rotation);

  const { bones: sB } = specToThreeSkeleton(parsed.skeletonParams.bones);
  const { bones: tB } = specToThreeSkeleton(targetBones);
  sB[0].updateMatrixWorld(true);
  tB[0].updateMatrixWorld(true);
  const sBy = new Map(sB.map((b) => [b.name, b]));
  const tBy = new Map(tB.map((b) => [b.name, b]));
  const sourceOf = (t: string) => t.replace('mixamorig_', '');
  const bindS: Record<string, Quaternion> = {};
  const bindT: Record<string, Quaternion> = {};
  for (const f of FEET) {
    bindS[f] = worldRot(sBy.get(sourceOf(f))!);
    bindT[f] = worldRot(tBy.get(f)!);
  }
  const pose = (bones: Bone[], by: Map<string, Bone>, p: (typeof out.clipParams.poses)[number]) => {
    for (const [n, h] of Object.entries(p.bones)) {
      const b = by.get(n);
      if (!b) continue;
      if (h.quaternion) b.quaternion.set(...h.quaternion);
      if (h.position) b.position.set(...h.position);
    }
    bones[0].updateMatrixWorld(true);
  };
  const chord = (foot: Bone, by: Map<string, Bone>, toe: string) =>
    new Vector3()
      .setFromMatrixPosition(by.get(toe)!.matrixWorld)
      .sub(new Vector3().setFromMatrixPosition(foot.matrixWorld))
      .normalize();

  const S = parsed.clipParams.poses;
  const T = out.clipParams.poses;
  const frames = Math.min(S.length, T.length);
  const soleWorst: Record<string, number> = {};
  const chordWorst: Record<string, number> = {};
  for (let i = 0; i < frames; i++) {
    pose(sB, sBy, S[i]);
    pose(tB, tBy, T[i]);
    for (const f of FEET) {
      const sf = sBy.get(sourceOf(f))!;
      const tf = tBy.get(f)!;
      const nS = UP.clone()
        .applyQuaternion(bindS[f].clone().invert())
        .applyQuaternion(worldRot(sf))
        .applyQuaternion(heading);
      const nT = UP.clone()
        .applyQuaternion(bindT[f].clone().invert())
        .applyQuaternion(worldRot(tf));
      soleWorst[f] = Math.max(soleWorst[f] ?? 0, nS.angleTo(nT) * DEG);
      const cS = chord(sf, sBy, sourceOf(f).replace('Foot', 'ToeBase')).applyQuaternion(heading);
      const cT = chord(tf, tBy, f.replace('Foot', 'ToeBase'));
      chordWorst[f] = Math.max(chordWorst[f] ?? 0, cS.angleTo(cT) * DEG);
    }
  }
  return { soleWorst, chordWorst, grounded, frames };
}

describe('#1455 — a foot both rigs stand on keeps its sole', () => {
  it('CENSUS — on the tracked pair the builder keeps exactly the feet and toes', async () => {
    const m = await measure(await rig(STANDIN), TPOSE);
    expect([...m.grounded].sort()).toEqual([
      'mixamorig_LeftFoot',
      'mixamorig_LeftToeBase',
      'mixamorig_RightFoot',
      'mixamorig_RightToeBase',
    ]);
  });

  it('SOLE + CHORD — with the toes dropped 20°, the sole agrees every frame and the chord gap is kept', async () => {
    const DROP = 20;
    const m = await measure(dropToes(await rig(STANDIN), DROP), TPOSE);
    expect(m.frames, 'a clip with no frames would measure nothing').toBeGreaterThan(10);
    expect(m.grounded, 'the drop must leave the feet on the floor').toEqual(
      expect.arrayContaining([...FEET]),
    );
    for (const f of FEET) {
      expect(
        m.soleWorst[f],
        `${f}: the sole sits ${m.soleWorst[f].toFixed(2)}° off the source's — the chord is being ` +
          `aligned again, which is what tilted the X Bot toes-up`,
      ).toBeLessThan(0.5);
      // The positive control: the two chords really do disagree by about the
      // drop. Were they equal, the sole row above could not tell the two
      // constructions apart.
      expect(m.chordWorst[f], `${f}: the drop did not land`).toBeGreaterThan(DROP - 5);
    }
  });

  it.skipIf(!existsSync(XBOT) || !existsSync(KIMODO))(
    'VENDOR — the X Bot on the Kimodo walk keeps the source sole (untracked; skipped when absent)',
    async () => {
      const m = await measure(await rig(XBOT), KIMODO);
      for (const f of FEET) expect(m.soleWorst[f]).toBeLessThan(0.5);
    },
  );
});
