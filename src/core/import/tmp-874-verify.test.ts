import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
const DEG = 180 / Math.PI;
const q = (r: number[]) => new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2], 'XYZ'));

describe('old vs corrected clip', () => {
  it('angular difference + root path', () => {
    const bundle = JSON.parse(readFileSync(process.env.BUNDLE!, 'utf8'));
    const old = bundle.state.nodes['n_bvh_clip_2crg4_on_n_gltfSkel_74081cc8'].params.keyframes;
    const fixed = JSON.parse(readFileSync(process.env.FIXED!, 'utf8'));
    const names: string[] = fixed.boneNames;
    const kf = fixed.keyframes;

    let worst = 0, worstName = '';
    const perBone = new Map<number, number>();
    for (let i = 0; i < old.length; i++) {
      const a = q(old[i].rotation), b = q(kf[i].rotation);
      const d = 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * DEG;
      perBone.set(old[i].bone, Math.max(perBone.get(old[i].bone) ?? 0, d));
      if (d > worst) { worst = d; worstName = names[old[i].bone]; }
    }
    console.log(`worst ACTUAL angular difference between old and corrected: ${worst.toFixed(3)}° (${worstName})`);
    console.log('per-bone max: ' + [...perBone.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6)
      .map(([b, v]) => `${names[b]}=${v.toFixed(2)}°`).join(' '));

    // root world path from the corrected clip, using the bundle's own bind
    const bones = fixed.boneNames.map((n: string, i: number) => ({ name: n, i }));
    const bind = new Map<number, { p: number[]; r: number[] }>();
    const byTime = new Map<number, Map<number, any>>();
    for (const k of kf) { if (!byTime.has(k.time)) byTime.set(k.time, new Map()); byTime.get(k.time)!.set(k.bone, k); }
    const parents: number[] = JSON.parse(readFileSync(process.env.PARENTS!, 'utf8'));
    const times = [...byTime.keys()].sort((a, b) => a - b);
    const path = times.map((t) => {
      const f = byTime.get(t)!; const mats: Matrix4[] = [];
      bones.forEach((_b: any, i: number) => {
        const k = f.get(i);
        const m = new Matrix4().compose(new Vector3(...k.position), q(k.rotation), new Vector3(1, 1, 1));
        mats[i] = parents[i] >= 0 ? new Matrix4().multiplyMatrices(mats[parents[i]], m) : m;
      });
      return new Vector3().setFromMatrixPosition(mats[1]);
    });
    const travel = Math.hypot(path.at(-1)!.x - path[0].x, path.at(-1)!.z - path[0].z);
    const rise = path.at(-1)!.y - path[0].y;
    console.log(`CORRECTED root world: rise=${rise.toFixed(4)}m over ${travel.toFixed(3)}m => ${(Math.atan2(rise, travel) * DEG).toFixed(2)}°`);
  });
});
