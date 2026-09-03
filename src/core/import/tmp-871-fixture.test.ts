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
import type { GltfSkinMetadata } from '../../nodes/types';

const RIG = resolve(process.cwd(), 'public/fixtures/rig/standin-character.glb');
const CLIPS = { degenerate: 'public/fixtures/anim/soma-walk.bvh', anatomical: 'public/fixtures/anim/soma-walk-tpose.bvh' };
const LABEL = process.env.VARIANT ?? 'current';

describe(`fixture grade [${LABEL}]`, () => {
  it('rise vs travel on the tracked pair', async () => {
    const buf = readFileSync(RIG);
    const { json, bin } = parseGltfContainer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'standin');
    const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skin as unknown as GltfSkinMetadata).bones;
    const preset = getBoneNameMapPreset('somaToMixamo')!;
    for (const [label, rel] of Object.entries(CLIPS)) {
      const p = parseBvh(readFileSync(resolve(process.cwd(), rel), 'utf8'), 'walk', BVH_UNIT_SCALE_CENTIMETRES);
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
      console.log(`[${LABEL}] ${label.padEnd(11)} travel=${travel.toFixed(4)}m rise=${rise.toFixed(4)}m grade=${(rise / travel).toFixed(4)} (${(Math.atan2(rise, travel) * 180 / Math.PI).toFixed(2)}°)`);
    }
  });
});
