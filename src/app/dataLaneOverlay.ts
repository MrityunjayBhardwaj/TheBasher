// dataLaneOverlay — WHICH nodes feed a scene child's value overlay, and how each one's
// param path lands on the value the renderer reads (#522).
//
// ── WHAT WAS BROKEN, AND IT WAS NOT A MATERIAL PROBLEM ──────────────────────────────
//
// The render's overlay reached the animated data node with a SINGLE hop — the Object's
// `data` input. That was the data node until the operator stack moved onto the data lane;
// since then `data` names the TOP of the stack. So on any object carrying an operator the
// overlay collected channels targeting the OPERATOR and never the ones targeting the base,
// which is exactly where every write road correctly puts them.
//
// Measured in a browser, two cubes differing only by one modifier:
//
//   BoxData → ArrayModifier → Object   channel on the BoxData   #ff0000 → #ff0000
//   BoxData → Object        (control)  channel on the BoxData   #ff0000 → #0000ff
//
// Both mutator calls report success, both channels exist on the right node, the dopesheet
// draws both curves. Only the viewport disagrees, and nothing is logged. An ordinary
// geometry modifier is enough — no material operator involved.
//
// This is the same shape as the resolver reach fixed in #516: a walk of ONE edge is
// silently wrong the moment a splice puts a node into that edge. That fix landed on the
// write side; these render-side consumers kept the one hop.
//
// ── THE SECOND HALF: A LANE HAS PRECEDENCE, AND AN OVERLAY MUST RESPECT IT ───────────
//
// Widening the reach is not just "walk further", because the overlay patches the COMPOSED
// value — what the chain already cooked. Two things follow, and both are decided here
// rather than at the three call sites:
//
//   · A channel on a layer whose field a later layer SUPPLIES must not be written. The
//     base's colour under a forcing operator is a fallback, not the drawn value; writing
//     it would let the masked layer beat the operator, which is the inverse of the defect
//     and just as silent. Mute the operator and the same channel becomes the answer again
//     — the ownership walk says so, so nothing here has to know about muting.
//   · A channel on an OPERATOR needs translating. An override operator stores each channel
//     as a flat scalar (`color`), and the composed value carries the OpenPBR IR
//     (`material.base.color`). Rebasing the flat name would write `data.color`, which no
//     renderer reads — measured, and it is why placing the channel on the operator did not
//     paint either.
//
// ⚠️ THE OWNERSHIP WALK EVALUATES, so it is asked ONCE PER LANE and only when the lane
// holds something that can mask. A lane of plain geometry modifiers — the case the measured
// defect is about — pays NOTHING beyond the walk that finds it. This is the same guard
// `exposeParams` puts in front of the same call, and for the same reason ([[H48]]).
//
// REF: src/viewport/SceneFromDAG.tsx (the four overlay hooks that consume this),
//      src/app/objectDataBand.ts (`channelPathForBand` — where a path LANDS, once this has
//      said what the path IS), src/app/resolveMaterialFieldOwner.ts (the one ownership
//      walk), src/app/operatorChain.ts (the one lane walk); issues #522, #519, #516.

import type { DagState } from '../core/dag/state';
import type { Node } from '../core/dag/types';
import { linkedDataNodeId } from './resolveDataParamOwner';
import { isDataLaneOperator, isMaterialLaneOperator, singleRef } from './operatorChain';
import {
  MATERIAL_FIELD_IR_PATH,
  MATERIAL_OVERRIDE_FIELDS,
  resolveMaterialFieldOwners,
} from './resolveMaterialFieldOwner';

/** One node in the lane, with what its param paths mean on the composed value. */
export interface LaneOverlaySource {
  readonly nodeId: string;
  /**
   * This node's own spelling → the spelling the composed value carries, for the fields
   * this node actually SUPPLIES. Present only on a material operator, whose flat scalars
   * are a different vocabulary from the IR the value holds.
   */
  readonly translate?: Readonly<Record<string, string>>;
  /**
   * Paths on this node that a LATER layer supplies. An overlay entry on one of these is
   * dropped: it is a fallback the viewport is not currently drawing.
   */
  readonly masked?: ReadonlySet<string>;
}

