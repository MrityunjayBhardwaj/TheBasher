// channelPickers — a keyframe channel's or a ParamDriver's `target` and `paramPath`, picked from
// what animates (#1066).
//
// A channel animates a param only when something reads that param through the channel, and
// the schema cannot say which params are read (#1235): `TrackTo.aimPoint` is a vec3 like any
// other and ignores a channel. So both lists come from the two places that KNOW:
//   - a scene node → the measured census (`animatableParams.ts`), asked per concrete path;
//   - a ComfyUIWorkflow → the paths its batch compile reads (`comfySchedule.ts`).
// Every enabled pair (target, path) is one of those answers; a gate row writes each through
// the answer again, both ways (`paramWidgetDeclaration.gate.test.ts`).
//
// The target and the path are one decision (a split Object owns its transform, its data owns
// its material), so each list reads the other: a target is enabled when the channel's current
// path animates on it, and the path list is the chosen target's.
//
// What the census cannot answer — a node under an operator stack, a param a driver or a
// linked Material supplies — is LISTED, disabled, with the reason. When the channel's own
// target is such a node, its path is shown read-only with that reason rather than offered.
//
// A ParamDriver asks the census's DRIVER answers (#1258), not the channel's: a driver reaches
// fewer readers (the camera pose ignores it, #1266). Its kind is not its type — one driver
// carries a number or a vec3 depending on what feeds it — so the kind is read off the bound
// source, the same way `driverSourceOptions` decides what to offer; a source that says
// nothing about its shape asks both. A ComfyUI workflow answers a driver as it answers a
// channel: its batch samples `resolveEvaluatedParam`, which folds drivers (measured: a driver
// writing 3 onto a KSampler's cfg bakes 3, not the authored 6.5).
//
// A Quat channel asks the same census: it measures every posable node in both rotation modes
// (#1259), so a quaternion is offered where the node composes it and listed as still where it
// is dormant (euler mode), exactly as Blender keys one either way.
//
// Not here yet: Vec2 (the census places no compositor layer, #1259) and Image (a keyed image
// input reaches nothing, #1257).
//
// REF: src/app/animatableParams.ts; src/core/comfy/comfySchedule.ts; src/app/paramDrivers.ts
//      (`driverChannelValuesForTarget`, the road order); issues #1066, #1065, #1235, #1258.

import type { DagState } from '../core/dag/state';
import type { ComfyApiJson, ComfyGraphMeta } from '../core/comfy/comfyGraph';
import { comfyScheduledPaths } from '../core/comfy/comfySchedule';
import type { ParamOption } from '../nodes/paramWidget';
import { installChannelPickers, type PickedChannelKind } from '../nodes/channelPickerSlot';
import { getNodeType } from '../core/dag/registry';
import {
  type AnimatableAsk,
  animatableContextOf,
  animatableSubjectOf,
  isAnimatable,
  isMeasuredSubject,
  measuredPathsOfSubject,
} from './animatableParams';
import { singleRef } from './operatorChain';
import { nodeDisplayName } from './sceneTreeWalk';

export type { PickedChannelKind };

interface PathAnswer {
  /** Paths the asker animates on the node, each with its label. */
  readonly enabled: readonly { readonly path: string; readonly label: string }[];
  /** Why none is enabled, when the node has such params but something else supplies them. */
  readonly blocked: string | null;
}

/** Who is picking: the kinds it carries, how the census is asked, and what to call it. */
interface Asking {
  readonly kinds: readonly PickedChannelKind[];
  readonly ask: AnimatableAsk;
  readonly noun: string;
}

const channelAsking = (kind: PickedChannelKind): Asking => ({
  kinds: [kind],
  ask: {},
  noun: `a ${kind} channel`,
});

/**
 * The kinds a ParamDriver carries, read off its bound source in the order the resolver picks
 * a road (`driverChannelValuesForTarget`): a Point controller is a vec3; a transform channel
 * or a spare knob is a number; a wired `in` is what the producer's output socket declares
 * (`driverSourceOptions` offers sources by the same socket type). Anything that says nothing
 * about its shape — no source yet, a socket of another type — carries either.
 */
export function driverKindsOf(state: DagState, driverId: string): PickedChannelKind[] {
  const node = state.nodes[driverId];
  const p = (node?.params ?? {}) as Record<string, unknown>;
  if (p.sourceTransformVec) return ['vec3'];
  if (p.sourceTransform || p.sourceSpare) return ['number'];
  const ref = singleRef(node, 'in');
  const producer = ref ? state.nodes[ref.node] : undefined;
  const type = producer ? getNodeType(producer.type)?.outputs[ref!.socket]?.type : undefined;
  if (type === 'Number') return ['number'];
  if (type === 'Vector3') return ['vec3'];
  return ['number', 'vec3'];
}

