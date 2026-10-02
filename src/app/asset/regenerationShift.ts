// Say when a regeneration moved a layer's result (#1226, step 7 of "Bones as Channels", #1205).
//
// A pose layer stays attached when the motion under it regenerates, and it keeps its keys, but the
// RESULT can move out from under it: an additive +40° lands on an arm that is now already raised, a
// fix keyed mid-stride lands on a different stride. Proceduralism keeps the edit attached; it cannot
// keep it right. So a cook compares, for every layer standing on a regenerated clip, what the layer
// produced before the cook with what it produces after, per member bone, and names what moved.
//
// ── WHAT IS COMPARED, AND WHY THOSE TWO STATES ──────────────────────────────────────────────────
//
// The graph before the cook's dispatch and the graph after it. Not the generation cache: that is a
// module-level `Map` that no reload survives (#964), so after a reopen the old motion is only in the
// baked clip's params — which is exactly what the before-state holds. The two states also carry
// everything else a cook rewrites (the rig's bones), so a member whose bone the new rig lacks is
// found by reading, not by assuming.
//
// At each layer's own KEY TIMES, as the design says: a layer's keys are where its author looked. A
// layer with no keys holds its values at every time, so it is compared at the frames of the motion
// it stands on (the wire's `clip` range, before and after).
//
// ── NOTHING PASSES SILENTLY ─────────────────────────────────────────────────────────────────────
//
// "Could not compare" is its own outcome and never reads as "nothing moved": a layer whose pose did
// not evaluate, a member whose bone is missing on either side, a layer with no time to compare at.
// A muted layer plays nothing and is counted apart, so the counts still add up.
//
// REF: design ref/architecture/bone-channels-design.html (step 7; table row 14); src/app/animate/
//      poseChain.ts (`poseLayerChain`); src/nodes/PoseLayer.ts; src/app/asset/cookMotionGenerations.ts
//      (the one caller); issues #1226, #1205, #964.

import { evaluate } from '../../core/dag/evaluator';
import type { DagState } from '../../core/dag/state';
import { BAKE_POSE_LABEL } from '../animate/bakePose';
import { poseLayerChain } from '../animate/poseChain';
import { playedChannels, type PoseLayerParams } from '../../nodes/PoseLayer';
import { wirePoseTimes } from '../../nodes/RetargetClip';
import type { BonePose, PosedSkeletonValue, Quat, Vec3 } from '../../nodes/types';

/** A member bone's rotation must move by more than this to be named. Below it is float noise. */
export const MOVED_DEGREES = 1;
/** A member bone's position must move by more than this (scene units) to be named. */
export const MOVED_DISTANCE = 0.01;

/** One member bone whose result moved, with the largest move and when it happened. */
export interface MovedMember {
  readonly objectId: string;
  readonly layerId: string;
  readonly layerName: string;
  readonly bone: string;
  /** The largest rotation change over the compared times, in degrees. */
  readonly degrees: number;
  readonly degreesAt: number;
  /** The largest position change over the compared times, in scene units. */
  readonly distance: number;
  readonly distanceAt: number;
}

/** A layer, or some of its members, that could not be compared — and why. */
export interface UncomparedLayer {
  readonly objectId: string;
  readonly layerId: string;
  readonly layerName: string;
  readonly reason: string;
}

export interface RegenerationShiftReport {
  /** Layers compared (every member that could be), muted layers excluded. */
  readonly compared: number;
  /** Layers skipped because they are muted: they play nothing, so nothing of theirs moved. */
  readonly muted: number;
  readonly moved: readonly MovedMember[];
  readonly uncompared: readonly UncomparedLayer[];
}

type Binding = { node?: unknown } | readonly { node?: unknown }[] | undefined;

/** Whether `from` reads `target` anywhere upstream, through any input. */
function readsUpstream(state: DagState, from: string, targets: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (targets.has(id)) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const inputs = (state.nodes[id]?.inputs ?? {}) as Record<string, Binding>;
    for (const binding of Object.values(inputs)) {
      for (const b of Array.isArray(binding) ? binding : [binding]) {
        const node = (b as { node?: unknown } | undefined)?.node;
        if (typeof node === 'string') stack.push(node);
      }
    }
  }
  return false;
}

