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
// • Two mechanisms, each measured on its own (#1258): a bare keyframe channel, and a ParamDriver
//   carrying the same value. They reach different readers — every reader of a driver goes
//   through `driverChannelValuesForTarget`, and the camera pose is not one of them — so one's
//   answer is never borrowed for the other. A driver carries a number or a vec3 only. Strips are
//   not measured.
//
// REF: tests/e2e/p1235-animatable-census.spec.ts (the measurement); src/app/animatableCensus.json
//      (its committed result); issues #1235, #1066, #1069, #1239, #474, #193.

import { danglingIdRefs, idRefsByRole } from '../core/dag/idRefSweep';
import { applyOp } from '../core/dag/ops';
import type { DagState } from '../core/dag/state';
import census from './animatableCensus.json';
import { exposedTargetResolver, type ExposedTarget } from './exposeParams';
import { constraintStackForTarget, followPathStackForTarget } from './nodeConstraints';
import { chainSocketOf, isDataLaneOperator, singleRef } from './operatorChain';
import { driverStackForTarget } from './paramDrivers';
import { readBaseParam } from './readBaseParam';

/** The value kinds a keyframe channel carries, named as `addChannel` names them. */
export type ChannelValueKind = 'number' | 'vec2' | 'vec3' | 'quat' | 'color';

/** Where a measured param showed: the drawn scene, the camera pose the renderer takes, the frame
 *  a composition composites (a compositor Layer, #1259), or only the image rendered through the
 *  active camera. */
export type AnimatableReach = 'scene' | 'pose' | 'composite' | 'render';

/** What overlays the param: a bare keyframe channel, or a ParamDriver (#1258). */
export type AnimatableMechanism = 'channel' | 'driver';

/** The kinds a ParamDriver carries: its scalar road and its Vec3 road (`ParamDriver.ts`). */
const DRIVER_KINDS: readonly ChannelValueKind[] = ['number', 'vec3'];

/** How a question is asked: by which mechanism, and — when an overlay asks about its own
 *  target — which node is asking, so it is not counted as "something else supplies it". */
export interface AnimatableAsk {
  readonly mechanism?: AnimatableMechanism;
  readonly asker?: string;
}

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
  /** Absent for a kind a driver cannot carry; null when the driver moved nothing. */
  readonly driver?: AnimatableReach | null;
}
interface CensusFile {
  readonly subjects: Readonly<Record<string, Readonly<Record<string, CensusRow>>>>;
  readonly notMeasured: readonly { readonly pattern: string; readonly reason: string }[];
}
const CENSUS = census as unknown as CensusFile;

/** A row's answer for one mechanism: a reach, null (measured, nothing moved) or undefined
 *  (not measured this way). */
function reachFor(row: CensusRow, mechanism: AnimatableMechanism) {
  return mechanism === 'driver' ? row.driver : row.reach;
}

/**
 * What a node IS for the purpose of which params it draws: its type, its kind discriminator
 * when it has one (`LightData:Spot`, `CameraData:Orthographic`), and for an `Object` the
 * subject of the data it poses (`Object<LightData:Spot>`) — because a spot light's Object
 * ignores `rotation` (it aims by `target`) while a point light's does not. And, for a posable
 * node, its rotation mode (`Object<SphereData>@quaternion`), since which of `rotation` and
 * `quaternion` is drawn depends on it (#1259).
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
    rotationMode?: unknown;
  };
  // #1259 — a node in quaternion mode composes its `quaternion` and overwrites `rotation` with
  // it (`withResolvedRotation`), so the same param answers differently in each mode: it is a
  // different subject. Euler keeps the bare key, so no row measured before the modes did moves.
  const mode = params.rotationMode === 'quaternion' ? '@quaternion' : '';
  const dataId = (node.inputs as { data?: { node?: string } } | undefined)?.data?.node;
  if (node.type === 'Object' && dataId && state.nodes[dataId]) {
    const data = animatableSubjectOf(state, dataId);
    return data ? `Object<${data}>${mode}` : null;
  }
  const kind = params.lightKind ?? params.projection ?? params.kind;
  return (typeof kind === 'string' ? `${node.type}:${kind}` : node.type) + mode;
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
  return perState(state).operatorAbove().get(nodeId) ?? null;
}

/**
 * Answers derived once per graph state (#1261). A picker asks about every param of every
 * node, and each of these was a full scan or a full projection per question: the owner
 * lookup rebuilt a node's exposure once per PATH (3270 of 3740 ms on a 450-node scene). A
 * `DagState` is replaced, never mutated, on every dispatch, so keying on its identity cannot
 * serve a stale answer, and the entry goes when the state does.
 */