/** The lane under `targetId`, base first, or [] when nothing is linked (a fused node). */
export function dataLaneNodeIds(state: DagState, targetId: string): string[] {
  const top = linkedDataNodeId(state, targetId);
  if (top === null) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = top;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    if (!isDataLaneOperator(state.nodes[cur])) break;
    cur = singleRef(state.nodes[cur], 'target')?.node;
  }
  return out.reverse();
}

/**
 * The lane's NODE OBJECTS, base first — the narrow slice a render consumer subscribes to.
 *
 * Pure and cheap on purpose: it never evaluates, so it is safe inside a zustand selector,
 * which `dataLaneOverlaySources` is NOT ([[H48]]). Structural sharing does the rest — a param
 * edit anywhere in the lane mints a new node object, so a shallow-compared subscription to
 * this is exactly the key the sources memo needs, and nothing wider.
 */
export function dataLaneNodes(state: DagState, targetId: string): Node[] {
  const out: Node[] = [];
  for (const id of dataLaneNodeIds(state, targetId)) {
    const node = state.nodes[id];
    if (node) out.push(node);
  }
  return out;
}

/**
 * Every node whose channels and held edits belong to `targetId`'s overlay, base first, each
 * carrying what its paths mean on the composed value.
 *
 * Returns `[]` for a node with no linked data, which is what keeps every fused node's
 * overlay byte-identical to before this existed.
 */
export function dataLaneOverlaySources(state: DagState, targetId: string): LaneOverlaySource[] {
  const lane = dataLaneNodeIds(state, targetId);
  if (lane.length === 0) return [];

  // The guard, and it is the whole performance story: a lane with nothing that can take
  // authority over a material field needs no ownership answer at all, so it never
  // evaluates. That covers every object in a default scene and every plain modifier stack
  // — including the graph the measured defect was found on.
  const canMask = lane.some(
    (id) => isMaterialLaneOperator(state.nodes[id]) || singleRef(state.nodes[id], 'material'),
  );
  if (!canMask) return lane.map((nodeId) => ({ nodeId }));

  const owners = resolveMaterialFieldOwners(state, targetId);
  return lane.map((nodeId) => {
    const isOperator = isMaterialLaneOperator(state.nodes[nodeId]);
    const translate: Record<string, string> = {};
    const masked = new Set<string>();
    for (const field of MATERIAL_OVERRIDE_FIELDS) {
      const irPath = MATERIAL_FIELD_IR_PATH[field];
      // The node's OWN spelling for this field: flat on an operator, the IR path anywhere
      // else. `resolveMaterialFieldOwner` carries the same bridge for the write roads.
      const own = isOperator ? field : irPath;
      if (owners[field]?.nodeId === nodeId) {
        if (isOperator) translate[own] = irPath;
      } else {
        masked.add(own);
      }
    }
    return {
      nodeId,
      ...(Object.keys(translate).length > 0 ? { translate } : {}),
      ...(masked.size > 0 ? { masked } : {}),
    };
  });
}

/**
 * `paramPath` as the composed value spells it, or null when this entry must not be written.
 *
 * Null is a real answer and not an error: a masked layer's channel still exists, still
 * evaluates, and still draws its curve in the dopesheet — it simply is not what the viewport
 * is showing while a later layer supplies that field. That is the same rule the inspector
 * states with its masking label, on the other side of the same fact.
 */
export function overlayPathOn(source: LaneOverlaySource, paramPath: string): string | null {
  const translated = source.translate?.[paramPath];
  if (translated !== undefined) return translated;
  return source.masked?.has(paramPath) ? null : paramPath;
}
