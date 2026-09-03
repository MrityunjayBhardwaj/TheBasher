import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { retargetClip } from './retarget';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const GLB = resolve(__dirname, '../../../public/assets/tripo-rigged.glb');
const SHELF = ['walk', 'run', 'jump', 'turn', 'crouch', 'wave'];

describe('shelf — world Y trend for all six bundled clips', () => {
  it('rise vs travel', async () => {
    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;
    console.log('clip      dur   travel(m)  Y f0     Y end    rise(m)   ramp°   rise/travel');
    for (const name of SHELF) {
      const soma = parseBvh(readFileSync(resolve(__dirname, `../../../public/assets/motion/${name}.bvh`), 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
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
      const travel = Math.hypot(pts.at(-1)!.x - pts[0].x, pts.at(-1)!.z - pts[0].z);
      const rise = pts.at(-1)!.y - pts[0].y;
      console.log(`${name.padEnd(8)} ${soma.clipParams.duration.toFixed(2)}s  ${travel.toFixed(3).padStart(7)}   ${pts[0].y.toFixed(4)}   ${pts.at(-1)!.y.toFixed(4)}   ${rise.toFixed(4).padStart(7)}   ${((Math.atan2(rise, travel) * 180) / Math.PI).toFixed(2).padStart(5)}   ${travel > 0.05 ? (rise / travel).toFixed(4) : '   n/a'}`);
    }
  });
});
