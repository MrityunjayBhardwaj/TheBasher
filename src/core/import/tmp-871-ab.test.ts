// A/B — same motion, rest is the ONLY variable. Plus: what R does to "up".
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { retargetClip } from './retarget';
import { solveRestAlignment } from './restAlignment';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const A = resolve(__dirname, '../../../public/assets/kimodo-walk.bvh');       // degenerate rest
const B = resolve(__dirname, '../../../public/assets/kimodo-walk-tpose.bvh'); // anatomical rest
const W = resolve(__dirname, '../../../public/assets/motion/walk.bvh');       // bundled (anatomical)
const DEG = 180 / Math.PI;

describe('A/B — rest as the only variable', () => {
  it('measures world Y trend for each', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;

    for (const [label, CLIP] of [['A degenerate', A], ['B anatomical (same motion)', B], ['W bundled walk', W]] as const) {
      const soma = parseBvh(readFileSync(CLIP, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
      const out = retargetClip({
        sourceBones: soma.skeletonParams.bones,
        sourceClip: { name: soma.clipParams.name, duration: soma.clipParams.duration, keyframes: soma.clipParams.keyframes },
        targetBones: target.bones,
        nameMap: preset.map,
      });
      const times = [...new Set(out.clipParams.keyframes.map((k) => k.time))].sort((a, b) => a - b);
      const byTime = new Map<number, Map<number, (typeof out.clipParams.keyframes)[number]>>();
      for (const k of out.clipParams.keyframes) {
        if (!byTime.has(k.time)) byTime.set(k.time, new Map());
        byTime.get(k.time)!.set(k.bone, k);
      }
      const pts = times.map((t) => {
        const frame = byTime.get(t)!;
        const mats: Matrix4[] = [];
        target.bones.forEach((b, i) => {
          const k = frame.get(i);
          const p = new Vector3(...(k?.position ?? b.position));
          const q = new Quaternion().setFromEuler(new Euler(...(k?.rotation ?? b.rotation), 'XYZ'));
          const local = new Matrix4().compose(p, q, new Vector3(1, 1, 1));
          mats[i] = b.parent >= 0 ? new Matrix4().multiplyMatrices(mats[b.parent], local) : local;
        });
        return new Vector3().setFromMatrixPosition(mats[1]);
      });
      const ys = pts.map((v) => v.y);
      const n = ys.length, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0, den = 0;
      ys.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
      const horiz = Math.hypot(pts.at(-1)!.x - pts[0].x, pts.at(-1)!.z - pts[0].z);
      const rise = (num / den) * (n - 1);
      console.log(`\n${label}  (${CLIP.split('/').pop()})`);
      console.log(`  world Y: f0=${ys[0].toFixed(4)} end=${ys.at(-1)!.toFixed(4)} RISE=${rise.toFixed(4)} m over ${horiz.toFixed(3)} m travelled  => ${(Math.atan2(rise, horiz) * DEG).toFixed(2)}° ramp`);
    }
  });

  it('reports the rest-alignment rotation R', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    console.log('\nsolveRestAlignment signature:', solveRestAlignment.length, 'args');
  });
});
