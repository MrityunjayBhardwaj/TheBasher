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
// #1457 adds the layers ABOVE a base: a layer keyed between the base's keys (what a fold reads at
// the top of a chain — before, 2 keys and 90° off), an override at half weight and an additive
// rotation over a moving base (blends no slerp follows), and the cases that must keep the base's
// samples: a full-weight static override and an additive position.
//
// REF: src/nodes/wireSampleTimes.ts (the fills, `layeredWireRange`); src/nodes/PoseLayer.ts
//      (`layerBlendOf`); src/core/import/retarget.ts (`retargetClip`, the re-timing around three's
//      resampling); src/app/animate/bakePose.ts (`bakeTimes`); issues #1456, #1457.

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

/** #1457 — a layer ABOVE `pose`, with the given params: the shape a fold or a hand-pose takes. */
function onTop(pose: PosedSkeletonValue, params: Record<string, unknown>): PosedSkeletonValue {
  return PoseLayerNode.evaluate(
    PoseLayerParams.parse({ name: 'above', ...params }),
    { pose },
    undefined as never,
  ) as PosedSkeletonValue;
}
/** A base layer turning the HIPS, keyed only at its ends: what an upper layer sits on. */
const hipsBase = (degs: readonly [number, number]) =>
  PoseLayerNode.evaluate(
    PoseLayerParams.parse({
      name: 'base',
      members: [{ bone: 'Hips', rotationMode: 'XYZ' }],
      channels: [
        {
          bone: 'Hips',
          component: 'rotation',
          keyframes: [
            { time: 0, value: [0, degs[0], 0], easing: 'linear' },
            { time: 2, value: [0, degs[1], 0], easing: 'linear' },
          ],
        },
      ],
    }),
    { pose: rest() },
    undefined as never,
  ) as PosedSkeletonValue;
const spineKeys = (times: readonly number[], degs: readonly number[]) => [
  {
    bone: 'Spine',
    component: 'rotation',
    keyframes: times.map((time, i) => ({ time, value: [0, degs[i], 0], easing: 'linear' })),
  },
];

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

/** The worst angle between the two rigs, over every bone and every scene frame of the source's
 *  range. */
function worstOff(source: PosedSkeletonValue, result: PosedSkeletonValue): number {
  const { start, end } = source.clip!;
  let worst = 0;
  for (
    let f = Math.ceil(start * FRAMES_PER_SECOND);
    f <= Math.floor(end * FRAMES_PER_SECOND);
    f++
  ) {
    const t = f / FRAMES_PER_SECOND;
    const want = source.sample(t);
    const got = result.sample(t);
    want.forEach((pose, i) => {
      const a = new Quaternion(...pose.quaternion);
      const b = new Quaternion(...got[i].quaternion);
      worst = Math.max(worst, a.angleTo(b) * DEG);
    });
  }
  return worst;
}

const ROWS: {
  readonly label: string;
  readonly source: () => PosedSkeletonValue;
  /** Linear rows keep exactly their keys. */
  readonly samples?: number;
  /** The roads compared with the source at every frame; both unless a row says why not. */
  readonly exactOn?: readonly ('retarget' | 'bake')[];
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
    label: '#1457 — a layer above the base, keyed between its keys (a fold read at the top)',
    source: () =>
      onTop(hipsBase([0, 20]), {
        members: [{ bone: 'Spine', rotationMode: 'XYZ' }],
        channels: spineKeys([0, 0.5, 2], [0, 90, 0]),
      }),
    samples: 3,
  },
  {
    label: '#1457 — an override at half weight over a moving base (the blend is no slerp)',
    source: () =>
      onTop(hipsBase([0, 170]), {
        weight: 0.5,
        members: [{ bone: 'Hips', rotationMode: 'XYZ', rotation: [90, 0, 0] }],
      }),
  },
  {
    label: '#1457 — an additive layer whose member moves, over a moving base',
    source: () =>
      onTop(hipsBase([0, 120]), {
        mode: 'additive',
        members: [{ bone: 'Hips', rotationMode: 'XYZ' }],
        channels: [
          {
            bone: 'Hips',
            component: 'rotation',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 2, value: [90, 0, 0], easing: 'linear' },
            ],
          },
        ],
      }),
  },
  {
    label: '#1457 — a full-weight static override above the base keeps the base samples',
    source: () =>
      onTop(hipsBase([0, 20]), {
        members: [{ bone: 'Spine', rotationMode: 'XYZ', rotation: [0, 45, 0] }],
      }),
    samples: 2,
    // The retarget reads a source's FIRST pose as its reference pose (#853), so a bend held from
    // frame 0 is the source's rest to it, by design; the bake has no reference and is compared.
    exactOn: ['bake'],
  },
  {
    label: '#1457 — an additive rotation over part of the range fills frames only where it moves',
    source: () =>
      onTop(hipsBase([0, 120]), {
        mode: 'additive',
        members: [{ bone: 'Hips', rotationMode: 'XYZ' }],
        channels: [
          {
            bone: 'Hips',
            component: 'rotation',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 0.5, value: [90, 0, 0], easing: 'linear' },
            ],
          },
        ],
      }),
    // 0, 0.5 and 2 s, and the 29 frames inside 0–0.5 s: not every frame of the 2 s range.
    samples: 32,
  },
  {
    label: '#1457 — an additive layer moving only a position keeps the base samples (a sum)',
    source: () =>
      onTop(hipsBase([0, 20]), {
        mode: 'additive',
        members: [{ bone: 'Spine' }],
        channels: [
          {
            bone: 'Spine',
            component: 'position',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 2, value: [0, 0.5, 0], easing: 'linear' },
            ],
          },
        ],
      }),
    samples: 2,
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
        if ((row.exactOn ?? ['retarget', 'bake']).includes(road)) {
          const off = worstOff(source, posed);
          expect(off, `${road}: ${off.toFixed(2)}° off the source at a scene frame`).toBeLessThan(
            0.01,
          );
        }
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
