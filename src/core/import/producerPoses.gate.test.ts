// #1432 — a motion producer hands on the rotation the file holds, not an euler copy of it.
//
// The BVH and FBX parsers read three's quaternion tracks. Until #1432 they wrote each one out as an
// XYZ euler triple and a clip turned it back into a quaternion, so every rotation took a
// quaternion → euler → quaternion round trip. This gate measures each parsed pose against the
// rotation three's loader computed, kept at full precision.
//
// THE REFERENCE. three stores track values as float32 (`KeyframeTrack.ValueBufferType`); the loader
// composes each rotation in float64 first. Switching the buffer type to Float64Array keeps that
// value, so the same parse run twice gives the stored pose and the rotation it stands for.
//
// THE BOUND, measured 2026-10-02 over the 18 tracked BVH/FBX files: the poses read straight off the
// tracks sit within 3.44e-8 of the reference per component, the float32 rounding of a unit
// quaternion. The road they replaced sat at 1.1e-7 to 4.0e-7 on the motion library: it turned the
// float32 quaternion, which is not quite unit, into euler as if it were, and that error survives the
// trip back. 5e-8 holds the first and refuses the second (an inverse edit restoring that road reds
// this row).
//
// WHAT IT DOES NOT SEE: a round trip through euler of a quaternion already made unit stays under the
// bound (an inverse edit doing exactly that stays green). This row pins fidelity to the file, not the
// absence of a conversion; `quaternionToEulerDoors.gate.test.ts` is where a new conversion is counted.
//
// REF: src/core/import/threeAdapter.ts (`clipToPoses`); issue #1432.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KeyframeTrack } from 'three';
import { parseBvh } from './bvh';
import { parseFbx } from './fbx';
import type { MotionPose } from '../../nodes/types';
import { alignedQuat } from '../../test-utils/poseSamples';

const BOUND = 5e-8;

type Buffers = { ValueBufferType: unknown; TimeBufferType: unknown };
const proto = KeyframeTrack.prototype as unknown as Buffers;
const float32 = { value: proto.ValueBufferType, time: proto.TimeBufferType };

afterEach(() => {
  proto.ValueBufferType = float32.value;
  proto.TimeBufferType = float32.time;
});

function parsePoses(rel: string): readonly MotionPose[] {
  const abs = resolve(process.cwd(), rel);
  if (rel.endsWith('.bvh')) return parseBvh(readFileSync(abs, 'utf8'), 'clip').clipParams.poses;
  const buf = readFileSync(abs);
  return parseFbx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
    .clipParams.poses;
}

/** The same parse with three keeping its track values in float64. */
function referencePoses(rel: string): readonly MotionPose[] {
  proto.ValueBufferType = Float64Array;
  proto.TimeBufferType = Float64Array;
  try {
    return parsePoses(rel);
  } finally {
    proto.ValueBufferType = float32.value;
    proto.TimeBufferType = float32.time;
  }
}

/** #1434 — the tracked files the FBX reader refuses whole, by the reason it gives. */
const REFUSED: Record<string, string> = {
  'src/core/import/__fixtures__/rigged-scene-shared-mesh-blender-default.fbx':
    'FBX nodes "Plane" and "PlaneB" share one mesh, which an import does not bring across yet (#1061).',
  'src/core/import/__fixtures__/rigless-hierarchy-blender-default.fbx':
    'FBX contains no skeleton or skinned mesh — nothing to import.',
  'src/core/import/__fixtures__/unskinned-edges-blender-default.fbx':
    'FBX node "Cam" is a camera, which an import does not bring across yet (#1319).',
};

describe('a parsed pose holds the rotation the file holds (#1432)', () => {
  const tracked = execFileSync('git', ['ls-files', '*.bvh', '*.fbx'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  it('every tracked BVH and FBX, within float32 of the loader’s own rotation', () => {
    // The denominator: a glob that matched nothing would pass over an empty set.
    expect(tracked.length).toBeGreaterThanOrEqual(18);
    let compared = 0;
    let worst = 0;
    let worstAt = '';
    // #1434 — a file the reader refuses holds no pose to compare. Each is named with its reason, so
    // a file that starts refusing (or stops) reds here instead of leaving the sweep quietly.
    const refused: Record<string, string> = {};
    for (const rel of tracked) {
      let got: readonly MotionPose[];
      try {
        got = parsePoses(rel);
      } catch (error) {
        refused[rel] = (error as Error).message;
        continue;
      }
      const want = referencePoses(rel);
      // Times are float32 too, so poses pair by order; both runs hold the same number.
      expect(got.length, rel).toBe(want.length);
      got.forEach((pose, i) => {
        for (const [name, held] of Object.entries(pose.bones)) {
          const ref = want[i].bones[name]?.quaternion;
          expect(ref, `${rel} pose ${i} ${name}`).toBeDefined();
          const q = alignedQuat(held.quaternion!, ref!);
          const d = Math.max(...q.map((v, c) => Math.abs(v - ref![c])));
          if (d > worst) [worst, worstAt] = [d, `${rel} pose ${i} ${name}`];
          compared++;
        }
      });
    }
    expect(refused).toEqual(REFUSED);
    expect(worst, `worst at ${worstAt}`).toBeLessThan(BOUND);
    // At least: the six library motions alone hold 7,000+ bone poses each.
    expect(compared).toBeGreaterThan(6 * 7000);
  });

  it('the reference really is a different value: the float32 poses are not it exactly', () => {
    // Without this, a buffer switch that did nothing would compare the parse with itself and
    // pass any bound.
    const rel = 'public/assets/motion/walk.bvh';
    const got = parsePoses(rel);
    const want = referencePoses(rel);
    const differs = got.some((pose, i) =>
      Object.entries(pose.bones).some(([name, held]) =>
        held.quaternion!.some((v, c) => v !== want[i].bones[name].quaternion![c]),
      ),
    );
    expect(differs).toBe(true);
  });
});
