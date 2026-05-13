// simplifyChannel Mutator — reduce a KeyframeChannel's sample density
// via Ramer-Douglas-Peucker, preserving curve shape within a tolerance ε.
//
// Number channels: 1D RDP over (time, value).
// Vec3 channels:   3D RDP over (time, x, y, z) — Euclidean distance in
//                  the (t, x, y, z) hypercube; simplifying x/y/z
//                  independently would drop axes that are constant
//                  while one axis varies (e.g. circle in xz-plane with
//                  fixed y would lose y endpoints).
// Quat / Color:    skipped in v0.5 — quaternion great-circle distance
//                  and HSL color metrics need their own RDP variants.
//                  Mutator returns a no-op for these types (build emits
//                  no Ops) so the agent surface is consistent.
//
// Closure: rootSelectors = [channelId]; followedEdges = []. Same shape
// as keyframe.ts — the operation is purely local to the channel node.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';

const SimplifyChannelSpec = z.object({
  channelId: z.string().min(1),
  /** Maximum perpendicular distance (in the channel's value space + time)
   *  a point may have from the simplified path. Higher = more aggressive
   *  reduction. 0 < tolerance ≤ 1. */
  tolerance: z.number().positive().max(1),
});
export type SimplifyChannelSpec = z.infer<typeof SimplifyChannelSpec>;

type Keyframe<V = unknown> = { time: number; value: V; easing: 'linear' | 'cubic' };

const SIMPLIFIABLE: ReadonlySet<string> = new Set([
  'KeyframeChannelNumber',
  'KeyframeChannelVec3',
]);

export const simplifyChannelMutator: MutatorDefinition<SimplifyChannelSpec> = {
  name: 'mutator.timeline.simplifyChannel',
  description:
    'Reduce a KeyframeChannel\'s keyframe count by Ramer-Douglas-Peucker. ' +
    'Preserves curve shape within tolerance ε. Supports Number + Vec3; ' +
    'Quat / Color channels return a no-op (their distance metrics need a ' +
    'separate implementation pass).',
  spec: SimplifyChannelSpec,
  specExample: {
    channelId: 'cube_position_channel',
    tolerance: 0.05,
  },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: [],
    // 'animation-shape' kept: RDP preserves curve shape within ε.
    // 'keyframe-density' dropped: simplification REDUCES sample count.
    // Distinguishes from keyframeMutator (which keeps both) and
    // clearChannelMutator (which keeps neither) under V14.
    preserves: [
      'position',
      'rotation',
      'scale',
      'material',
      'children',
      'animation-shape',
    ],
    lossy: [
      {
        kind: 'keyframe-density',
        reason: 'Interior keyframes within tolerance ε are removed.',
      },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: [spec.channelId],
      followedEdges: [],
    };
  },
  preconditions(spec, _closure, state) {
    const channel = state.nodes[spec.channelId];
    if (!channel) {
      return { ok: false, reason: `channelId "${spec.channelId}" not in DAG.` };
    }
    if (!channel.type.startsWith('KeyframeChannel')) {
      return {
        ok: false,
        reason: `channelId "${spec.channelId}" is ${channel.type}; expected a KeyframeChannel*.`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const channel = state.nodes[spec.channelId];
    // Quat / Color: return no-op rather than throwing — keeps the agent
    // surface forgiving and the toolbar button click harmless.
    if (!SIMPLIFIABLE.has(channel.type)) return [];

    const params = (channel.params ?? {}) as { keyframes?: Keyframe[] };
    const keyframes = (params.keyframes ?? []).slice().sort((a, b) => a.time - b.time);
    if (keyframes.length <= 2) return []; // nothing to simplify

    const points = toPoints(channel.type, keyframes);
    const keepMask = rdp(points, spec.tolerance);

    const next: Keyframe[] = keyframes.filter((_, i) => keepMask[i]);
    if (next.length === keyframes.length) return []; // RDP kept everything

    return [
      {
        type: 'setParam',
        nodeId: spec.channelId,
        paramPath: 'keyframes',
        value: next,
      },
    ];
  },
};

// ── RDP implementation ──

/** Point in the simplification space — time on axis 0, value axes on 1+. */
type Pt = readonly number[];

function toPoints(channelType: string, keyframes: Keyframe[]): Pt[] {
  if (channelType === 'KeyframeChannelNumber') {
    return keyframes.map((k) => [k.time, typeof k.value === 'number' ? k.value : 0]);
  }
  // Vec3 → (t, x, y, z) 4-vector.
  return keyframes.map((k) => {
    const v = Array.isArray(k.value) ? k.value : [0, 0, 0];
    return [k.time, Number(v[0] ?? 0), Number(v[1] ?? 0), Number(v[2] ?? 0)];
  });
}

/** Perpendicular distance from point `p` to the line segment (a, b) in
 *  N-dimensional Euclidean space. */
function perpDistance(p: Pt, a: Pt, b: Pt): number {
  // Project p onto the segment, clamp to [0,1], measure to projection.
  const dim = p.length;
  let abLenSq = 0;
  for (let i = 0; i < dim; i++) {
    const d = b[i] - a[i];
    abLenSq += d * d;
  }
  if (abLenSq < 1e-12) {
    // Segment is degenerate (a ≈ b); distance is just ‖p - a‖.
    let s = 0;
    for (let i = 0; i < dim; i++) s += (p[i] - a[i]) * (p[i] - a[i]);
    return Math.sqrt(s);
  }
  let t = 0;
  for (let i = 0; i < dim; i++) t += (p[i] - a[i]) * (b[i] - a[i]);
  t /= abLenSq;
  t = Math.max(0, Math.min(1, t));
  let s = 0;
  for (let i = 0; i < dim; i++) {
    const proj = a[i] + t * (b[i] - a[i]);
    s += (p[i] - proj) * (p[i] - proj);
  }
  return Math.sqrt(s);
}

/** Iterative RDP returning a boolean keep-mask aligned with the input
 *  points. Always keeps endpoints. */
function rdp(points: Pt[], epsilon: number): boolean[] {
  const n = points.length;
  const keep = new Array<boolean>(n).fill(false);
  if (n === 0) return keep;
  keep[0] = true;
  keep[n - 1] = true;
  if (n <= 2) return keep;

  // Iterative stack to avoid recursion blowups on long channels.
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistance(points[i], points[lo], points[hi]);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxIdx !== -1 && maxDist > epsilon) {
      keep[maxIdx] = true;
      stack.push([lo, maxIdx]);
      stack.push([maxIdx, hi]);
    }
  }
  return keep;
}
