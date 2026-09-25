// animatableParams — which params a keyframe channel can animate, as MEASURED (#1235).
//
// ── WHY THIS IS A MEASUREMENT AND NOT A RULE ───────────────────────────────────────────
//
// Whether a channel on a param changes anything is decided by that param's READER, and the
// readers do not agree on one road. Twelve roads carry a channel's value to something that
// uses it, each with its own membership: the scene-object overlay, the light overlay, the
// camera pose (bare channels, a fixed path list), the environment, the glTF material map, the
// compositor… (the road table is on #1235). Some params are read raw and never see a channel:
// `TrackTo.aimPoint`, camera `zoom`, a curve's `points`. Nothing in the code recorded which is
// which, so a channel on a raw-read param was accepted, drawn in the dopesheet, and did nothing.
//
// Writing the roads' rules down beside them would be a second copy of every renderer's reads,
// and it would drift the moment a renderer changed. So the table is MEASURED instead, by
// `tests/e2e/p1235-animatable-census.spec.ts`: for one of every kind the product's own Add path
// can place, every keyable-shaped leaf is keyed A → B, and the param counts as animatable when
// the drawn scene (or the camera pose the renderer takes) moves between the two. A no-channel
// control at the same two times must hold still. The spec re-measures on every run and reds on
// any difference from `animatableCensus.json`, so a renderer that starts or stops reading a
// param moves this table in the same change.
//
// ── WHAT THE TABLE CAN AND CANNOT SAY ──────────────────────────────────────────────────
//
// • Three answers, never two. A (subject, path) the census measured is `animatable` or `still`.
//   Anything else — a node type no Add path places, a path the harness could not make visible
//   (a `uvTransform` with no texture) — is `unmeasured`, with the reason. "Could not look" is
//   never reported as "nothing moves".
// • `scene` includes editor chrome: a point light's `rotation` moves only its helper glyph, and a
//   curve's line is itself chrome. That is still a visible response to the channel.
// • Bare keyframe channels only. Strips and drivers reach fewer roads (the camera pose ignores
//   both) and are not measured here yet.
//
// REF: tests/e2e/p1235-animatable-census.spec.ts (the measurement); src/app/animatableCensus.json
//      (its committed result); issues #1235, #1066, #1069, #1239, #474, #193.

import type { DagState } from '../core/dag/state';
import census from './animatableCensus.json';
import { resolveExposedTarget } from './exposeParams';
import { constraintStackForTarget, followPathStackForTarget } from './nodeConstraints';
import { chainSocketOf, isDataLaneOperator, singleRef } from './operatorChain';
import { driverStackForTarget } from './paramDrivers';

/** The value kinds a keyframe channel carries, named as `addChannel` names them. */
export type ChannelValueKind = 'number' | 'vec2' | 'vec3' | 'quat' | 'color';

/** Where a measured param showed: the drawn scene, the camera pose the renderer takes, or only
 *  the image rendered through the active camera. */
export type AnimatableReach = 'scene' | 'pose' | 'render';

export type AnimatableAnswer =
  | {
      readonly answer: 'animatable';
      readonly reach: AnimatableReach;
      readonly kind: ChannelValueKind;
    }
  | { readonly answer: 'still'; readonly kind: ChannelValueKind }
  | { readonly answer: 'unmeasured'; readonly reason: string };

interface CensusRow {
  readonly kind: ChannelValueKind;
  readonly reach: AnimatableReach | null;
}
interface CensusFile {
  readonly subjects: Readonly<Record<string, Readonly<Record<string, CensusRow>>>>;
  readonly notMeasured: readonly { readonly pattern: string; readonly reason: string }[];
}
const CENSUS = census as unknown as CensusFile;

/**
 * What a node IS for the purpose of which params it draws: its type, its kind discriminator
 * when it has one (`LightData:Spot`, `CameraData:Orthographic`), and for an `Object` the
 * subject of the data it poses (`Object<LightData:Spot>`) — because a spot light's Object
 * ignores `rotation` (it aims by `target`) while a point light's does not.
 *
 * The census harness asks THIS function (through a dev hook), so the key it measured under and
 * the key a picker looks up are one definition, not two.
 */
export function animatableSubjectOf(state: DagState, nodeId: string): string | null {
  const node = state.nodes[nodeId];
  if (!node) return null;
  const params = (node.params ?? {}) as {
    lightKind?: unknown;
    projection?: unknown;
    kind?: unknown;
  };
  const dataId = (node.inputs as { data?: { node?: string } } | undefined)?.data?.node;
  if (node.type === 'Object' && dataId && state.nodes[dataId]) {
    const data = animatableSubjectOf(state, dataId);
    return data ? `Object<${data}>` : null;
  }
  const kind = params.lightKind ?? params.projection ?? params.kind;
  return typeof kind === 'string' ? `${node.type}:${kind}` : node.type;
}

