// Does relaxing the tracked stand-in's arms reproduce the tilt end to end?
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { retargetClip } from './retarget';
import { getBoneNameMapPreset } from './boneNameMaps';
import type { BoneSpec, GltfSkinMetadata } from '../../nodes/types';

const RIG = resolve(process.cwd(), 'public/fixtures/rig/standin-character.glb');
const TPOSE = resolve(process.cwd(), 'public/fixtures/anim/soma-walk-tpose.bvh');
const LABEL = process.env.VARIANT ?? 'current';

describe(`relaxed-arm stand-in [${LABEL}]`, () => {
  it('grade', async () => {
    const buf = readFileSync(RIG);
    const { json, bin } = parseGltfContainer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'standin');
    const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const base = projectGltfSkeleton(skin as unknown as GltfSkinMetadata).bones;
    console.log('bones:', base.map((b) => b.name).join(' '));

    // Relax the arms: rotate each arm/forearm offset DOWN about the world X-ish
    // axis by 21 deg, the way the live target's bind hangs.
    const relax = (deg: number) => (b: BoneSpec): BoneSpec => {
      if (!/ToeBase/i.test(b.name)) return b;
      const v = new Vector3(...b.position);
      const len = v.length();
      if (len < 1e-9) return b;
      v.normalize();
      // tip it toward -Y, preserving length
      const d = (deg * Math.PI) / 180;
      const down = new Vector3(v.x * Math.cos(d), v.y * Math.cos(d) - Math.sin(d), v.z * Math.cos(d)).normalize();
      return { ...b, position: [down.x * len, down.y * len, down.z * len] as [number, number, number] };
    };
    for (const deg of [0, -27]) {
      const target = base.map(relax(deg));
      const p = parseBvh(readFileSync(TPOSE, 'utf8'), 'walk', BVH_UNIT_SCALE_CENTIMETRES);
      const preset = getBoneNameMapPreset('somaToMixamo')!;
      const out = retargetClip({
        sourceBones: p.skeletonParams.bones,
        sourceClip: { name: p.clipParams.name, duration: p.clipParams.duration, keyframes: p.clipParams.keyframes },
        targetBones: target, nameMap: preset.map,
      });
      const times = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const by = new Map<number, Map<number, (typeof out.clipParams.keyframes)[number]>>();
      for (const k of out.clipParams.keyframes) { if (!by.has(k.time)) by.set(k.time, new Map()); by.get(k.time)!.set(k.bone, k); }
      const pts = times.map((t) => {
        const f = by.get(t)!; const mats: Matrix4[] = [];
        target.forEach((b, i) => {
          const k = f.get(i);
          const pos = new Vector3(...(k?.position ?? b.position));
          const q = new Quaternion().setFromEuler(new Euler(...(k?.rotation ?? b.rotation), 'XYZ'));
          const l = new Matrix4().compose(pos, q, new Vector3(1, 1, 1));
          mats[i] = b.parent >= 0 ? new Matrix4().multiplyMatrices(mats[b.parent], l) : l;
        });
        return new Vector3().setFromMatrixPosition(mats[1]);
      });
      const travel = Math.hypot(pts.at(-1)!.x - pts[0].x, pts.at(-1)!.z - pts[0].z);
      const rise = pts.at(-1)!.y - pts[0].y;
      console.log(`[${LABEL}] toe tilt ${deg}°: travel=${travel.toFixed(4)}m rise=${rise.toFixed(5)}m grade=${(rise / travel).toExponential(4)}`);
    }
  });
});
