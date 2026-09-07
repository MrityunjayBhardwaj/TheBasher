// TransformClip — node-indexed counterpart to AnimationClip (issue #81).
//
// Where AnimationClip samples a Skeleton's bone-indexed keyframes and
// emits a PosedSkeleton, TransformClip samples scene-node-indexed
// keyframes and emits a TRS map keyed by `targetNodeId`. This is the
// shape glTF embedded animations need: tracks reference scene-graph
// node names, not skeleton bones. The mapping is filled in by the
// drop-time importer (Wave D); the renderer (Wave E) calls
// TransformClipValue.sample(seconds) to get the TRS map for the current
// playback time and overrides the matching gltf.scene child's TRS.
//
// Discipline mirrors AnimationClip.ts:
//   - pure: true, V2 — output is a function of (params).
//   - NO three.js AnimationMixer / clock.
//   - Time enters through the value's `sample(seconds)` method (V3 amended P7.10).
//   - Rotation is **degrees Euler XYZ** — matches Transform.rotation
//     end-to-end (SceneFromDAG.tsx:266,426,449,525). The Wave-B
//     CHECKPOINT B3 verifies this against the producer side
//     (`degVec3ToRad` / `quaternionToEulerVec3`).
//
// P7.10 — function-of-time value shape (B13 Pass 3, #114). Pre-P7.10
// TransformClip had a `time` input socket and its evaluate pre-sampled
// the TRS at ctx.time, producing a value with a pre-baked `tracks` map.
// The Time-input made TransformClip's cache key flip every frame (its
// inputs hash included TimeSource's per-frame-flipping hash), which
// forced the WHOLE React tree downstream of SceneFromDAG to re-walk per
// playback frame (B13 / H48). Lifting time INTO the value (the
// `sample(seconds)` method) makes evaluate truly pure with NO Time
// input, so the cache hits across frames; consumers call .sample() at
// their own cadence (renderers via useFrame; the gizmo/NPanel
// static-read path at their resolution time).
//
// REF: THESIS.md §42, §49; vyapti V2/V3 (amended P7.10); CONTEXT/PLAN
// 7.10 (D-01 final lock + D-05 V3 amend); issue #81 + #114.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { TransformClipValue, Vec3 } from './types';
import { ClipLoopSchema } from './clipLoop';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const TransformClipParams = z.object({
  name: z.string().default('clip'),
  duration: z.number().positive().default(2),
  /**
   * What the clip does past its authored range. The FULL tri-state since #934 —
   * this carrier used to take `hold | cycle` only, because folding time has no
   * way to add a per-period offset and accepting the value would have given
   * plain cycling instead. It now adds a real one, so the value is constructible
   * rather than unreachable, and the two clip carriers finally spell one concept
   * one way.
   *
   * `hold` pins pre-/post-keyframes to the endpoints; `cycle` folds time into
   * [0, duration), replaying identical frames — cycle-in-place; `cycle-offset`
   * folds the same way and adds the per-period POSITION delta, so a walk covers
   * ground instead of snapping home.
   */
  loop: ClipLoopSchema,
  /**
   * Scene-node-indexed keyframes. Each row targets one scene child by
   * `targetNodeId` (built deterministically by the importer from
   * sanitised glTF node names) and supplies the full TRS at `time`.
   * The Wave-B sampler interpolates per-target piecewise-linearly.
   */
  keyframes: z
    .array(
      z.object({
        targetNodeId: z.string(),
        time: z.number().nonnegative(),
        position: Vec3Schema.default([0, 0, 0]),
        rotation: Vec3Schema.default([0, 0, 0]),
        scale: Vec3Schema.default([1, 1, 1]),
      }),
    )
    .default([]),
});
export type TransformClipParams = z.infer<typeof TransformClipParams>;

type Keyframe = TransformClipParams['keyframes'][number];
interface TRS {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Group keyframes by targetNodeId, sorted ascending by time. Pure. */
function groupByTarget(keyframes: readonly Keyframe[]): Map<string, Keyframe[]> {
  const map = new Map<string, Keyframe[]>();
  for (const k of keyframes) {
    const list = map.get(k.targetNodeId) ?? [];
    list.push(k);
    map.set(k.targetNodeId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.time - b.time);
  return map;
}

/** Sample one target's piecewise-linear TRS at clip-time `t`. Clamps at endpoints.
 *  Returns the keyframe verbatim when only one exists.
 *  Rotation is interpolated component-wise on Euler degrees — RESEARCH Q3
 *  acknowledges the singularity-crossing limitation; v0.5 AnimationClip
 *  already accepts this for the same reason (cheap, no slerp cost). */
function sampleTarget(track: Keyframe[], t: number): TRS {
  // Single-keyframe + endpoint clamps mirror AnimationClip.ts:76-80
  // (the bone sampler) — byte-faithful to keep the regression class
  // surface unified.
  const last = track[track.length - 1];
  if (t <= track[0].time)
    return { position: track[0].position, rotation: track[0].rotation, scale: track[0].scale };
  if (t >= last.time)
    return { position: last.position, rotation: last.rotation, scale: last.scale };
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const u = span > 0 ? (t - a.time) / span : 0;
      return {
        position: lerpVec3(a.position, b.position, u),
        rotation: lerpVec3(a.rotation, b.rotation, u),
        scale: lerpVec3(a.scale, b.scale, u),
      };
    }
  }
  return { position: last.position, rotation: last.rotation, scale: last.scale };
}

