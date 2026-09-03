import { describe, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { bestRigidRotation, bestRotationAboutAxis, solveRestAlignment } from './restAlignment';
import { specToThreeSkeleton } from './threeAdapter';
import type { BoneSpec } from '../../nodes/types';

const DEG = 180 / Math.PI;
const UP = new Vector3(0, 1, 0);

const SRC: BoneSpec[] = [
  { name: 's_hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
  { name: 's_spine', parent: 0, position: [0, 0.2, 0], rotation: [0, 0, 0] },
  { name: 's_neck', parent: 1, position: [0, 0.2, 0], rotation: [0, 0, 0] },
  { name: 's_head', parent: 2, position: [0, 0.15, 0], rotation: [0, 0, 0] },
  { name: 's_shoulder', parent: 1, position: [0.1, 0.1, 0], rotation: [0, 0, 0] },
  { name: 's_arm', parent: 4, position: [0.2, 0, 0], rotation: [0, 0, 0] },
  { name: 's_hand', parent: 5, position: [0.2, 0, 0], rotation: [0, 0, 0] },
  { name: 's_upleg', parent: 0, position: [0.1, -0.05, 0], rotation: [0, 0, 0] },
  { name: 's_leg', parent: 7, position: [0, -0.4, 0], rotation: [0, 0, 0] },
  { name: 's_foot', parent: 8, position: [0, -0.4, 0], rotation: [0, 0, 0] },
  { name: 's_toe', parent: 9, position: [0, 0, 0.15], rotation: [0, 0, 0] },
];
// Target: same rig yawed a quarter turn, but with a RELAXED-T bind — arms hang
// below horizontal and the toe points up a little, exactly the shape the live
// pair has. Yaw maps (x,y,z) -> (z,y,-x).
const relaxed = (b: BoneSpec): BoneSpec => {
  let p: [number, number, number] = [b.position[2], b.position[1], -b.position[0]];
  if (b.name === 's_arm' || b.name === 's_hand') p = [p[0], -0.076, p[2]];  // ~21 deg down
  if (b.name === 's_toe') p = [p[0], 0.017, p[2]];                          // ~6 deg up
  return { ...b, name: b.name.replace('s_', 't_'), position: p };
};
const TGT: BoneSpec[] = SRC.map(relaxed);
const MAP: Record<string, string> = Object.fromEntries(SRC.map((b) => [b.name.replace('s_', 't_'), b.name]));

describe('synthetic tempt-a-tilt pair', () => {
  it('reports both solves', () => {
    const src = specToThreeSkeleton(SRC).bones;
    const trg = specToThreeSkeleton(TGT).bones;
    const a = solveRestAlignment(src, trg, MAP);
    console.log('solveRestAlignment ->', a ? `accepted before=${a.disagreementBefore.toFixed(2)} after=${a.disagreementAfter.toFixed(2)} tilt=${(UP.clone().applyQuaternion(a.rotation).angleTo(UP) * DEG).toFixed(3)}°` : 'REFUSED');
    // rebuild the direction pairs the way the solver does, to run the control
    const dirs = (bones: ReturnType<typeof specToThreeSkeleton>['bones'], covered: (n: string) => boolean) => {
      bones[0].updateMatrixWorld(true);
      const out = new Map<string, Vector3>();
      for (const b of bones) {
        const stack = [...b.children];
        let child: typeof b | null = null;
        while (stack.length) { const n = stack.shift() as typeof b; if (covered(n.name)) { child = n; break; } stack.push(...(n.children as typeof stack)); }
        if (!child) continue;
        const d = new Vector3().setFromMatrixPosition(child.matrixWorld).sub(new Vector3().setFromMatrixPosition(b.matrixWorld));
        if (d.lengthSq() < 1e-18) continue;
        out.set(b.name, d.normalize());
      }
      return out;
    };
    const sd = dirs(src, (n) => Object.values(MAP).includes(n));
    const td = dirs(trg, (n) => MAP[n] !== undefined);
    const from: Vector3[] = [], to: Vector3[] = [];
    for (const [t, s] of Object.entries(MAP)) { const S = sd.get(s), T = td.get(t); if (S && T) { from.push(S); to.push(T); } }
    const rms = (q: Quaternion) => Math.sqrt(from.reduce((acc, v, i) => acc + (v.clone().applyQuaternion(q).angleTo(to[i]) * DEG) ** 2, 0) / from.length);
    const free = bestRigidRotation(from, to);
    const lvl = bestRotationAboutAxis(from, to, UP);
    console.log(`pairs=${from.length}`);
    console.log(`  UNCONSTRAINED tilt=${(UP.clone().applyQuaternion(free).angleTo(UP) * DEG).toFixed(3)}°  rms=${rms(free).toFixed(3)}°`);
    console.log(`  ABOUT-UP      tilt=${(UP.clone().applyQuaternion(lvl).angleTo(UP) * DEG).toFixed(3)}°  rms=${rms(lvl).toFixed(3)}°  yaw=${(2 * Math.acos(Math.min(1, Math.abs(lvl.w))) * DEG).toFixed(3)}°`);
    console.log(`  identity rms=${rms(new Quaternion()).toFixed(3)}°`);
  });
});
