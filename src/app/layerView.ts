// layerView — the pure read model for one row of a stack, derived from the DECLARED contract
// (a node's `ChainDeclaration`) and the render-identical resolver, NEVER from a node's
// implementation kind (#1894 S1).
//
// Two invariants hold this file together, both from the issue's "a layer spelled three ways, only
// one declared":
//
//   G3 — PURE VIEW. What a row IS comes from the contract, not from a kind flag. A row is a
//   constraint because its chain declares `section: 'constraint'` (S0b), not because the node
//   carries `worldStep`. There is NO branch here on `worldStep`, and no `switch`/`===` on a
//   registered node type. If a row needs a kind-branch to be correct, the contract is incomplete —
//   the fix is a new contract field, not a branch here.
//
//   read == render. The value a row SHOWS for an animatable amount is the value the renderer
//   composes, read through `resolveEvaluatedParam` — the render's own read (transient > channel >
//   driver > base, folded through `foldChannelValue`). A step's influence is a `Value` node's
//   `value` param, so the row reads its FOLDED value, not the raw `params.value` the graph stores:
//   a keyed or driven influence shows what actually renders. (The constraint's world transform
//   renders through a separate path, `worldStepFold`, but its settings are read through this SAME
//   resolver — see `constraintChain.ts` — so a read model built on it cannot drift from either.)
//
// Pure, so it is tested without a browser (`stackPanelModel.ts` re-exports it; `StackPanel.tsx`
// lays it out). Deterministic given (state, row, ctx).
//
// REF: issue #1894 (S1); docs/LAYER-PANEL-DESIGN.md; src/core/dag/types.ts (`ChainDeclaration`);
//      src/app/resolveEvaluatedParam.ts; src/app/stackTree.ts.

