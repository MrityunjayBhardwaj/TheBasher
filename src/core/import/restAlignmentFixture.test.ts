// The whole-rig reconciliation, on real fixture data rather than synthetic bones.
//
// `restAlignment.test.ts` proves the solver; `retarget.test.ts` proves the
// wiring. Neither runs on a rig pair shaped like the ones this actually ships
// against, and the only end-to-end evidence for the reconciliation came from 58
// MB of untracked vendor output that no runner ever sees.
//
// So: the tracked stand-in character, driven by the SAME walk over two different
// rests. The pair is the experiment — one clip is refused and one accepted, and
// the motion is identical between them, so anything that differs downstream is
// attributable to the rest and to nothing else.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quaternion, Vector3, type Bone } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import { retargetClip, resolveNameMapToSource, resolveNameMapToTarget } from './retarget';
import { solveRestAlignment } from './restAlignment';
import { getBoneNameMapPreset } from './boneNameMaps';
import type { BoneSpec, GltfSkinMetadata } from '../../nodes/types';

const RIG = resolve(process.cwd(), 'public/fixtures/rig/standin-character.glb');
const DEGENERATE = resolve(process.cwd(), 'public/fixtures/anim/soma-walk.bvh');
const TPOSE = resolve(process.cwd(), 'public/fixtures/anim/soma-walk-tpose.bvh');
const DEG = 180 / Math.PI;

async function targetRig(): Promise<readonly BoneSpec[]> {
  const buf = readFileSync(RIG);
  const { json, bin } = parseGltfContainer(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  const buffers = await resolveBuffers(json, bin);
  const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'standin');
  const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
  return projectGltfSkeleton(skin as unknown as GltfSkinMetadata).bones;
}

const clip = (path: string) =>
  parseBvh(readFileSync(path, 'utf8'), 'walk', BVH_UNIT_SCALE_CENTIMETRES);

const worldRot = (b: Bone): Quaternion => {
  const p = new Vector3();
  const r = new Quaternion();
  const s = new Vector3();
  b.matrixWorld.decompose(p, r, s);
  return r;
};

