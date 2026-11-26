// animLayersModel — what the drawer's Anim Layers tab lists, and the edits its footer runs (#1956).
//
// The tab is a CONTAINER: the selected character's pose layers as rows over time, top applied last,
// with the locked base at the bottom (design board 14d). It owns no data. The rows are read off the
// one chain walk (`poseLayerChain`) and every edit goes through a road that already exists:
//   - + Add Layer and Delete are the shared stack edit (`planStackEdit`) on the Object's `pose` lane,
//     the same edit the stack panel runs, so a layer added here is the layer the stack panel shows;
//   - Bake down is the agent's own bake verb (`mutator.animate.bakePose`) at the selected layer: it
//     and the layers under it fold into keys on a new base and are muted, never removed.
// A layer's mode, weight, solo and mute are edited by the shared param rows in the pane, not here.
//
// Pure, so it is tested without a browser.
//
// REF: issue #1956; design board 14d (`LayerTwoContainers.dc.html`); src/app/animate/poseChain.ts;
//      src/app/stackEdit.ts; src/app/animate/bakePose.ts.

import type { DagState } from '../core/dag/state';
import type { NodeRef } from '../core/dag/types';
import { mainInputOfType } from '../core/dag/registry';
import type { PoseLayerParams } from '../nodes/PoseLayer';
import { poseLayerChain, type PoseLayerChain } from '../app/animate/poseChain';
import { freeBakedLayerId } from '../app/animate/bakePose';
import { planStackEdit } from '../app/stackEdit';
import { freshId, nameOf } from '../app/stackPanelModel';
import { stackOf, type StackNodeRow } from '../app/stackTree';
import type { Op } from '../core/dag/types';

/** One row of the tab: a pose layer, or a Rig the wire passes through (its layers are inside it). */
export interface AnimLayerRow {
  readonly id: string;
  readonly kind: 'layer' | 'rig';
  readonly name: string;
  /** A layer's blend mode; null on a Rig. */
  readonly mode: PoseLayerParams['mode'] | null;
  readonly weight: number | null;
  readonly mute: boolean;
  readonly solo: boolean;
  /** How many keys the layer's weight curve holds; 0 when the weight is not keyed over time. */
  readonly weightKeys: number;
  /** The base layer: the character's own motion. Not moved or deleted from this tab. */
  readonly locked: boolean;
}

/** Why the tab lists nothing. */
export type AnimLayersEmpty = 'nothing-selected' | 'not-a-character';

export interface AnimLayersView {
  /** The armature Object whose layers these are, or null. */
  readonly subject: string | null;
  readonly empty: AnimLayersEmpty | null;
  /** The layers above the base, top applied last (the Object reads `rows[0]` first). */
  readonly rows: readonly AnimLayerRow[];
  /** The chain's base layer (#1211), drawn locked at the bottom; null when the chain has none. */
  readonly base: AnimLayerRow | null;
  /** What the bottom of the chain reads (the skeleton's rest pose, a clip, a retarget), by name. */
  readonly source: string | null;
  /** Whether + Add Layer would be accepted here. */
  readonly canAdd: boolean;
}

const isArmature = (state: DagState, id: string): boolean => {
  const node = state.nodes[id];
  if (node?.type !== 'Object') return false;
  const data = (node.inputs.data as { node?: string } | undefined)?.node;
  return data !== undefined && state.nodes[data]?.type === 'Skeleton';
};

/** The armature a skinned mesh Object deforms by: the Armature modifier on its data lane. */
function armatureDeforming(state: DagState, objectId: string): string | null {
  let at = (state.nodes[objectId]?.inputs.data as { node?: string } | undefined)?.node;
  const limit = Object.keys(state.nodes).length;
  for (let n = 0; at && n <= limit; n++) {
    const node = state.nodes[at];
    if (!node) return null;
    if (node.type === 'ArmatureModifier') {
      const armature = (node.inputs.armature as { node?: string } | undefined)?.node;
      return armature && isArmature(state, armature) ? armature : null;
    }
    const main = mainInputOfType(node.type);
    at = main ? (node.inputs[main] as { node?: string } | undefined)?.node : undefined;
  }
  return null;
}

/**
 * The armature Object whose layers the tab lists for a selection: the armature itself, the mesh it
 * deforms, or the Object a selected pose layer (or Rig) poses. Null for anything else.
 */
export function animLayerSubjectOf(state: DagState, selectedId: string | null): string | null {
  if (!selectedId || !state.nodes[selectedId]) return null;
  if (isArmature(state, selectedId)) return selectedId;
  const type = state.nodes[selectedId].type;
  if (type === 'Object') return armatureDeforming(state, selectedId);
  if (type !== 'PoseLayer' && type !== 'Rig') return null;
  for (const id of Object.keys(state.nodes)) {
    if (!isArmature(state, id)) continue;
    const chain = poseLayerChain(state.nodes as never, id);
    if (chain.allLayers.includes(selectedId) || chain.hops.some((h) => h.id === selectedId)) {
      return id;
    }
  }
  return null;
}

function rowOf(state: DagState, id: string, kind: 'layer' | 'rig', locked: boolean): AnimLayerRow {
  const params = (state.nodes[id]?.params ?? {}) as Partial<PoseLayerParams>;
  const layer = kind === 'layer';
  return {
    id,
    kind,
    name: nameOf(state, id),
    mode: layer ? (params.mode ?? 'override') : null,
    weight: layer ? (params.weight ?? 1) : null,
    mute: layer && params.mute === true,
    solo: layer && params.solo === true,
    weightKeys: layer
      ? (params.channels ?? [])
          .filter((c) => c.component === 'weight')
          .reduce((n, c) => n + ((c as { keyframes?: unknown[] }).keyframes?.length ?? 0), 0)
      : 0,
    locked,
  };
}

