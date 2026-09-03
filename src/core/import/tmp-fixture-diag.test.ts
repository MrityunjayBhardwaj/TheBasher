import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Euler, Matrix4, Quaternion, Vector3, type Bone } from 'three';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { specToThreeSkeleton } from './threeAdapter';
import { resolveNameMapToSource, resolveNameMapToTarget } from './retarget';
import { bestRigidRotation } from './restAlignment';
import { getBoneNameMapPreset } from './boneNameMaps';
import type { GltfSkinMetadata } from '../../nodes/types';

const RIG = resolve(process.cwd(), 'public/fixtures/rig/standin-character.glb');
const TPOSE = resolve(process.cwd(), 'public/fixtures/anim/soma-walk-tpose.bvh');
const DEG = 180 / Math.PI;

describe('why is the new fixture refused?', () => {
  it('prints the rest directions side by side', async () => {
    const buf = readFileSync(RIG);
    const { json, bin } = parseGltfContainer(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'standin');
    const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skin as unknown as GltfSkinMetadata).bones;
    const parsed = parseBvh(readFileSync(TPOSE, 'utf8'), 'w', BVH_UNIT_SCALE_CENTIMETRES);
    const preset = getBoneNameMapPreset('somaToMixamo')!;
    const nameMap = resolveNameMapToTarget(
      resolveNameMapToSource(preset.map, parsed.skeletonParams.bones),
      target,
    );
    const targetToSource: Record<string, string> = {};
    for (const [s, t] of Object.entries(nameMap)) targetToSource[t] = s;
    console.log(`  mapped bones: ${Object.keys(targetToSource).length}`);
    console.log(`  target bones: ${target.map((b) => b.name).join(', ')}`);

    const mappedChild = (b: Bone, cov: (n: string) => boolean): Bone | null => {
      const stack = [...b.children];
      while (stack.length) {
        const n = stack.shift() as Bone;
        if (!n.isBone) continue;
        if (cov(n.name)) return n;
        stack.push(...(n.children as Bone[]));
      }
      return null;
    };
    const dirs = (bones: Bone[], cov: (n: string) => boolean) => {
      bones[0].updateMatrixWorld(true);
      const out = new Map<string, Vector3>();
      for (const b of bones) {
        const c = mappedChild(b, cov);
        if (!c) continue;
        const here = new Vector3().setFromMatrixPosition(b.matrixWorld);
        const there = new Vector3().setFromMatrixPosition(c.matrixWorld);
        const d = there.sub(here);
        if (d.lengthSq() > 1e-18) out.set(b.name, d.normalize());
      }
      return out;
    };
    const srcNames = new Set(Object.values(targetToSource));
    const sDirs = dirs(specToThreeSkeleton(parsed.skeletonParams.bones).bones, (n) => srcNames.has(n));
    const tDirs = dirs(specToThreeSkeleton(target).bones, (n) => targetToSource[n] !== undefined);
    const from: Vector3[] = [];
    const to: Vector3[] = [];
    const names: string[] = [];
    for (const [tn, sn] of Object.entries(targetToSource)) {
      const a = sDirs.get(sn);
      const b = tDirs.get(tn);
      if (a && b) { from.push(a); to.push(b); names.push(tn); }
    }
    const f = (v: Vector3) => `(${v.x.toFixed(2).padStart(5)},${v.y.toFixed(2).padStart(5)},${v.z.toFixed(2).padStart(5)})`;
    console.log('  bone                     source rest        target bind        angle');
    for (let i = 0; i < names.length; i++) {
      console.log(`  ${names[i].replace('mixamorig_', '').padEnd(16)} ${f(from[i])}  ${f(to[i])}  ${(from[i].angleTo(to[i]) * DEG).toFixed(0).padStart(4)}°`);
    }
    const R = bestRigidRotation(from, to);
    const rms = (q: Quaternion) => Math.sqrt(from.reduce((a, d, i) => a + (d.clone().applyQuaternion(q).angleTo(to[i]) * DEG) ** 2, 0) / from.length);
    const e = new Euler().setFromRotationMatrix(new Matrix4().makeRotationFromQuaternion(R), 'YXZ');
    console.log(`  pairs=${from.length}  before=${rms(new Quaternion()).toFixed(1)}°  after=${rms(R).toFixed(1)}°  (yaw ${(e.y * DEG).toFixed(1)}, pitch ${(e.x * DEG).toFixed(1)}, roll ${(e.z * DEG).toFixed(1)})`);
    const res = names.map((n, i) => ({ n: n.replace('mixamorig_', ''), a: from[i].clone().applyQuaternion(R).angleTo(to[i]) * DEG })).sort((a, b) => b.a - a.a);
    console.log('  worst residuals: ' + res.slice(0, 6).map((r) => `${r.n} ${r.a.toFixed(0)}°`).join(', '));
  }, 60000);
});
