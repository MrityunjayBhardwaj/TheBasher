// #877 GATE (half one) — a bake must reproduce the clip it was baked FROM,
// between keyframes as well as at them.
//
// WHY THIS GATE EXISTS, AND WHY THE EXISTING ONE COULD NOT CATCH IT.
// `bakeGltfChannel.test.ts` assertion 6 ("H40 no-jump") samples the baked
// channel AT `bakeTime` — a keyframe. Both carriers are bit-for-bit identical
// at every keyframe no matter what easing the bake stamps, so that assertion
// reads 0 with the defect and 0 without it. It gates the jump, not the shape.
//
// The divergence lives strictly BETWEEN keys, and it is not uniform there:
//   clip  : a + (b-a)*u             (raw lerpVec3 — TransformClip.ts:116-118)
//   baked : a + (b-a)*smoothstep(u) (keyframeInterp.ts:303, easing 'cubic')
// These agree at u = 0, u = 1 AND u = 0.5, because smoothstep(0.5) = 0.5.
// u = 0.5 is the point a test written to "escape keyframe blindness" would
// naturally pick, and it is the one interior point that certifies nothing.
//
// |smoothstep(u) - u| peaks at u = (3 +/- sqrt(3))/6 ~ 0.2113 / 0.7887, where it
// equals 1/(6*sqrt(3)) ~ 0.0962 — 9.6% of each interval. So the sample points
// are chosen to STRADDLE the extrema, not to sit at a round number.
//
// FALSIFIED AGAINST THE REAL PRIOR IMPLEMENTATION, not a simulation: with
// `easing: 'cubic'` restored in bakeChannelOps.ts this file fails, reporting
// max |delta| = 9.623e-1 on the span below (and 8.5357 deg / 3.9774 mm on the
// real Robot-Walk clip). With 'linear' it reads exactly 0.

import { describe, it, expect } from 'vitest';
import { emptyDagState } from '../../../core/dag';
import { buildVec3Sampler, KeyframeChannelVec3Params } from '../../../nodes/KeyframeChannelVec3';
import { TransformClipNode, TransformClipParams } from '../../../nodes/TransformClip';
import type { TransformClipValue } from '../../../nodes/types';
import { bakeChannelOpsForBone, type BakedKey } from './bakeChannelOps';

const ASSET_REF = 'asset-877';
const CHILD = 'bone_877';

type Vec3 = [number, number, number];

/** Interior sample fractions. 0.5 is kept ON PURPOSE — it must stay 0 in both
 *  directions, and its presence documents why it alone proves nothing. The
 *  0.2113/0.7887 pair sits at the extrema of |smoothstep(u) - u|. */
const INTERIOR_U = [0.21, 0.2113, 0.5, 0.7887, 0.79] as const;

/** A clip whose every component moves, with UNEQUAL interval lengths so a bug
 *  that happens to cancel on a uniform grid cannot hide. */
const KEY_TIMES = [0, 0.4, 1.5, 2.0] as const;
const POSITIONS: Vec3[] = [
  [0, 0, 0],
  [1.25, -0.5, 3],
  [-2, 4, 0.75],
  [10, -4, 2.5],
];
const ROTATIONS: Vec3[] = [
  [0, 0, 0],
  [15, -30, 5],
  [-45, 90, -20],
  [120, 10, 60],
];

function clipParams() {
  return TransformClipParams.parse({
    name: 'clip-877',
    duration: KEY_TIMES[KEY_TIMES.length - 1],
    loop: 'clamp',
    keyframes: KEY_TIMES.map((time, i) => ({
      targetNodeId: CHILD,
      time,
      position: POSITIONS[i],
      rotation: ROTATIONS[i],
      scale: [1, 1, 1] as Vec3,
    })),
  });
}

/** Bake the same motion through the REAL production builder, then rebuild the
 *  REAL sampler from the params it emitted (parsed through the node's own zod
 *  schema, exactly as applyAddNode would — the schema DEFAULTS easing to
 *  'cubic', so anything the builder fails to state comes back as smoothstep). */
