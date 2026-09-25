// channelPickers — a keyframe channel's `target` and `paramPath`, picked from what animates (#1066).
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
// Not here yet: Vec2 and Quat (the census has no rows of either, #1259), Image (a keyed image
// input reaches nothing, #1257), and ParamDriver (drivers reach fewer readers, #1258).
//
// REF: src/app/animatableParams.ts; src/core/comfy/comfySchedule.ts; issues #1066, #1065,
//      #1235.

import type { DagState } from '../core/dag/state';
import type { ComfyApiJson, ComfyGraphMeta } from '../core/comfy/comfyGraph';
import { comfyScheduledPaths } from '../core/comfy/comfySchedule';
import type { ParamOption } from '../nodes/paramWidget';
import { installChannelPickers, type PickedChannelKind } from '../nodes/channelPickerSlot';
import {
  animatableContextOf,
  animatableSubjectOf,
  isAnimatable,
  isMeasuredSubject,
  measuredPathsOfSubject,
} from './animatableParams';
import { nodeDisplayName } from './sceneTreeWalk';

export type { PickedChannelKind };

interface PathAnswer {
  /** Paths a channel of this kind animates on the node, each with its label. */
  readonly enabled: readonly { readonly path: string; readonly label: string }[];
  /** Why none is enabled, when the node has such params but something else supplies them. */
  readonly blocked: string | null;
}

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

/** What a `kind` channel can animate on `nodeId`, or null when the node takes no such channel. */
function pathsOn(state: DagState, nodeId: string, kind: PickedChannelKind): PathAnswer | null {
  const comfy = comfyGraphOf(state, nodeId);
  if (comfy) {
    const enabled = comfyScheduledPaths(comfy.apiJson, comfy.meta)
      .filter((p) => p.kind === kind)
      .map((p) => ({ path: p.path, label: p.label }));
    return enabled.length > 0 ? { enabled, blocked: null } : null;
  }
  if (kind === 'text') return null;
  const subject = animatableSubjectOf(state, nodeId);
  const patterns = subject ? measuredPathsOfSubject(subject, kind) : [];
  if (patterns.length === 0) return null;
  const context = animatableContextOf(state, nodeId);
  if ('unmeasured' in context) return { enabled: [], blocked: context.unmeasured };
  const params = state.nodes[nodeId]?.params;
  const enabled: { path: string; label: string }[] = [];
  let blocked: string | null = null;
  for (const pattern of patterns) {
    for (const path of expandPathPattern(params, pattern)) {
      const answer = isAnimatable(state, nodeId, path, kind);
      if (answer.answer === 'animatable') enabled.push({ path, label: path });
      else if (answer.answer === 'unmeasured' && blocked === null)
        blocked = `${path}: ${answer.reason}`;
    }
  }
  return { enabled, blocked: enabled.length > 0 ? null : blocked };
}

/** Why a `kind` channel on (`nodeId`, `path`) animates nothing — the words a disabled row shows. */
function whyNot(state: DagState, nodeId: string, path: string, kind: PickedChannelKind): string {
  if (comfyGraphOf(state, nodeId)) return "the workflow's batch does not read it";
  if (kind === 'text') return 'only a ComfyUI workflow reads a text channel';
  const answer = isAnimatable(state, nodeId, path, kind);
  if (answer.answer === 'unmeasured') return answer.reason;
  if (answer.answer === 'still')
    return answer.kind === kind ? 'nothing drawn changes' : `a ${answer.kind}, not a ${kind}`;
  return 'animates';
}

function channelParams(state: DagState, channelId: string) {
  const p = (state.nodes[channelId]?.params ?? {}) as { target?: unknown; paramPath?: unknown };
  return {
    target: typeof p.target === 'string' ? p.target : '',
    path: typeof p.paramPath === 'string' ? p.paramPath : '',
  };
}

/** A `kind` channel's `target` picker. */
export function channelTargetOptions(
  state: DagState,
  channelId: string,
  kind: PickedChannelKind,
): ParamOption[] {
  const { target, path } = channelParams(state, channelId);
  const options: ParamOption[] = [];
  for (const id of Object.keys(state.nodes)) {
    if (id === channelId) continue;
    const answer = pathsOn(state, id, kind);
    if (!answer) continue;
    let disabledReason: string | undefined;
    if (answer.enabled.length === 0) disabledReason = answer.blocked ?? 'nothing animates here';
    else if (path && !answer.enabled.some((p) => p.path === path))
      disabledReason = `${path} does not animate here — clear the path to choose it`;
    options.push({ value: id, label: nodeDisplayName(state.nodes, id), disabledReason });
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  // The channel's own target always has a row, and one that says why when it is not a choice
  // — "not found" would be false for a node that is right there.
  if (target && state.nodes[target] && !options.some((o) => o.value === target))
    options.unshift({
      value: target,
      label: nodeDisplayName(state.nodes, target),
      disabledReason: path
        ? whyNot(state, target, path, kind)
        : `nothing a ${kind} channel animates`,
    });
  return options;
}

/** A `kind` channel's `paramPath` picker: what animates on its current target. */
export function channelPathOptions(
  state: DagState,
  channelId: string,
  kind: PickedChannelKind,
): ParamOption[] {
  const { target, path } = channelParams(state, channelId);
  if (!target || !state.nodes[target]) return [];
  const answer = pathsOn(state, target, kind);
  const options: ParamOption[] = (answer?.enabled ?? []).map((p) => ({
    value: p.path,
    label: p.label,
  }));
  if (path && !options.some((o) => o.value === path))
    options.unshift({
      value: path,
      label: path,
      disabledReason: whyNot(state, target, path, kind),
    });
  return options;
}

/**
 * Why a `kind` channel's `paramPath` is read-only right now, or null when it can be picked.
 *
 * It is read-only when the channel's target is a node whose answer nobody has: the census
 * never placed it, or something else supplies every param of this kind on it. Offering a
 * list there would be offering guesses.
 */
export function channelPathLock(
  state: DagState,
  channelId: string,
  kind: PickedChannelKind,
): string | null {
  const { target } = channelParams(state, channelId);
  if (!target || !state.nodes[target]) return null;
  const answer = pathsOn(state, target, kind);
  if (answer && answer.enabled.length > 0) return null;
  if (answer?.blocked) return answer.blocked;
  if (kind === 'text') return 'only a ComfyUI workflow reads a text channel';
  if (comfyGraphOf(state, target)) return `this workflow's batch reads no ${kind} channel`;
  const subject = animatableSubjectOf(state, target);
  if (subject && isMeasuredSubject(subject)) return `no ${kind} param of ${subject} animates`;
  return `the census has not measured ${subject ?? 'this node'}`;
}

// The channel schemas ask the slot, not this module (a static import would be a load cycle
// through the node registry). Loading this module is what makes the pickers answer; `boot.ts`
// imports it, and the slot fails closed if nothing does.
installChannelPickers({
  targetOptions: channelTargetOptions,
  pathOptions: channelPathOptions,
  pathLock: channelPathLock,
});