export const TransformClipNode: NodeDefinition<TransformClipParams, TransformClipValue> = {
  type: 'TransformClip',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: TransformClipParams,
  // P7.10: no `time` input — time enters via the value's sample(seconds)
  // method (V3 amended). Pre-P7.10 wires from TimeSource→TransformClip in
  // saved projects become harmless ghost bindings: the evaluator ignores
  // bindings to sockets the node no longer declares.
  inputs: {},
  outputs: { out: { type: 'TransformClip', cardinality: 'single' } },
  inspectorSections: ['animate'],
  evaluate(params): TransformClipValue {
    // Pre-group ONCE at evaluate time (closure-captured). The hot path
    // (sample invocation) only does per-target interpolation; no per-call
    // grouping allocation.
    const groupedTracks = groupByTarget(params.keyframes);
    const duration = params.duration;
    const loop = params.loop;
    const hasKeyframes = params.keyframes.length > 0;

    // Per-target POSITION travel per period (#934), computed ONCE here beside the
    // grouping rather than per `sample` call — the hot path stays interpolation
    // only, which is the discipline the grouping above already states.
    //
    // WHY IT IS MEASURED OVER THE CLIP'S DURATION AND NOT THE TARGET'S KEY RANGE.
    // The importer sets `duration` to the max key time across ALL channels
    // (gltfImportChain), so a target whose own track ends earlier still belongs
    // to the clip's period. Taking each target's own key range would give it a
    // different period from its siblings and desynchronise the animation. Reading
    // through `sampleTarget` gets this right for free: a track that ends early
    // clamps, so its delta is its own last − first.
    //
    // SELF-LIMITING, which is why it can apply to every target and not only a
    // root: a target whose position never changes has last === first, so its
    // delta is exactly zero and cycle-offset is indistinguishable from cycle.
    const travelPerPeriod = new Map<string, Vec3>();
    if (loop === 'cycle-offset') {
      for (const [targetId, group] of groupedTracks) {
        if (group.length === 0) continue;
        const first = sampleTarget(group, 0).position;
        const last = sampleTarget(group, duration).position;
        travelPerPeriod.set(targetId, [last[0] - first[0], last[1] - first[1], last[2] - first[2]]);
      }
    }

    const sample = (seconds: number): Record<string, TRS> => {
      if (!hasKeyframes) return {};
      // hold / cycle folding — byte-faithful to AnimationClip's own fold. The
      // fold expression is UNCHANGED from before #934 on purpose: `cycle` must
      // sample identically to what it always did, so the offset is additive
      // rather than a re-derivation of the wrap.
      let t = seconds;
      let period = 0;
      if (loop === 'cycle' || loop === 'cycle-offset') {
        // The period index the offset multiplies. `floor` is correct on both
        // sides of zero: t = -0.5 over a 1s clip is period -1, folding to 0.5,
        // which is one period BACK rather than forward.
        period = Math.floor(seconds / duration);
        t = ((t % duration) + duration) % duration;
      } else {
        t = Math.max(0, Math.min(duration, t));
      }
      const tracks: Record<string, TRS> = {};
      for (const [targetId, group] of groupedTracks) {
        if (group.length === 0) continue;
        const trs = sampleTarget(group, t);
        const travel = period !== 0 ? travelPerPeriod.get(targetId) : undefined;
        if (!travel) {
          tracks[targetId] = trs;
          continue;
        }
        // POSITION only. Rotation is bounded and returns to its start, so a
        // per-period residual would compound without bound — the reason
        // `clipExtendRules` gives rotation plain `cycle` under this mode. Scale
        // is excluded on the same argument; it has no case there because the
        // bone-indexed carrier has no scale to state one for.
        tracks[targetId] = {
          position: [
            trs.position[0] + period * travel[0],
            trs.position[1] + period * travel[1],
            trs.position[2] + period * travel[2],
          ],
          rotation: trs.rotation,
          scale: trs.scale,
        };
      }
      return tracks;
    };

    return {
      kind: 'TransformClip',
      name: params.name,
      duration,
      sample,
    };
  },
};