function bakedSamplers() {
  const position: BakedKey[] = KEY_TIMES.map((time, i) => ({ time, value: POSITIONS[i] }));
  const rotation: BakedKey[] = KEY_TIMES.map((time, i) => ({ time, value: ROTATIONS[i] }));

  const ops = bakeChannelOpsForBone({
    assetRef: ASSET_REF,
    childName: CHILD,
    byComponent: { position, rotation },
    state: emptyDagState(),
  });

  const byPath = new Map<string, (seconds: number) => readonly number[]>();
  for (const op of ops) {
    if (op.type !== 'addNode') continue;
    const raw = op.params as { paramPath: string };
    byPath.set(raw.paramPath, buildVec3Sampler(KeyframeChannelVec3Params.parse(op.params)));
  }
  return byPath;
}

describe('#877 — sample(bake(clip), t) == sample(clip, t)', () => {
  it('the bake reproduces its source clip BETWEEN keyframes, not only at them', () => {
    // `evaluate` is declared `O | Record<string, O>` (core/dag/types.ts:517), so the
    // single-value arm has to be narrowed before `.sample` is reachable. TransformClip
    // has no inputs and reads no ctx — time enters through `sample`, not the graph.
    const clip = TransformClipNode.evaluate(
      clipParams(),
      {} as never,
      {} as never,
    ) as TransformClipValue;
    const baked = bakedSamplers();

    // Denominator, printed with the result: a zero from a loop that never ran
    // is indistinguishable from a zero from a loop that ran and agreed.
    let compared = 0;
    let maxDelta = 0;
    let worst = '';

    for (let seg = 0; seg < KEY_TIMES.length - 1; seg++) {
      const t0 = KEY_TIMES[seg];
      const t1 = KEY_TIMES[seg + 1];
      for (const u of INTERIOR_U) {
        const t = t0 + u * (t1 - t0);
        const trs = clip.sample(t)[CHILD];
        expect(trs, `clip produced no TRS for ${CHILD} at t=${t}`).toBeDefined();

        for (const [component, expected] of [
          ['position', trs.position],
          ['rotation', trs.rotation],
        ] as const) {
          const sampler = baked.get(component);
          expect(sampler, `bake emitted no '${component}' channel`).toBeDefined();
          const got = sampler!(t);
          for (let axis = 0; axis < 3; axis++) {
            const delta = Math.abs(expected[axis] - got[axis]);
            compared++;
            if (delta > maxDelta) {
              maxDelta = delta;
              worst = `${component}[${axis}] seg${seg} u=${u} t=${t.toFixed(4)} clip=${expected[axis]} baked=${got[axis]}`;
            }
          }
        }
      }
    }

    // 3 segments x 5 fractions x 2 components x 3 axes.
    expect(compared).toBe(90);

    // Exact, not approximate: 'linear' makes the two expressions the SAME
    // arithmetic, so the only admissible slack is float representation.
    expect(maxDelta, `${compared} samples compared; worst: ${worst}`).toBeLessThan(1e-12);
  });

  it('u=0.5 alone would have passed even with the defect — so it cannot be the only probe', () => {
    // Guards the GATE, not the code: if someone later "simplifies" INTERIOR_U
    // down to the midpoint, this records why that would be a false green.
    const smoothstep = (u: number) => u * u * (3 - 2 * u);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(Math.abs(smoothstep(0.2113) - 0.2113)).toBeGreaterThan(0.09);
    expect(INTERIOR_U.some((u) => Math.abs(smoothstep(u) - u) > 0.09)).toBe(true);
  });

  it("every baked key states its easing explicitly, because the schema's default is 'cubic'", () => {
    // The one-line fix is only safe while it is STATED. Omitting the field
    // would round-trip back to smoothstep through the schema default and this
    // whole gate would go quiet, so assert on what the builder actually emits.
    const ops = bakeChannelOpsForBone({
      assetRef: ASSET_REF,
      childName: CHILD,
      byComponent: {
        position: KEY_TIMES.map((time, i) => ({ time, value: POSITIONS[i] })),
        rotation: KEY_TIMES.map((time, i) => ({ time, value: ROTATIONS[i] })),
      },
      state: emptyDagState(),
    });

    let keys = 0;
    for (const op of ops) {
      if (op.type !== 'addNode') continue;
      const p = op.params as { keyframes: Array<{ easing?: string }> };
      for (const k of p.keyframes) {
        keys++;
        expect(k.easing).toBe('linear');
      }
    }
    expect(keys).toBe(KEY_TIMES.length * 2);
  });
});