const PER_STATE = new WeakMap<
  DagState,
  {
    readonly operatorAbove: () => ReadonlyMap<string, string>;
    readonly ownerOf: (nodeId: string, paramPath: string) => ExposedTarget | null;
  }
>();
function perState(state: DagState) {
  let entry = PER_STATE.get(state);
  if (!entry) {
    let above: Map<string, string> | null = null;
    const resolvers = new Map<string, (paramPath: string) => ExposedTarget | null>();
    entry = {
      operatorAbove: () => {
        if (above) return above;
        above = new Map();
        for (const node of Object.values(state.nodes)) {
          if (!isDataLaneOperator(node)) continue;
          const socket = chainSocketOf(node);
          const below = socket ? singleRef(node, socket)?.node : undefined;
          // The first operator found per node, as the scan it replaces returned.
          if (below && !above.has(below)) above.set(below, node.type);
        }
        return above;
      },
      ownerOf: (nodeId, paramPath) => {
        let resolve = resolvers.get(nodeId);
        if (!resolve) {
          // `canApply` only decides whether the Apply-Transform button shows; it places a
          // control after the transform rows and omits none (`SECTION_CONTROLS`), so which
          // node owns a path cannot depend on it — and computing it evaluates the node's
          // mesh, 624 of 761 ms of a 450-node picker build. Pinned both ways by a test
          // (`exposeParams.canApplyOwners.test.ts`) that reds if that ever changes.
          resolve = exposedTargetResolver(state, nodeId, { canApply: false });
          resolvers.set(nodeId, resolve);
        }
        return resolve(paramPath);
      },
    };
    PER_STATE.set(state, entry);
  }
  return entry;
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
function suppliedElsewhere(
  state: DagState,
  nodeId: string,
  paramPath: string,
  asker?: string,
): string | null {
  const root = paramPath.split('.')[0];
  // A driver asking about its own band is not "something else" (#1258); another driver is.
  if (driverStackForTarget(state.nodes, nodeId, paramPath).some((d) => d.id !== asker))
    return 'a driver supplies it';
  if (
    (root === 'rotation' || root === 'quaternion') &&
    constraintStackForTarget(state.nodes, nodeId).length > 0
  )
    return 'a Track-To aims it';
  if (root === 'position' && followPathStackForTarget(state.nodes, nodeId).length > 0)
    return 'a Follow-Path places it';
  const owner = perState(state).ownerOf(nodeId, paramPath);
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
  ask: AnimatableAsk = {},
): { readonly subject: string } | { readonly unmeasured: string } {
  const subject = animatableSubjectOf(state, nodeId);
  if (!subject) return { unmeasured: 'no such node' };
  const above = operatorAbove(state, nodeId);
  if (above)
    return {
      unmeasured: `under an operator stack (${above}), which the census does not measure (#1247)`,
    };
  if (paramPath !== undefined) {
    const supplier = suppliedElsewhere(state, nodeId, paramPath, ask.asker);
    const overlay = ask.mechanism === 'driver' ? 'a driver' : 'a keyframe';
    if (supplier) return { unmeasured: `${supplier}, so ${overlay} on it would not show` };
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

/** Can a keyframe channel (or, asked so, a driver) of `kind` on (`nodeId`, `paramPath`) change
 *  what is drawn? */
export function isAnimatable(
  state: DagState,
  nodeId: string,
  paramPath: string,
  kind: ChannelValueKind,
  ask: AnimatableAsk = {},
): AnimatableAnswer {
  const mechanism = ask.mechanism ?? 'channel';
  if (mechanism === 'driver' && !DRIVER_KINDS.includes(kind))
    return { answer: 'unmeasured', reason: `a driver carries a number or a vec3, not a ${kind}` };
  const pattern = animatablePathPattern(paramPath);
  const skipped = CENSUS.notMeasured.find((n) => new RegExp(n.pattern).test(pattern));
  if (skipped) return { answer: 'unmeasured', reason: skipped.reason };
  const context = animatableContextOf(state, nodeId, paramPath, ask);
  if ('unmeasured' in context) return { answer: 'unmeasured', reason: context.unmeasured };
  const { subject } = context;
  const rows = CENSUS.subjects[subject];
  if (!rows) return { answer: 'unmeasured', reason: `the census places no ${subject}` };
  const row = rows[pattern];
  if (!row) return { answer: 'unmeasured', reason: `the census found no ${pattern} on ${subject}` };
  if (row.kind !== kind) return { answer: 'still', kind: row.kind };
  const reach = reachFor(row, mechanism);
  if (reach === undefined)
    return { answer: 'unmeasured', reason: `the census did not drive ${pattern} on ${subject}` };
  return reach
    ? { answer: 'animatable', reach, kind: row.kind }
    : { answer: 'still', kind: row.kind };
}

/** Did the census place `subject` at all? "Measured, and nothing moves" and "never looked" are
 *  different answers and a caller must be able to say which (#1066). */
export function isMeasuredSubject(subject: string): boolean {
  return subject in CENSUS.subjects;
}

/** The path patterns the census measured as animatable for `subject` with a `kind` channel,
 *  before anything about an instance is asked — so a picker can tell "this subject has such
 *  params, but here something else supplies them" from "this subject has none" (#1066). */
export function measuredPathsOfSubject(
  subject: string,
  kind: ChannelValueKind,
  mechanism: AnimatableMechanism = 'channel',
): string[] {
  const rows = CENSUS.subjects[subject];
  if (!rows) return [];
  return Object.entries(rows)
    .filter(([, r]) => r.kind === kind && reachFor(r, mechanism) != null)
    .map(([p]) => p);
}

/** Every measured animatable path of `kind` on `nodeId`, in census order — a picker's list.
 *  Null when the census never placed this node's subject, so a caller can say so. */
export function animatablePathsOf(
  state: DagState,
  nodeId: string,
  kind: ChannelValueKind,
  ask: AnimatableAsk = {},
): string[] | null {
  const context = animatableContextOf(state, nodeId);
  const rows = 'subject' in context ? CENSUS.subjects[context.subject] : undefined;
  if (!rows) return null;
  const mechanism = ask.mechanism ?? 'channel';
  return Object.entries(rows)
    .filter(([, r]) => r.kind === kind && reachFor(r, mechanism) != null)
    .map(([p]) => p)
    .filter((p) => p.includes('*') || !suppliedElsewhere(state, nodeId, p, ask.asker));
}

// ── #1552 — a path that names no parameter ───────────────────────────────────────────
//
// "The census found no such path" is not "there is no such path". The census keys the leaves a
// freshly placed node HOLDS, so an optional parameter nobody set is not in it, and neither is
// one component of a vector. And "the schema has no such path" is not it either: a ComfyUI
// input (`comfy:6.text`) is in no schema and animates. A path is called missing only when both
// agree, and only on a subject the census placed:
//
//   1. the census measured this node's subject, and has no row for the path, and
//   2. the node's own schema drops a value written there (the test `setParam` already makes).
//
// Anything else is "cannot say", and a caller must let it through. Blender draws the same line
// by door: `keyframe_insert` and `driver_add` refuse a property that is not found
// (python/intern/bpy_rna_anim.cc), while an F-curve built through the data API on a missing
// path is stored, because "there are some legit situations where some channels will not
// exist" (blenkernel/intern/anim_sys.cc).

/** A value of each kind, to ask a schema whether it keeps one written at a path. */
const SAMPLE_OF_KIND: Readonly<Record<ChannelValueKind, unknown>> = {
  number: 0,
  vec2: [0, 0],
  vec3: [0, 0, 0],
  quat: [0, 0, 0, 1],
  color: '#000000',
};

export interface MissingParamPath {
  /** The node the path was looked for on, after following it to the node that owns it. */
  readonly nodeId: string;
  readonly paramPath: string;
  /** Why it is missing, in words that do not repeat the path. */
  readonly reason: string;
  /** The paths on that node a `kind` overlay does animate, for a caller to offer instead. */
  readonly animatable: readonly string[];
}

/**
 * (`nodeId`, `paramPath`) when it certainly names no parameter, or null when it names one or
 * the question cannot be answered (see above). Never null for "nothing moves": a parameter
 * that exists and is not read is `isAnimatable`'s `still`.
 */
export function missingParamPath(
  state: DagState,
  nodeId: string,
  paramPath: string,
  kind: ChannelValueKind,
  ask: AnimatableAsk = {},
): MissingParamPath | null {
  if (!state.nodes[nodeId]) return null;
  // A data parameter named on an Object lives on its data node, under that node's spelling.
  const owner = perState(state).ownerOf(nodeId, paramPath);
  const at = owner ?? { nodeId, paramPath };
  const node = state.nodes[at.nodeId];
  if (!node) return null;
  const context = animatableContextOf(state, at.nodeId);
  if (!('subject' in context)) return null;
  const rows = CENSUS.subjects[context.subject];
  if (!rows) return null;
  const pattern = animatablePathPattern(at.paramPath);
  if (rows[pattern] || CENSUS.notMeasured.some((n) => new RegExp(n.pattern).test(pattern)))
    return null;
  let trial;
  try {
    trial = applyOp(state, {
      type: 'setParam',
      nodeId: at.nodeId,
      paramPath: at.paramPath,
      value: SAMPLE_OF_KIND[kind],
    });
  } catch {
    // The schema refused the sample outright, which says nothing about the path.
    return null;
  }
  if (trial.reportable?.badge !== 'stripped-write') return null;
  return {
    nodeId: at.nodeId,
    paramPath: at.paramPath,
    reason: trial.reportable.reason,
    animatable: animatablePathsOf(state, at.nodeId, kind, ask) ?? [],
  };
}

/** The kind an overlay node carries, or null for one this table cannot ask about. */
function overlayKindOf(type: string): { kind: ChannelValueKind; ask: AnimatableAsk } | null {
  switch (type) {
    case 'KeyframeChannelNumber':
      return { kind: 'number', ask: {} };
    case 'KeyframeChannelVec2':
      return { kind: 'vec2', ask: {} };
    case 'KeyframeChannelVec3':
      return { kind: 'vec3', ask: {} };
    case 'KeyframeChannelQuat':
      return { kind: 'quat', ask: {} };
    case 'KeyframeChannelColor':
      return { kind: 'color', ask: {} };
    case 'ParamDriver':
      return { kind: 'number', ask: { mechanism: 'driver' } };
    default:
      return null;
  }
}

export interface BrokenReference {
  /** The channel, driver or other node holding the reference. */
  readonly node: string;
  readonly type: string;
  /** The node it names. */
  readonly target: string;
  readonly paramPath?: string;
  readonly problem: string;
}

/**
 * Every reference in the graph that is aimed at nothing (#1552): a node that is not there, or
 * a parameter path that certainly names none. Derived when asked and stored nowhere, so a
 * reference that starts resolving again (the node is restored, the path is fixed) simply
 * leaves the list, as a Blender driver's `is_valid` recovers.
 */
export function brokenReferences(state: DagState): BrokenReference[] {
  const out: BrokenReference[] = danglingIdRefs(state.nodes).map((d) => ({
    node: d.node,
    type: state.nodes[d.node].type,
    target: d.missing,
    problem: 'names a node that is not in the graph',
  }));
  for (const node of Object.values(state.nodes)) {
    const overlay = overlayKindOf(node.type);
    if (!overlay) continue;
    const target = idRefsByRole(node).subject[0];
    const paramPath = readBaseParam(node, 'paramPath');
    if (!target || !state.nodes[target] || typeof paramPath !== 'string' || !paramPath) continue;
    const missing = missingParamPath(state, target, paramPath, overlay.kind, {
      ...overlay.ask,
      asker: node.id,
    });
    if (missing) {
      out.push({ node: node.id, type: node.type, target, paramPath, problem: missing.reason });
    }
  }
  return out;
}