/**
 * The data-lane operator stacked directly on `nodeId`, if any.
 *
 * A data param under an operator is a different question from the same param on a bare mesh:
 * its write is re-read through the TOP operator's handle, and a name that both carry is handed
 * to the wrong one — keying a Cube's `size` under a UV Project crashes the viewport (#1247).
 * The census measures each operator on a mesh of its own and does not measure the base data
 * beneath it, so the lookup must know when it is being asked about that case.
 */
function operatorAbove(state: DagState, nodeId: string): string | null {
  for (const node of Object.values(state.nodes)) {
    if (!isDataLaneOperator(node)) continue;
    const socket = chainSocketOf(node);
    if (socket && singleRef(node, socket)?.node === nodeId) return node.type;
  }
  return null;
}

/**
 * What supplies (`nodeId`, `paramPath`) instead of the param itself, if anything.
 *
 * A keyframe on a param something else supplies moves nothing, and that is a fact about this
 * instance, not about the param: a Cube's `position` animates until a Follow-Path places it, a
 * material colour until a linked Material owns it, a radius until a driver writes it. The census
 * measures each param where nothing else supplies it, so these are answered "unmeasured", never
 * "still". Each question is put to the function that already owns it.
 */
function suppliedElsewhere(state: DagState, nodeId: string, paramPath: string): string | null {
  const root = paramPath.split('.')[0];
  if (driverStackForTarget(state.nodes, nodeId, paramPath).length > 0)
    return 'a driver supplies it';
  if (
    (root === 'rotation' || root === 'quaternion') &&
    constraintStackForTarget(state.nodes, nodeId).length > 0
  )
    return 'a Track-To aims it';
  if (root === 'position' && followPathStackForTarget(state.nodes, nodeId).length > 0)
    return 'a Follow-Path places it';
  const owner = resolveExposedTarget(state, nodeId, paramPath);
  if (owner && (owner.nodeId !== nodeId || owner.paramPath !== paramPath))
    return `${owner.nodeId}.${owner.paramPath} supplies it`;
  return null;
}

/** The census subject for `nodeId` — and, given a path, for that param on it — or why the
 *  census cannot answer. */
export function animatableContextOf(
  state: DagState,
  nodeId: string,
  paramPath?: string,
): { readonly subject: string } | { readonly unmeasured: string } {
  const subject = animatableSubjectOf(state, nodeId);
  if (!subject) return { unmeasured: 'no such node' };
  const above = operatorAbove(state, nodeId);
  if (above)
    return {
      unmeasured: `under an operator stack (${above}), which the census does not measure (#1247)`,
    };
  if (paramPath !== undefined) {
    const supplier = suppliedElsewhere(state, nodeId, paramPath);
    if (supplier) return { unmeasured: `${supplier}, so a keyframe on it would not show` };
  }
  return { subject };
}

/** A param path with every array index generalised, so `points.3.co` looks up `points.*.co`. */
export function animatablePathPattern(paramPath: string): string {
  return paramPath
    .split('.')
    .map((seg) => (/^\d+$/.test(seg) ? '*' : seg))
    .join('.');
}

/** Can a keyframe channel of `kind` on (`nodeId`, `paramPath`) change what is drawn? */
export function isAnimatable(
  state: DagState,
  nodeId: string,
  paramPath: string,
  kind: ChannelValueKind,
): AnimatableAnswer {
  const pattern = animatablePathPattern(paramPath);
  const skipped = CENSUS.notMeasured.find((n) => new RegExp(n.pattern).test(pattern));
  if (skipped) return { answer: 'unmeasured', reason: skipped.reason };
  const context = animatableContextOf(state, nodeId, paramPath);
  if ('unmeasured' in context) return { answer: 'unmeasured', reason: context.unmeasured };
  const { subject } = context;
  const rows = CENSUS.subjects[subject];
  if (!rows) return { answer: 'unmeasured', reason: `the census places no ${subject}` };
  const row = rows[pattern];
  if (!row) return { answer: 'unmeasured', reason: `the census found no ${pattern} on ${subject}` };
  if (row.kind !== kind) return { answer: 'still', kind: row.kind };
  return row.reach
    ? { answer: 'animatable', reach: row.reach, kind: row.kind }
    : { answer: 'still', kind: row.kind };
}

/** Every measured animatable path of `kind` on `nodeId`, in census order — a picker's list.
 *  Null when the census never placed this node's subject, so a caller can say so. */
export function animatablePathsOf(
  state: DagState,
  nodeId: string,
  kind: ChannelValueKind,
): string[] | null {
  const context = animatableContextOf(state, nodeId);
  const rows = 'subject' in context ? CENSUS.subjects[context.subject] : undefined;
  if (!rows) return null;
  return Object.entries(rows)
    .filter(([, r]) => r.kind === kind && r.reach !== null)
    .map(([p]) => p)
    .filter((p) => p.includes('*') || !suppliedElsewhere(state, nodeId, p));
}