const EMPTY = (subject: string | null, empty: AnimLayersEmpty | null): AnimLayersView => ({
  subject,
  empty,
  rows: [],
  base: null,
  source: null,
  canAdd: false,
});

export function animLayersView(state: DagState, selectedId: string | null): AnimLayersView {
  if (!selectedId || !state.nodes[selectedId]) return EMPTY(null, 'nothing-selected');
  const subject = animLayerSubjectOf(state, selectedId);
  if (subject === null) return EMPTY(null, 'not-a-character');
  const chain: PoseLayerChain = poseLayerChain(state.nodes as never, subject);
  const rows = chain.hops
    .filter((h) => h.id !== chain.base)
    .map((h) => rowOf(state, h.id, h.kind, false));
  return {
    subject,
    empty: null,
    rows,
    base: chain.base ? rowOf(state, chain.base, 'layer', true) : null,
    source: chain.source ? nameOf(state, chain.source.node) : null,
    canAdd: addLayerPlan(state, subject).ok,
  };
}

/** The rows whose name holds `text` (case ignored); blank text keeps them all. */
export function filterLayerRows(rows: readonly AnimLayerRow[], text: string): AnimLayerRow[] {
  const needle = text.trim().toLowerCase();
  return needle === '' ? [...rows] : rows.filter((r) => r.name.toLowerCase().includes(needle));
}

const outputOf = (subject: string): NodeRef => ({ node: subject, socket: 'out' });

/** The Object's row in the stack tree, and the full rows of its `pose` lane, output-first. */
function poseLane(state: DagState, subject: string) {
  const top = stackOf(state, outputOf(subject))[0];
  if (top?.kind !== 'node') return null;
  const group = top.groups.find((g) => g.socket === 'pose');
  return { top, rows: group?.rows ?? [] };
}

export type AnimLayerPlan =
  | { readonly ok: true; readonly ops: Op[]; readonly nodeId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * + Add Layer: a new pose layer on top of the chain (applied last), through the shared stack edit.
 * The layer starts as the stack edit leaves it: override, weight 1, no bones, so nothing moves.
 */
export function addLayerPlan(state: DagState, subject: string): AnimLayerPlan {
  if (!isArmature(state, subject)) {
    return { ok: false, reason: 'Pose layers sit on a character’s armature.' };
  }
  const lane = poseLane(state, subject);
  if (!lane) return { ok: false, reason: 'This character has no pose lane.' };
  const first = lane.rows[0];
  const nodeId = freshId(state, 'PoseLayer');
  const plan = planStackEdit(state, outputOf(subject), {
    kind: 'add',
    nodeId,
    nodeType: 'PoseLayer',
    place: first ? { above: first.key } : { route: { owner: lane.top.key, socket: 'pose' } },
  });
  return plan.ok ? { ok: true, ops: plan.ops, nodeId } : { ok: false, reason: plan.reason };
}

/** Delete: the layer goes, and the wire joins back up around it, through the shared stack edit. */
export function deleteLayerPlan(state: DagState, subject: string, layerId: string): AnimLayerPlan {
  const chain = poseLayerChain(state.nodes as never, subject);
  if (layerId === chain.base) {
    return { ok: false, reason: 'The base is the character’s own motion; a bind replaces it.' };
  }
  const lane = poseLane(state, subject);
  const row = lane?.rows.find((r): r is StackNodeRow => r.kind === 'node' && r.nodeId === layerId);
  if (!row || !chain.hops.some((h) => h.id === layerId)) {
    return { ok: false, reason: 'That is not a layer of this character.' };
  }
  const plan = planStackEdit(state, outputOf(subject), { kind: 'delete', row: row.key });
  return plan.ok
    ? { ok: true, ops: plan.ops, nodeId: layerId }
    : { ok: false, reason: plan.reason };
}

/** The bake verb's spec for Bake down at `layerId`, or null where there is nothing to bake down. */
export function bakeDownArgs(
  state: DagState,
  subject: string,
  layerId: string,
): {
  object: string;
  at: string;
  poses: 'every';
  interpolation: 'linear';
  layerId: string;
} | null {
  const chain = poseLayerChain(state.nodes as never, subject);
  if (layerId === chain.base || !chain.layers.includes(layerId)) return null;
  return {
    object: subject,
    at: layerId,
    poses: 'every',
    interpolation: 'linear',
    layerId: freeBakedLayerId(state, subject),
  };
}

/** The layer-state fields the footer toggles. */
export type LayerToggle = 'mute' | 'solo';

/**
 * Mute / Solo from the footer: the spec of the agent's own layer-state verb
 * (`mutator.pose.setPoseLayerState`, #1927), flipping one field of the picked layer, so the tab
 * and the agent change a layer's state by one road (UI == agent). Null where the row has no such
 * state to flip here: a Rig, or the locked base (the character's own motion).
 */
export function layerToggleArgs(
  row: AnimLayerRow,
  field: LayerToggle,
): { layerId: string; mute?: boolean; solo?: boolean } | null {
  if (row.kind !== 'layer' || row.locked) return null;
  return field === 'mute'
    ? { layerId: row.id, mute: !row.mute }
    : { layerId: row.id, solo: !row.solo };
}
