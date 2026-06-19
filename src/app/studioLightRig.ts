// studioLightRig — the pure read side of the 2D Light-Studio panel (epic #201,
// slice #206). Enumerates the rig's studio lights and derives the rig CENTRE
// (the shared aim point), so the panel can project each light to its puck via
// `studioLightPanelXY` (the placement core's inverse).
//
// A "studio light" on the panel = an `AreaLight` that is AIMED by a Track-To
// ([[V60]] — the rig aim). Placement on the rig sphere is the panel's whole job;
// the light keeps facing the centre via its own constraint, so an UN-aimed area
// light (a free fill light) is not a rig light and does not appear. This mirrors
// the enumeration discipline of nodeConstraints.ts (a flat scan of the edge-less
// node table) — no parallel walk.
//
// The rig centre is DERIVED, not stored: an explicit `LightRig` node is deferred
// to #208 profiles (Vairagya). For v1 the centre is the first rig light's
// resolved Track-To aim (first-wins, like trackToForTarget), defaulting to the
// world origin when there are no rig lights yet.
//
// REF: docs/OPERATORS-AND-LIGHTING-DESIGN.md §7.3; src/app/resolveStudioLightTransform.ts
//      (the placement core this feeds); src/app/nodeConstraints.ts (Track-To
//      enumeration + aim resolve); vyapti V60 (the aim), V37 (panel==viewport).

import type { DagState } from '../core/dag/state';
import type { EvalCtx, Node } from '../core/dag/types';
import type { EvaluatorCache } from '../core/dag/evaluator';
import { trackToForTarget, resolveTrackToTarget } from './nodeConstraints';
import { nodeDisplayName } from './sceneTreeWalk';
import { resolveActiveRigNode, resolveRigLightSources } from './resolveRigLightSources';

type Vec3 = [number, number, number];

/** One rig light as the panel sees it: where it sits (world position — lights are
 *  top-level, so the param position IS the world position) + its identity + its
 *  optional emitter texture (the §1.5 studio-light `tex`, V61). */
export interface StudioLightEntry {
  readonly nodeId: string;
  readonly position: Vec3;
  readonly name: string;
  readonly tex?: string;
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/**
 * Every `AreaLight` aimed by an active Track-To, in node-table order. These are
 * the rig lights the panel draws as pucks; an un-aimed area light is omitted (it
 * is not on the rig). Pure — a function of the node table.
 */
export function enumerateStudioLights(
  nodes: Readonly<Record<string, Node>>,
): StudioLightEntry[] {
  const out: StudioLightEntry[] = [];
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.type !== 'AreaLight') continue;
    if (!trackToForTarget(nodes, nodeId)) continue; // panel = rig-aimed lights only
    const p = node.params as { position?: unknown; tex?: unknown };
    out.push({
      nodeId,
      position: isVec3(p.position) ? p.position : [0, 0, 0],
      name: nodeDisplayName(node),
      tex: typeof p.tex === 'string' ? p.tex : undefined,
    });
  }
  return out;
}

/**
 * The rig CENTRE — the point the panel's pucks orbit. The first rig light's
 * resolved Track-To aim (world aim node via #202, else the fixed `aimPoint`),
 * or the world origin when there are no rig lights. Pure (state + ctx); threads
 * the shared evaluator `cache` so a per-frame caller hits the render cache.
 */
export function resolveRigTarget(
  state: DagState,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 {
  for (const nodeId of Object.keys(state.nodes)) {
    if (state.nodes[nodeId]?.type !== 'AreaLight') continue;
    const aim = resolveTrackToTarget(state, nodeId, ctx, cache);
    if (aim) return aim;
  }
  return [0, 0, 0];
}

/** Build a panel entry for one AreaLight node id (its world position is the param
 *  position — rig lights are top-level). */
function entryFor(nodes: Readonly<Record<string, Node>>, nodeId: string): StudioLightEntry | null {
  const node = nodes[nodeId];
  if (!node || node.type !== 'AreaLight') return null;
  const p = node.params as { position?: unknown; tex?: unknown };
  return {
    nodeId,
    position: isVec3(p.position) ? p.position : [0, 0, 0],
    name: nodeDisplayName(node),
    tex: typeof p.tex === 'string' ? p.tex : undefined,
  };
}

/**
 * The lights the panel should draw: the ACTIVE profile's lights when a profile is
 * live (scoped to the rig, in its edge order), else every Track-To-aimed AreaLight
 * (the pre-profile legacy fallback, so existing setups still show). The rig's edge
 * order keeps puck identity stable with the renderer's rig band
 * (`resolveRigLightSources`). Pure.
 */
export function enumerateActiveProfileLights(state: DagState): StudioLightEntry[] {
  const rigId = resolveActiveRigNode(state);
  if (!rigId) return enumerateStudioLights(state.nodes); // legacy: no profile yet
  const out: StudioLightEntry[] = [];
  for (const lightId of resolveRigLightSources(state)) {
    const e = entryFor(state.nodes, lightId);
    if (e) out.push(e);
  }
  return out;
}

/**
 * The aim centre the panel's pucks orbit: the ACTIVE rig's EXPLICIT `center` param
 * when a profile is live (the LightRig formalizes the centre, V63), else the
 * DERIVED centre (`resolveRigTarget` — the shared Track-To aim, pre-profile). Pure
 * (state + ctx); threads the shared evaluator `cache` for the derived path.
 */
export function resolveActiveRigCenter(
  state: DagState,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 {
  const rigId = resolveActiveRigNode(state);
  const rig = rigId ? state.nodes[rigId] : null;
  if (rig) {
    const c = (rig.params as { center?: unknown }).center;
    if (isVec3(c)) return c;
  }
  return resolveRigTarget(state, ctx, cache);
}