function twistDeg(q: Quaternion, axis: Vector3): number {
  const a = axis.clone().normalize();
  const s = new Vector3(q.x, q.y, q.z).dot(a);
  if (s * s + q.w * q.w < 1e-16) return NaN;
  let d = 2 * Math.atan2(s, q.w) * DEG;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

describe('the two rests, on the tracked stand-in pair', () => {
  it('point every bone the same way, so the rest is the only difference between them', () => {
    // Without this the pair proves nothing: two clips that moved differently
    // would explain any downstream difference just as well as the rest does.
    //
    // DIRECTIONS, not positions. The generator aims each bone at a world
    // direction that does not depend on the rest, so the two clips point the
    // same way at every frame — but a rest change moves where limbs ATTACH (a
    // joint hangs off its parent's rest offset), so joint positions legitimately
    // differ. Asserting positions here failed at 0.37 m and the assertion was
    // wrong, not the fixture.
    const a = clip(DEGENERATE);
    const b = clip(TPOSE);
    const worldOf = (parsed: ReturnType<typeof clip>) => {
      const { bones } = specToThreeSkeleton(parsed.skeletonParams.bones);
      const times = [...new Set(parsed.clipParams.keyframes.map((k) => k.time))].sort(
        (x, y) => x - y,
      );
      const byTime = new Map<number, typeof parsed.clipParams.keyframes>();
      for (const k of parsed.clipParams.keyframes)
        byTime.set(k.time, [...(byTime.get(k.time) ?? []), k]);
      const out = new Map<string, Vector3[]>();
      for (const t of times) {
        for (const k of byTime.get(t) ?? []) {
          const bone = bones[k.bone];
          if (!bone) continue;
          bone.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          bone.position.set(k.position[0], k.position[1], k.position[2]);
        }
        bones[0].updateMatrixWorld(true);
        for (const bone of bones) {
          const child = bone.children.find((c) => (c as Bone).isBone) as Bone | undefined;
          if (!child) continue;
          const d = new Vector3()
            .setFromMatrixPosition(child.matrixWorld)
            .sub(new Vector3().setFromMatrixPosition(bone.matrixWorld));
          if (d.lengthSq() < 1e-18) continue;
          out.set(bone.name, [...(out.get(bone.name) ?? []), d.normalize()]);
        }
      }
      return out;
    };
    const wa = worldOf(a);
    const wb = worldOf(b);
    let worst = 0;
    let worstName = '';
    let compared = 0;
    for (const [name, pa] of wa) {
      const pb = wb.get(name);
      if (!pb || pb.length !== pa.length) continue;
      for (let i = 0; i < pa.length; i++) {
        const angle = pa[i].angleTo(pb[i]) * DEG;
        if (angle > worst) {
          worst = angle;
          worstName = name;
        }
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(worst, `the two rests must carry the same walk (${worstName})`).toBeLessThan(1);
  });

  it('refuses the degenerate rest and accepts the anatomical one', async () => {
    const target = await targetRig();
    const preset = getBoneNameMapPreset('somaToMixamo')!;
    for (const [label, path, expected] of [
      ['degenerate', DEGENERATE, false],
      ['anatomical', TPOSE, true],
    ] as const) {
      const parsed = clip(path);
      const nameMap = resolveNameMapToTarget(
        resolveNameMapToSource(preset.map, parsed.skeletonParams.bones),
        target,
      );
      const targetToSource: Record<string, string> = {};
      for (const [s, t] of Object.entries(nameMap)) targetToSource[t] = s;
      const alignment = solveRestAlignment(
        specToThreeSkeleton(parsed.skeletonParams.bones).bones,
        specToThreeSkeleton(target).bones,
        targetToSource,
      );
      expect(alignment !== null, `${label} rest`).toBe(expected);
    }
  });

  it('brings a planted foot back to its own bind, which the degenerate rest cannot', async () => {
    // The null is anatomy rather than anything we chose: at the frames where a
    // foot is lowest, its roll from the target's own bind must be near zero,
    // because a planted foot has its sole down. Contact frames are read from the
    // SOURCE clip — identical between the two by the first test here — so the
    // measurement cannot be contaminated by the retarget under test.
    const target = await targetRig();
    const preset = getBoneNameMapPreset('somaToMixamo')!;

    const rollAtContact = (path: string): Record<string, number> => {
      const parsed = clip(path);
      const nameMap = resolveNameMapToTarget(
        resolveNameMapToSource(preset.map, parsed.skeletonParams.bones),
        target,
      );
      const targetToSource: Record<string, string> = {};
      for (const [s, t] of Object.entries(nameMap)) targetToSource[t] = s;

      const { bones: bind } = specToThreeSkeleton(target);
      bind[0].updateMatrixWorld(true);
      const bindRot = new Map<string, Quaternion>();
      for (const b of bind) bindRot.set(b.name, worldRot(b));
      const mappedChild = (b: Bone): Bone | null => {
        const stack = [...b.children];
        while (stack.length) {
          const n = stack.shift() as Bone;
          if (!n.isBone) continue;
          if (targetToSource[n.name] !== undefined) return n;
          stack.push(...(n.children as Bone[]));
        }
        return null;
      };
      const restLocal = new Map<string, Vector3>();
      for (const b of bind) {
        const c = mappedChild(b);
        if (!c) continue;
        const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
        const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
        const d = there.sub(here);
        if (d.lengthSq() < 1e-18) continue;
        restLocal.set(b.name, d.applyQuaternion(worldRot(b).invert()).normalize());
      }

      // contact frames, from the source
      const { bones: sp } = specToThreeSkeleton(parsed.skeletonParams.bones);
      const times = [...new Set(parsed.clipParams.keyframes.map((k) => k.time))].sort(
        (x, y) => x - y,
      );
      const byTime = new Map<number, typeof parsed.clipParams.keyframes>();
      for (const k of parsed.clipParams.keyframes)
        byTime.set(k.time, [...(byTime.get(k.time) ?? []), k]);
      const sourceY = new Map<string, number[]>();
      for (const t of times) {
        for (const k of byTime.get(t) ?? []) {
          const b = sp[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          b.position.set(k.position[0], k.position[1], k.position[2]);
        }
        sp[0].updateMatrixWorld(true);
        for (const b of sp)
          sourceY.set(b.name, [
            ...(sourceY.get(b.name) ?? []),
            new Vector3().setFromMatrixPosition(b.matrixWorld).y,
          ]);
      }

      const out = retargetClip({
        sourceBones: parsed.skeletonParams.bones,
        sourceClip: {
          name: parsed.clipParams.name,
          duration: parsed.clipParams.duration,
          keyframes: parsed.clipParams.keyframes,
        },
        targetBones: target,
        nameMap: preset.map,
      });
      const { bones: pose } = specToThreeSkeleton(target);
      const outTimes = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort(
        (x, y) => x - y,
      );
      const outBy = new Map<number, typeof out.clipParams.keyframes>();
      for (const k of out.clipParams.keyframes)
        outBy.set(k.time, [...(outBy.get(k.time) ?? []), k]);
      const roll = new Map<string, number[]>();
      for (const t of outTimes) {
        for (const k of outBy.get(t) ?? []) {
          const b = pose[k.bone];
          if (!b) continue;
          b.rotation.set(k.rotation[0], k.rotation[1], k.rotation[2], 'XYZ');
          b.position.set(k.position[0], k.position[1], k.position[2]);
        }
        pose[0].updateMatrixWorld(true);
        for (const b of pose) {
          const d = restLocal.get(b.name);
          const bq = bindRot.get(b.name);
          if (!d || !bq) continue;
          roll.set(b.name, [
            ...(roll.get(b.name) ?? []),
            twistDeg(bq.clone().invert().multiply(worldRot(b)), d),
          ]);
        }
      }

      const result: Record<string, number> = {};
      for (const targetFoot of [...restLocal.keys()].filter((n) => /Foot$/.test(n))) {
        const src = targetToSource[targetFoot];
        const ys = sourceY.get(src);
        const rs = roll.get(targetFoot);
        if (!ys || !rs) continue;
        const contact = ys
          .map((v, i) => ({ v, i }))
          .sort((x, y) => x.v - y.v)
          .slice(0, 6)
          .map((r) => r.i)
          .filter((i) => i < rs.length);
        if (!contact.length) continue;
        result[targetFoot] = contact.reduce((acc, i) => acc + Math.abs(rs[i]), 0) / contact.length;
      }
      return result;
    };

    const degenerate = rollAtContact(DEGENERATE);
    const anatomical = rollAtContact(TPOSE);
    expect(Object.keys(anatomical).length, 'the rig must have feet to measure').toBeGreaterThan(0);

    for (const foot of Object.keys(anatomical)) {
      // The bar is generous on purpose — this gates the RECONCILIATION, not the
      // per-bone residual that is still outstanding. What it must catch is the
      // reconciliation silently ceasing to happen, which puts these back with
      // the degenerate column.
      expect(anatomical[foot], `${foot} at ground contact, anatomical rest`).toBeLessThan(30);
      expect(
        anatomical[foot],
        `${foot}: the anatomical rest must beat the degenerate one, which is the whole claim`,
      ).toBeLessThan(degenerate[foot]);
    }
  });
});