import type { z } from 'zod';
import { getNodeType, mainInputOfType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import { templatesOf } from '../core/dag/templates';
import type { EvalCtx } from '../core/dag/types';
import { poseLayerWeightOf, PoseLayerParams, type PoseLayerMode } from '../nodes/PoseLayer';
import { rowLaneOfType } from './operatorChain';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { nodeDisplayName } from './sceneTreeWalk';
import { muteParamOf } from './stackEdit';
import type { StackNodeRow } from './stackTree';

/** The playhead a row is read at when a caller gives none: scene time zero, like `attributeSheet`. */
const STATIC_CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** `TrackTo` reads "Track To"; a template type reads its definition's label. */
export function typeLabel(state: DagState, type: string): string {
  const template = templatesOf(state).get(type);
  if (template) return template.definition.label;
  return type.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

export const formatValue = (value: unknown): string => {
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
    return `(${value.map(formatValue).join(', ')})`;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value)?.slice(0, 24) ?? '—';
};

/** A param a wired input of the same name stands in for: its value is held, and not used. */
export interface Overridden {
  readonly param: string;
  readonly value: string;
}

/**
 * The pose-lane vocabulary a row on the `PosedSkeleton` lane carries (#1927 P1): the layer's blend
 * mode, its effective weight, and its solo. Null for every other row.
 *
 * KNOWN LIMITATION (Stage 2, for the shell): these four reads — `mode`, `weight`, `solo`, and the
 * `muted` above — do NOT capture EFFECTIVE SILENCE. A pose row can read "override, weight 1, not
 * soloed" and still render NOTHING: silenced by a soloed layer BELOW it (`PoseLayer.ts:593`), or
 * holding zero members (`:599,677`), or at weight ≤ 0 (`:677`). Modelling that is a later slice; a
 * surface built on this must not present an active-looking row as proof the layer is contributing.
 */
export interface PoseRowView {
  readonly mode: PoseLayerMode;
  /**
   * The effective weight the fold USES at `ctx` — read == render. `poseLayerWeightOf` samples the
   * layer's keyed weight (or its static `weight`) UNCLAMPED (`PoseLayer.ts:459`); the render fold
   * then clamps it to [0, 1] (`foldChannelValue`/`clamp01`) and treats weight ≤ 0 as NO
   * contribution (`PoseLayer.ts:677`). So this is the clamped value: a keyed 1.5 reads 1, a keyed
   * −0.2 reads 0 (off). Never the raw sample — that would show a number the renderer never uses.
   */
  readonly weight: number;
  readonly solo: boolean;
}

export interface RowView {
  readonly name: string;
  readonly type: string;
  /** What kind of row this is, in a word or two: "constraint", "blend · 3 inputs". */
  readonly tag: string | null;
  readonly overridden: readonly Overridden[];
  /** A template instance's exposed params with their values, unwired ones only. */
  readonly exposed: readonly Overridden[];
  /** A blended step's influence, FOLDED (read == render): its number, or that a wire drives it. */
  readonly influence: string | null;
  /** Null when the type has no mute. */
  readonly muted: boolean | null;
  /** The pose-lane vocabulary (mode/weight/solo), or null for a row off the `PosedSkeleton` lane. */
  readonly pose: PoseRowView | null;
}

/** What a person reads a node as: its name, or its type when nobody named it. */
export function nameOf(state: DagState, nodeId: string): string {
  const named = nodeDisplayName(state.nodes, nodeId);
  const type = state.nodes[nodeId]?.type;
  return named === nodeId && type ? typeLabel(state, type) : named;
}

/**
 * The read model for one stack row, from the declared contract + the render-identical resolver.
 * `ctx` is the playhead the folded values are read at; a static default reads scene time zero.
 */
export function layerView(state: DagState, row: StackNodeRow, ctx: EvalCtx = STATIC_CTX): RowView {
  const node = state.nodes[row.nodeId];
  const def = getNodeType(row.nodeType);
  const params = (node?.params ?? {}) as Record<string, unknown>;
  const wired = (socket: string) => node?.inputs[socket] !== undefined;
  const overridden = Object.keys(def?.inputs ?? {})
    .filter((socket) => socket in params && wired(socket))
    .map((param) => ({ param, value: formatValue(params[param]) }));
  const groups = row.groups.length;

  // The tag is read off the DECLARED contract: a constraint is one whose chain declares the
  // constraint section (S0b), NOT a node carrying `worldStep`. No kind-branch (G3).
  let tag: string | null = null;
  if (row.template) {
    tag = `template · ${row.template.instances} instance${row.template.instances === 1 ? '' : 's'}`;
  } else if (def?.chain?.section === 'constraint') tag = 'constraint';
  // An object's groups are its lanes, not operands of one operation, so it isn't counted.
  else if (mainInputOfType(row.nodeType) === null && groups > 1 && !def?.outputs.world) {
    tag = `${groups} inputs`;
  }

  // Influence reads what RENDERS, not what the graph stores: the factor is a `Value` node whose
  // `value` param may be keyed or driven, so its FOLDED value (resolveEvaluatedParam — the render's
  // own read) is what the row shows. null when nothing overrides it ⇒ the stored base, as before.
  const factor = row.blend?.factor;
  const holder = factor ? state.nodes[factor.node] : undefined;
  let influence: string | null;
  if (!row.blend) influence = null;
  else if (factor && holder?.type === 'Value') {
    const resolved = resolveEvaluatedParam(state, factor.node, 'value', ctx);
    const value = resolved ? resolved.value : (holder.params as { value?: unknown }).value;
    influence = formatValue(value);
  } else influence = 'wired';

  const mute = muteParamOf(def);

  // A pose row carries the layer vocabulary (mode/weight/solo). It is found by its LANE — the
  // `PosedSkeleton` lane, resolved from the DECLARED contract by P0's `rowLaneOf` (a row's main
  // input type), NEVER from `node.type` (G3). The lane alone is not enough: `Rig`, `LocomotionState`
  // and `RetargetClip` also stand on the pose lane but are carriers, not layers — so the vocabulary
  // is read only when the row's own PARAM contract declares it, the same way `muteParamOf` reads a
  // declared `mute`. That is still a contract read, not a kind-branch.
  let pose: PoseRowView | null = null;
  const shape = (def?.paramSchema as z.AnyZodObject | undefined)?.shape;
  if (
    rowLaneOfType(row.nodeType) === 'PosedSkeleton' &&
    shape !== undefined &&
    'mode' in shape &&
    'weight' in shape &&
    'solo' in shape
  ) {
    const poseParams = PoseLayerParams.parse(params);
    // read == render: show the weight the fold USES, clamped to [0, 1] with ≤ 0 reading as off (0),
    // not the raw unclamped sample. See `PoseRowView.weight`.
    const raw = poseLayerWeightOf(poseParams)(ctx.time.seconds);
    pose = {
      mode: poseParams.mode,
      weight: Math.max(0, Math.min(1, raw)),
      solo: poseParams.solo === true,
    };
  }

  return {
    // A node nobody named reads as its type: an id like `data_mw7iys99` says nothing to a person.
    name: nameOf(state, row.nodeId),
    type: typeLabel(state, row.nodeType),
    tag,
    overridden,
    exposed: (row.template?.exposed ?? [])
      .filter((param) => !wired(param))
      .map((param) => ({ param, value: formatValue(params[param]) })),
    influence,
    muted: mute ? params[mute] === true : null,
    pose,
  };
}