const driverAsking = (state: DagState, driverId: string): Asking => ({
  kinds: driverKindsOf(state, driverId),
  ask: { mechanism: 'driver', asker: driverId },
  noun: 'a driver',
});

/** Concrete paths for a census pattern: every `*` becomes each index the params hold. */
export function expandPathPattern(params: unknown, pattern: string): string[] {
  const out: string[] = [];
  const walk = (value: unknown, segs: readonly string[], at: readonly string[]) => {
    if (segs.length === 0) {
      if (value !== undefined) out.push(at.join('.'));
      return;
    }
    const [seg, ...rest] = segs;
    if (seg === '*') {
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, rest, [...at, String(i)]));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    walk((value as Record<string, unknown>)[seg], rest, [...at, seg]);
  };
  walk(params, pattern.split('.'), []);
  return out;
}

function comfyGraphOf(state: DagState, nodeId: string) {
  const node = state.nodes[nodeId];
  if (node?.type !== 'ComfyUIWorkflow') return null;
  const graph = (node.params as { graph?: { apiJson?: ComfyApiJson; meta?: ComfyGraphMeta } })
    .graph;
  return graph?.apiJson && graph.meta ? { apiJson: graph.apiJson, meta: graph.meta } : null;
}

/** What a `kind` overlay asked `ask` can animate on `nodeId`, or null when it takes none. */
function pathsOfKind(
  state: DagState,
  nodeId: string,
  kind: PickedChannelKind,
  ask: AnimatableAsk,
): PathAnswer | null {
  const mechanism = ask.mechanism ?? 'channel';
  const comfy = comfyGraphOf(state, nodeId);
  if (comfy) {
    const enabled = comfyScheduledPaths(comfy.apiJson, comfy.meta)
      .filter((p) => p.kind === kind)
      .map((p) => ({ path: p.path, label: p.label }));
    return enabled.length > 0 ? { enabled, blocked: null } : null;
  }
  if (kind === 'text') return null;
  const subject = animatableSubjectOf(state, nodeId);
  const patterns = subject ? measuredPathsOfSubject(subject, kind, mechanism) : [];
  if (patterns.length === 0) return null;
  const context = animatableContextOf(state, nodeId);
  if ('unmeasured' in context) return { enabled: [], blocked: context.unmeasured };
  const params = state.nodes[nodeId]?.params;
  const enabled: { path: string; label: string }[] = [];
  let blocked: string | null = null;
  for (const pattern of patterns) {
    for (const path of expandPathPattern(params, pattern)) {
      const answer = isAnimatable(state, nodeId, path, kind, ask);
      if (answer.answer === 'animatable') enabled.push({ path, label: path });
      else if (answer.answer === 'unmeasured' && blocked === null)
        blocked = `${path}: ${answer.reason}`;
    }
  }
  return { enabled, blocked: enabled.length > 0 ? null : blocked };
}

/** What the asker can animate on `nodeId`, over every kind it carries. */
function pathsOn(state: DagState, nodeId: string, asking: Asking): PathAnswer | null {
  const answers = asking.kinds
    .map((k) => pathsOfKind(state, nodeId, k, asking.ask))
    .filter((a): a is PathAnswer => a !== null);
  if (answers.length === 0) return null;
  const enabled = answers.flatMap((a) => a.enabled);
  return {
    enabled,
    blocked: enabled.length > 0 ? null : (answers.find((a) => a.blocked)?.blocked ?? null),
  };
}

/** Why the asker on (`nodeId`, `path`) animates nothing — the words a disabled row shows. */
function whyNot(state: DagState, nodeId: string, path: string, asking: Asking): string {
  if (comfyGraphOf(state, nodeId)) return "the workflow's batch does not read it";
  if (asking.kinds.length === 1 && asking.kinds[0] === 'text')
    return 'only a ComfyUI workflow reads a text channel';
  const answers = asking.kinds
    .filter((k): k is Exclude<PickedChannelKind, 'text'> => k !== 'text')
    .map((k) => isAnimatable(state, nodeId, path, k, asking.ask));
  for (const answer of answers) if (answer.answer === 'unmeasured') return answer.reason;
  for (const answer of answers)
    if (answer.answer === 'still')
      return asking.kinds.includes(answer.kind as PickedChannelKind)
        ? 'nothing drawn changes'
        : `a ${answer.kind}, not a ${asking.kinds.join(' or ')}`;
  // The census says this path animates on such a node, yet it was not offered: the list is
  // built from the values the node holds, and this node holds none at the path.
  return `this node holds no value at ${path}`;
}

function overlayParams(state: DagState, overlayId: string) {
  const p = (state.nodes[overlayId]?.params ?? {}) as { target?: unknown; paramPath?: unknown };
  return {
    target: typeof p.target === 'string' ? p.target : '',
    path: typeof p.paramPath === 'string' ? p.paramPath : '',
  };
}

