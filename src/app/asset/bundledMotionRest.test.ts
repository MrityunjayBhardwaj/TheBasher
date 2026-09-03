// Every bundled motion clip must ship with an ANATOMICAL rest (#870).
//
// The retarget reconciles a source rest against a character's bind pose only
// when the source rest carries anatomy to reconcile. A rest that lays every bone
// on a single axis carries none, the reconciliation refuses it, and the clip
// silently falls back to the older per-bone path — a stooped torso and a foot
// tipped onto its toe. That failure is invisible: the clip still loads, still
// plays, still binds.
//
// Measured as the eigen-spread of the rest's own bone directions. The third
// value is the one that matters: the less a direction set spreads into a third
// dimension, the less orientation there is in it to read.
//
// The bar is placed between two MEASURED populations, not chosen. Over these six
// clips the old rest reads 0.01991 and the converted rest 0.12362 -- identical
// within each group, because the rest is a property of the export and not of the
// motion. 0.05 sits between them with room on both sides.
//
// Note the old rest is not literally flat by THIS measure: it is taken over every
// bone's offset direction, including the hands, whereas the retarget's own
// degeneracy check looks at the mapped bones' world rest directions and does read
// ~0 there. Two different measures of the same underlying property; this one needs
// no rig, so the gate is about the CLIP alone.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vector3 } from 'three';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from '../../core/import/bvh';
import { ASSET_CATALOG } from './catalog';

/** Smallest eigenvalue of the direction scatter — 0 means the rest is flat. */
function thirdEigenvalue(dirs: Vector3[]): number {
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const d of dirs) {
    const v = [d.x, d.y, d.z];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) m[i * 3 + j] += (v[i] * v[j]) / dirs.length;
  }
  // Symmetric 3x3: eigenvalues via the closed-form trigonometric solution.
  const p1 = m[1] ** 2 + m[2] ** 2 + m[5] ** 2;
  const q = (m[0] + m[4] + m[8]) / 3;
  const p2 = (m[0] - q) ** 2 + (m[4] - q) ** 2 + (m[8] - q) ** 2 + 2 * p1;
  const p = Math.sqrt(Math.max(p2 / 6, 0));
  if (p === 0) return q;
  const b = m.map((x, i) => (x - (i % 4 === 0 ? q : 0)) / p);
  const det =
    b[0] * (b[4] * b[8] - b[5] * b[7]) -
    b[1] * (b[3] * b[8] - b[5] * b[6]) +
    b[2] * (b[3] * b[7] - b[4] * b[6]);
  const phi = Math.acos(Math.max(-1, Math.min(1, det / 2))) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  return Math.min(e1, e3, 3 * q - e1 - e3);
}

const MOTION = ASSET_CATALOG.filter((e) => e.path.endsWith('.bvh'));

describe('bundled motion clips carry an anatomical rest (#870)', () => {
  it('the catalog actually ships motion clips — otherwise this gate is vacuous', () => {
    expect(MOTION.length).toBeGreaterThan(0);
  });

  it.each(MOTION.map((e) => [e.name, e.path] as const))(
    '%s has a rest with a third dimension',
    (_name, path) => {
      const file = resolve(__dirname, '../../../public', path);
      const bvh = parseBvh(readFileSync(file, 'utf8'), 'clip', BVH_UNIT_SCALE_CENTIMETRES);
      const specs = bvh.skeletonParams.bones;
      const world: Vector3[] = specs.map((b) => new Vector3(...b.position));
      for (let i = 0; i < specs.length; i++) {
        const p = specs[i].parent;
        if (p >= 0) world[i] = world[i].clone().add(world[p]);
      }
      const dirs: Vector3[] = [];
      for (let i = 0; i < specs.length; i++) {
        const p = specs[i].parent;
        if (p < 0) continue;
        const d = world[i].clone().sub(world[p]);
        if (d.length() > 1e-9) dirs.push(d.normalize());
      }
      expect(dirs.length, 'no bone directions read — the gate would be vacuous').toBeGreaterThan(
        10,
      );
      const third = thirdEigenvalue(dirs);
      expect(
        third,
        `third eigenvalue ${third.toFixed(5)} — the old flat-rest population reads 0.01991, the converted one 0.12362`,
      ).toBeGreaterThan(0.05);
    },
  );
});
