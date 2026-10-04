// #1456 — A RETARGET AND A BAKE AGREE WITH THE WIRE AT EVERY SCENE FRAME, WHATEVER ITS KEYS.
//
// Both turn the wire into samples and join them with straight lines. Before #1456 the samples came
// from a key COUNT spread evenly across the range, and the retarget's own math (three's
// `SkeletonUtils.retargetClip`) spread them evenly again. Measured on the real nodes, a base layer
// turning the spine 0° → 90° → 0°:
//
//   linear, keys at 0 / 0.1 / 2 s     85.3° off — the key at 0.1 s was never sampled
//   constant (step), 3 keys           88.5° off — the step came out as a ramp
//   cubic, 3 keys over 2 s             8.7° off
//
// Each row here runs one source through the real `RetargetClip` (identity map onto the same rig) and
// through the real bake, and compares both with the source at every 60 fps frame. The linear rows
// also pin that a source two samples already reproduce keeps exactly its keys, so a dense clip is
// not multiplied.
//
// REF: src/nodes/wireSampleTimes.ts (the fills); src/core/import/retarget.ts (`retargetClip`, the
//      re-timing around three's resampling); src/app/animate/bakePose.ts (`bakeTimes`); issue #1456.

import { describe, expect, it } from 'vitest';
import { Quaternion } from 'three';
import { RetargetClipNode, RetargetClipParams } from './RetargetClip';
import { PoseLayerNode, PoseLayerParams } from './PoseLayer';
import { restPoseOf } from './Skeleton';
import { bakeTimes, bakedLayerParams } from '../app/animate/bakePose';
import { FRAMES_PER_SECOND } from '../core/sceneFrames';
import type { BoneSpec, PosedSkeletonValue } from './types';

const DEG = 180 / Math.PI;
const bones = (): BoneSpec[] => [
  { name: 'Hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
  { name: 'Spine', parent: 0, position: [0, 0.4, 0], rotation: [0, 0, 0] },
];
const rest = () => restPoseOf({ kind: 'Skeleton', bones: bones() });

/** A base layer keying the spine's euler rotation (degrees, XYZ) at `times`. */
function layer(
  times: readonly number[],
  values: readonly (readonly [number, number, number])[],
  easing: string,
  modifiers: readonly unknown[] = [],
): PosedSkeletonValue {
  return PoseLayerNode.evaluate(
    PoseLayerParams.parse({
      name: 'motion',
      members: [{ bone: 'Spine', rotationMode: 'XYZ' }],
      channels: [
        {
          bone: 'Spine',
          component: 'rotation',
          keyframes: times.map((time, i) => ({ time, value: values[i], easing })),
          modifiers,
        },
      ],
    }),
    { pose: rest() },
    undefined as never,
  ) as PosedSkeletonValue;
}

const turnY = (degs: readonly number[]) => degs.map((d) => [0, d, 0] as const);

function retargeted(source: PosedSkeletonValue): { posed: PosedSkeletonValue; samples: number } {
  const { out, posed } = RetargetClipNode.evaluate(
    RetargetClipParams.parse({}),
    {
      source,
      boneMap: { kind: 'BoneNameMap', name: 'same rig', map: { Hips: 'Hips', Spine: 'Spine' } },
      skeleton: { kind: 'Skeleton', bones: bones() },
    } as never,
    undefined as never,
  ) as unknown as { out: { poses: unknown[] }; posed: PosedSkeletonValue };
  return { posed, samples: out.poses.length };
}

function baked(source: PosedSkeletonValue): { posed: PosedSkeletonValue; samples: number } {
  const got = bakeTimes(source, { kind: 'every' });
  if (!got.ok) throw new Error(got.reason);
  const posed = PoseLayerNode.evaluate(
    bakedLayerParams(source, got.times, 'linear'),
    { pose: rest() },
    undefined as never,
  ) as PosedSkeletonValue;
  return { posed, samples: got.times.length };
}

/** The worst angle between the two spines over every scene frame of the source's range. */
function worstOff(source: PosedSkeletonValue, result: PosedSkeletonValue): number {
  const { start, end } = source.clip!;
  let worst = 0;
  for (
    let f = Math.ceil(start * FRAMES_PER_SECOND);
    f <= Math.floor(end * FRAMES_PER_SECOND);
    f++
  ) {
    const t = f / FRAMES_PER_SECOND;
    const a = new Quaternion(...source.sample(t)[1].quaternion);
    const b = new Quaternion(...result.sample(t)[1].quaternion);
    worst = Math.max(worst, a.angleTo(b) * DEG);
  }
  return worst;
}

const ROWS: {
  readonly label: string;
  readonly source: () => PosedSkeletonValue;
  /** Linear rows keep exactly their keys. */
  readonly samples?: number;
}[] = [
  {
    label: 'linear, keys at 0 / 0.1 / 2 s (the key three stepped over)',
    source: () => layer([0, 0.1, 2], turnY([0, 90, 0]), 'linear'),
    samples: 3,
  },
  {
    label: 'constant (step), 3 keys (a hold, then a jump on the frame)',
    source: () => layer([0, 1, 2], turnY([0, 90, 0]), 'constant'),
  },
  {
    label: 'cubic, 3 keys over 2 s (a curve between the keys)',
    source: () => layer([0, 1, 2], turnY([0, 90, 0]), 'cubic'),
  },
  {
    label: 'linear euler, two axes turning together (no slerp follows it)',
    source: () =>
      layer(
        [0, 1, 2],
        [
          [0, 0, 0],
          [45, 90, 0],
          [0, 0, 0],
        ],
        'linear',
      ),
  },
  {
    label: 'linear keys under a modifier (a generator bends the line between them)',
    source: () =>
      layer([0, 1, 2], turnY([0, 90, 0]), 'linear', [
        { type: 'generator', additive: true, coefficients: [0, 0, 30] },
      ]),
  },
  {
    label: 'linear, 61 keys at 30/s (dense: kept as it is)',
    source: () =>
      layer(
        Array.from({ length: 61 }, (_, i) => i / 30),
        turnY(Array.from({ length: 61 }, (_, i) => 90 * Math.sin((i / 30) * Math.PI))),
        'linear',
      ),
    samples: 61,
  },
];

describe('#1456 — a retarget and a bake agree with the wire at every scene frame', () => {
  for (const row of ROWS) {
    it(row.label, () => {
      const source = row.source();
      for (const [road, run] of [
        ['retarget', retargeted],
        ['bake', baked],
      ] as const) {
        const { posed, samples } = run(source);
        const off = worstOff(source, posed);
        expect(off, `${road}: ${off.toFixed(2)}° off the source at a scene frame`).toBeLessThan(
          0.01,
        );
        if (row.samples !== undefined) {
          expect(samples, `${road}: a source its keys reproduce keeps just its keys`).toBe(
            row.samples,
          );
        }
      }
    });
  }

  it('a flat two-key step (how Blender writes a channel that does not move) adds nothing', () => {
    const source = layer([0, 1], turnY([30, 30]), 'constant');
    expect(source.clip!.times).toEqual([0, 1]);
  });
});