function targetOptions(state: DagState, overlayId: string, asking: Asking): ParamOption[] {
  const { target, path } = overlayParams(state, overlayId);
  const options: ParamOption[] = [];
  for (const id of Object.keys(state.nodes)) {
    if (id === overlayId) continue;
    const answer = pathsOn(state, id, asking);
    if (!answer) continue;
    let disabledReason: string | undefined;
    if (answer.enabled.length === 0) disabledReason = answer.blocked ?? 'nothing animates here';
    else if (path && !answer.enabled.some((p) => p.path === path))
      disabledReason = `${path} does not animate here — clear the path to choose it`;
    options.push({ value: id, label: nodeDisplayName(state.nodes, id), disabledReason });
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  // The overlay's own target always has a row, and one that says why when it is not a choice
  // — "not found" would be false for a node that is right there.
  if (target && state.nodes[target] && !options.some((o) => o.value === target))
    options.unshift({
      value: target,
      label: nodeDisplayName(state.nodes, target),
      disabledReason: path
        ? whyNot(state, target, path, asking)
        : `nothing ${asking.noun} animates`,
    });
  return options;
}

function pathOptions(state: DagState, overlayId: string, asking: Asking): ParamOption[] {
  const { target, path } = overlayParams(state, overlayId);
  if (!target || !state.nodes[target]) return [];
  const answer = pathsOn(state, target, asking);
  const options: ParamOption[] = (answer?.enabled ?? []).map((p) => ({
    value: p.path,
    label: p.label,
  }));
  if (path && !options.some((o) => o.value === path))
    options.unshift({
      value: path,
      label: path,
      disabledReason: whyNot(state, target, path, asking),
    });
  return options;
}

/**
 * Why the overlay's `paramPath` is read-only right now, or null when it can be picked.
 *
 * It is read-only when the overlay's target is a node whose answer nobody has: the census
 * never placed it, or something else supplies every param of this kind on it. Offering a
 * list there would be offering guesses.
 */
function pathLock(state: DagState, overlayId: string, asking: Asking): string | null {
  const { target } = overlayParams(state, overlayId);
  if (!target || !state.nodes[target]) return null;
  const answer = pathsOn(state, target, asking);
  if (answer && answer.enabled.length > 0) return null;
  if (answer?.blocked) return answer.blocked;
  const kinds = asking.kinds.join(' or ');
  if (asking.kinds.length === 1 && asking.kinds[0] === 'text')
    return 'only a ComfyUI workflow reads a text channel';
  if (comfyGraphOf(state, target)) return `this workflow's batch reads no ${kinds} input`;
  const subject = animatableSubjectOf(state, target);
  if (subject && isMeasuredSubject(subject))
    return asking.ask.mechanism === 'driver'
      ? `a driver moves no ${kinds} param of ${subject}`
      : `no ${kinds} param of ${subject} animates`;
  return `the census has not measured ${subject ?? 'this node'}`;
}

/** A `kind` channel's `target` picker. */
export const channelTargetOptions = (state: DagState, channelId: string, kind: PickedChannelKind) =>
  targetOptions(state, channelId, channelAsking(kind));

/** A `kind` channel's `paramPath` picker: what animates on its current target. */
export const channelPathOptions = (state: DagState, channelId: string, kind: PickedChannelKind) =>
  pathOptions(state, channelId, channelAsking(kind));

/** Why a `kind` channel's `paramPath` is read-only right now, or null when it can be picked. */
export const channelPathLock = (state: DagState, channelId: string, kind: PickedChannelKind) =>
  pathLock(state, channelId, channelAsking(kind));

/** A ParamDriver's `target` picker, from the census's driver answers. */
export const driverTargetOptions = (state: DagState, driverId: string) =>
  targetOptions(state, driverId, driverAsking(state, driverId));

/** A ParamDriver's `paramPath` picker: what a driver of its kind animates on its target. */
export const driverPathOptions = (state: DagState, driverId: string) =>
  pathOptions(state, driverId, driverAsking(state, driverId));

/** Why a ParamDriver's `paramPath` is read-only right now, or null when it can be picked. */
export const driverPathLock = (state: DagState, driverId: string) =>
  pathLock(state, driverId, driverAsking(state, driverId));

// The overlay schemas ask the slot, not this module (a static import would be a load cycle
// through the node registry). Loading this module is what makes the pickers answer; `boot.ts`
// imports it, and the slot fails closed if nothing does.
installChannelPickers({
  targetOptions: channelTargetOptions,
  pathOptions: channelPathOptions,
  pathLock: channelPathLock,
  driverTargetOptions,
  driverPathOptions,
  driverPathLock,
});