/** The pose a layer outputs, or null when it did not evaluate to a rig. */
function layerPose(state: DagState, layerId: string): PosedSkeletonValue | null {
  try {
    const value = evaluate(state, layerId).value as PosedSkeletonValue | undefined;
    if (value?.kind !== 'PosedSkeleton' || value.skeleton.bones.length === 0) return null;
    return value;
  } catch {
    return null;
  }
}

/** Every time the layer's played curves key, sorted and unique. */
function keyTimes(params: PoseLayerParams): number[] {
  const times = new Set<number>();
  for (const c of playedChannels(params.channels)) {
    for (const k of c.keyframes as readonly { time: number }[]) times.add(k.time);
  }
  return [...times].sort((a, b) => a - b);
}

/** Every pose a wire's range holds, by the one rule a retarget samples and a bake keys by. */
function clipFrames(pose: PosedSkeletonValue): number[] {
  const clip = pose.clip;
  if (!clip || !(clip.end > clip.start) || !(clip.rate > 0)) return [];
  return wirePoseTimes(clip, clip.rate).map((t) => clip.start + t);
}

/** The angle between two rotations in degrees, each normalised first: float32 quaternions read a
 *  phantom angle through `acos(|dot|)` otherwise. */
function angleDegrees(a: Quat, b: Quat): number {
  const la = Math.hypot(a[0], a[1], a[2], a[3]);
  const lb = Math.hypot(b[0], b[1], b[2], b[3]);
  if (!(la > 0) || !(lb > 0)) return 0;
  const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / (la * lb);
  return (2 * Math.acos(Math.min(1, Math.abs(dot))) * 180) / Math.PI;
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const byName = (poses: readonly BonePose[]) => new Map(poses.map((p) => [p.name, p]));

/**
 * What a regeneration did to the layers standing on the regenerated clips.
 *
 * `before` and `after` are the graph either side of the cook's dispatch; `regenerated` the sink clips
 * the cook rewrote. Pure over its arguments.
 */
export function regenerationShifts(
  before: DagState,
  after: DagState,
  regenerated: readonly string[],
): RegenerationShiftReport {
  const clips = new Set(regenerated);
  const moved: MovedMember[] = [];
  const uncompared: UncomparedLayer[] = [];
  let compared = 0;
  let muted = 0;
  if (clips.size === 0) return { compared, muted, moved, uncompared };

  for (const objectId of Object.keys(after.nodes).sort()) {
    if (after.nodes[objectId].type !== 'Object') continue;
    const { layers, source } = poseLayerChain(after.nodes, objectId);
    if (layers.length === 0 || !source || !readsUpstream(after, source.node, clips)) continue;

    for (const layerId of layers) {
      const params = after.nodes[layerId].params as PoseLayerParams;
      const layerName = params.name;
      const say = (reason: string) => uncompared.push({ objectId, layerId, layerName, reason });
      if (params.mute) {
        muted++;
        continue;
      }
      const was = layerPose(before, layerId);
      const now = layerPose(after, layerId);
      if (!was || !now) {
        say(`its pose did not evaluate ${!was ? 'before' : 'after'} the cook`);
        continue;
      }
      const keyed = keyTimes(params);
      const times =
        keyed.length > 0 ? keyed : [...new Set([...clipFrames(was), ...clipFrames(now)])];
      if (times.length === 0) {
        say('it has no keys, and the motion under it has no frames to compare at');
        continue;
      }

      const wasBones = new Set(was.skeleton.bones.map((b) => b.name));
      const nowBones = new Set(now.skeleton.bones.map((b) => b.name));
      const missing = params.members
        .map((m) => m.bone)
        .filter((bone) => !wasBones.has(bone) || !nowBones.has(bone));
      if (missing.length > 0) {
        say(
          `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the rig on both sides`,
        );
      }
      const members = params.members.map((m) => m.bone).filter((b) => !missing.includes(b));
      if (members.length === 0) continue;
      compared++;

      const worst = new Map(
        members.map((bone) => [
          bone,
          { degrees: 0, degreesAt: times[0], distance: 0, distanceAt: times[0] },
        ]),
      );
      for (const t of times) {
        const a = byName(was.sample(t));
        const b = byName(now.sample(t));
        for (const bone of members) {
          const pa = a.get(bone);
          const pb = b.get(bone);
          if (!pa || !pb) continue;
          const w = worst.get(bone)!;
          const deg = angleDegrees(pa.quaternion, pb.quaternion);
          if (deg > w.degrees) Object.assign(w, { degrees: deg, degreesAt: t });
          const d = distance(pa.position, pb.position);
          if (d > w.distance) Object.assign(w, { distance: d, distanceAt: t });
        }
      }
      for (const [bone, w] of worst) {
        if (w.degrees > MOVED_DEGREES || w.distance > MOVED_DISTANCE) {
          moved.push({ objectId, layerId, layerName, bone, ...w });
        }
      }
    }
  }
  return { compared, muted, moved, uncompared };
}

/** The sink clips a bake's ops rewrite: each carries exactly one `sourceHash` write, its receipt. */
export function bakedClipIds(
  ops: readonly { type: string; nodeId?: string; paramPath?: string }[],
): string[] {
  return ops
    .filter(
      (o) => o.type === 'setParam' && o.paramPath === 'sourceHash' && typeof o.nodeId === 'string',
    )
    .map((o) => o.nodeId!);
}

/** The clips among `clipIds` that held baked motion in `state`: only those REgenerated. A first cook
 *  has nothing under any layer to compare against. */
export function previouslyBaked(state: DagState, clipIds: readonly string[]): string[] {
  return clipIds.filter((id) => {
    const hash = (state.nodes[id]?.params as { sourceHash?: unknown } | undefined)?.sourceHash;
    return typeof hash === 'string' && hash !== '';
  });
}

const fmtSeconds = (s: number) => `${s.toFixed(2)} s`;

/**
 * What a director is told, or nothing when no layer stands on the regenerated motion. The zero case
 * is said too when there were layers, so a quiet cook cannot be mistaken for one that never looked.
 */
export function regenerationNotices(
  report: RegenerationShiftReport,
): { severity: 'info' | 'warn'; message: string }[] {
  const out: { severity: 'info' | 'warn'; message: string }[] = [];
  if (report.moved.length > 0) {
    const items = report.moved.map((m) => {
      const parts: string[] = [];
      if (m.degrees > MOVED_DEGREES)
        parts.push(`${Math.round(m.degrees)}° at ${fmtSeconds(m.degreesAt)}`);
      if (m.distance > MOVED_DISTANCE) {
        parts.push(`${m.distance.toFixed(2)} units at ${fmtSeconds(m.distanceAt)}`);
      }
      return `"${m.layerName}" ${m.bone} moved ${parts.join(', ')}`;
    });
    out.push({
      severity: 'warn',
      // #1230 — the way out is said where the problem is: a character whose motion was baked to keys
      // no longer reads the generated clip, so the next regeneration leaves it and its layers alone.
      message:
        `The regenerated motion moved layered results: ${items.join('; ')}. ` +
        `To keep a character as it is through the next regeneration, select it and use “${BAKE_POSE_LABEL}”.`,
    });
  }
  if (report.uncompared.length > 0) {
    const items = report.uncompared.map((u) => `"${u.layerName}": ${u.reason}`);
    out.push({
      severity: 'warn',
      message: `Could not compare every layer after regenerating: ${items.join('; ')}.`,
    });
  }
  if (out.length === 0 && report.compared > 0) {
    const n = report.compared;
    out.push({
      severity: 'info',
      message: `Regenerated: ${n} layer${n === 1 ? '' : 's'} compared, no result moved.`,
    });
  }
  return out;
}
