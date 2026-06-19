// studioProfiles — the app-layer reader + Op-builders for lighting PROFILES (epic
// #201, slice #208; §7.5). Grounds the BLS "Profiles" panel onto Basher's
// substrate ([[V63]]): one `LightRig` = one profile (groups its lights + owns the
// aim centre/radius), a `LightProfileSelect` picks the live one by name. This
// module is the panel's view over those nodes + the atomic Op chains that create,
// switch, and delete a profile — every mutation is a `dispatchAtomic` (V1), so it
// saves / undoes / animates for free.
//
// Grounded in BLS `light_profiles.py` (read end-to-end): a profile owns a handle
// (the aim centre) + its lights; switching links the chosen profile and unlinks the
// rest; "+ profile" adds one; deleting a profile removes its light subtree. Basher's
// switch is BETTER than BLS's link/unlink — it's a single `selectedProfile` param,
// so a profile change is keyframeable (V57).
//
// REF: src/nodes/LightRig.ts; src/nodes/LightProfileSelect.ts;
//      src/app/resolveRigLightSources.ts (the matching renderer hop);
//      src/app/studioLightRig.ts (enumerateStudioLights — legacy free lights);
//      /tmp/bls-study/src/light_profiles.py (the grounded reference); vyapti V63.

import type { DagState } from '../core/dag/state';
import type { Node } from '../core/dag/types';
import type { Op } from '../core/dag/types';
import { nodeDisplayName } from './sceneTreeWalk';
import { resolveActiveRigNode } from './resolveRigLightSources';

type Vec3 = [number, number, number];

/** One profile as the bar sees it: the rig node + its name + whether it's live. */
export interface ProfileEntry {
  readonly rigId: string;
  readonly name: string;
  readonly active: boolean;
}

function rigName(node: Node): string {
  const n = (node.params as { name?: unknown }).name;
  return typeof n === 'string' && n.length > 0 ? n : nodeDisplayName(node);
}

/** The `LightProfileSelect` feeding `Scene.inputs.lightRig`, or null. Single-input. */
export function activeProfileSelect(state: DagState): string | null {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return null;
  const binding = state.nodes[sceneRef.node]?.inputs.lightRig;
  if (!binding || Array.isArray(binding)) return null;
  const wired = state.nodes[binding.node];
  return wired?.type === 'LightProfileSelect' ? wired.id : null;
}

/** Every profile (LightRig) in the DAG + which is the live one (the active rig).
 *  Pure — a function of the node table. */
export function enumerateProfiles(state: DagState): ProfileEntry[] {
  const activeRig = resolveActiveRigNode(state);
  const out: ProfileEntry[] = [];
  for (const node of Object.values(state.nodes)) {
    if (node.type !== 'LightRig') continue;
    out.push({ rigId: node.id, name: rigName(node), active: node.id === activeRig });
  }
  return out;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** A studio light wired DIRECTLY into `Scene.inputs.lights` (the pre-profile legacy
 *  path from #205–#207) that is aimed by a Track-To — i.e. a rig light with no rig.
 *  The first profile ADOPTS these so existing setups don't vanish when scoping
 *  begins (the BLS "create studio" bootstrapping). */
function legacyStudioLightsOnScene(state: DagState): string[] {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return [];
  const binding = state.nodes[sceneRef.node]?.inputs.lights;
  const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
  const out: string[] = [];
  for (const ref of refs) {
    const n = state.nodes[ref.node];
    if (n?.type !== 'AreaLight') continue;
    // A Track-To targets it → it's a rig light (studioLightRig discipline).
    const aimed = Object.values(state.nodes).some(
      (t) => t.type === 'TrackTo' && (t.params as { target?: unknown }).target === ref.node,
    );
    if (aimed) out.push(ref.node);
  }
  return out;
}

export interface AddProfileResult {
  readonly ops: Op[];
  readonly rigId: string;
  readonly name: string;
}

/**
 * Build the Op chain for a new profile named `name`, aimed at `center`:
 *  - add a `LightRig`;
 *  - ensure a `LightProfileSelect` feeds `Scene.inputs.lightRig` (create + wire it
 *    on the first profile), and connect the rig into it;
 *  - select the new profile (one `setParam`);
 *  - on the FIRST profile, ADOPT any legacy free studio lights into the rig
 *    (disconnect from `scene.lights`, connect to `rig.lights`) so they aren't
 *    hidden once the panel scopes to the active profile.
 * Returns null when the scene aggregator is missing (a corrupt project).
 */
export function buildAddProfileOps(
  state: DagState,
  name: string,
  center: Vec3,
): AddProfileResult | null {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return null;
  const sceneId = sceneRef.node;

  const existingProfiles = enumerateProfiles(state);
  const isFirst = existingProfiles.length === 0;
  const rigId = newId('rig');

  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: rigId,
      nodeType: 'LightRig',
      params: { name, center, radius: 6 },
    },
  ];

  // Ensure the select exists and feeds the scene.
  let selId = activeProfileSelect(state);
  if (!selId) {
    selId = newId('profsel');
    ops.push(
      { type: 'addNode', nodeId: selId, nodeType: 'LightProfileSelect', params: { selectedProfile: name } },
      { type: 'connect', from: { node: selId, socket: 'out' }, to: { node: sceneId, socket: 'lightRig' } },
    );
  }
  ops.push({ type: 'connect', from: { node: rigId, socket: 'out' }, to: { node: selId, socket: 'rigs' } });
  // Activate the new profile (selectedProfile == its name). Even when the select
  // already existed, switch to the freshly added profile.
  ops.push({ type: 'setParam', nodeId: selId, paramPath: 'selectedProfile', value: name });

  // First profile adopts the legacy free studio lights so nothing disappears.
  if (isFirst) {
    for (const lightId of legacyStudioLightsOnScene(state)) {
      ops.push(
        { type: 'disconnect', from: { node: lightId, socket: 'out' }, to: { node: sceneId, socket: 'lights' } },
        { type: 'connect', from: { node: lightId, socket: 'out' }, to: { node: rigId, socket: 'lights' } },
      );
    }
  }

  return { ops, rigId, name };
}

/** Switch the live profile to the rig named `name` (one keyframeable param). Null
 *  when there is no select node yet (no profiles exist). */
export function buildSelectProfileOp(state: DagState, name: string): Op | null {
  const selId = activeProfileSelect(state);
  if (!selId) return null;
  return { type: 'setParam', nodeId: selId, paramPath: 'selectedProfile', value: name };
}

/** The light node ids a rig groups (its `inputs.lights` edge sources). */
function rigLightIds(state: DagState, rigId: string): string[] {
  const binding = state.nodes[rigId]?.inputs.lights;
  const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
  return refs.map((r) => r.node);
}

/** The Track-To node ids aiming any of `lightIds` (edge-less, removable directly). */
function trackTosForLights(state: DagState, lightIds: readonly string[]): string[] {
  const set = new Set(lightIds);
  const out: string[] = [];
  for (const n of Object.values(state.nodes)) {
    if (n.type !== 'TrackTo') continue;
    const t = (n.params as { target?: unknown }).target;
    if (typeof t === 'string' && set.has(t)) out.push(n.id);
  }
  return out;
}

/**
 * Build the Op chain to DELETE a profile (its rig + its lights + their Track-Tos),
 * mirroring BLS's profile delete (the light subtree goes with the profile). The
 * order respects `removeNode`'s "refuse while consumed" rule: disconnect lights
 * from the rig and the rig from the select first, then remove. When the deleted
 * profile was live, re-point the select to another remaining profile (or '').
 * Returns null when the rig is not found.
 */
export function buildDeleteProfileOps(state: DagState, rigId: string): Op[] | null {
  const rig = state.nodes[rigId];
  if (!rig || rig.type !== 'LightRig') return null;

  const selId = activeProfileSelect(state);
  const lightIds = rigLightIds(state, rigId);
  const trackToIds = trackTosForLights(state, lightIds);

  const ops: Op[] = [];

  // Detach + remove each light and its Track-To.
  for (const lightId of lightIds) {
    ops.push({ type: 'disconnect', from: { node: lightId, socket: 'out' }, to: { node: rigId, socket: 'lights' } });
  }
  for (const ttId of trackToIds) {
    ops.push({ type: 'removeNode', nodeId: ttId });
  }
  for (const lightId of lightIds) {
    ops.push({ type: 'removeNode', nodeId: lightId });
  }

  // Detach the rig from the select (or directly from the scene), then remove it.
  if (selId) {
    ops.push({ type: 'disconnect', from: { node: rigId, socket: 'out' }, to: { node: selId, socket: 'rigs' } });
  } else {
    const sceneRef = state.outputs.scene;
    if (sceneRef) {
      ops.push({ type: 'disconnect', from: { node: rigId, socket: 'out' }, to: { node: sceneRef.node, socket: 'lightRig' } });
    }
  }
  ops.push({ type: 'removeNode', nodeId: rigId });

  // If the deleted profile was live, re-point the select to a survivor (or clear).
  if (selId) {
    const wasActive = resolveActiveRigNode(state) === rigId;
    if (wasActive) {
      const survivor = enumerateProfiles(state).find((p) => p.rigId !== rigId);
      ops.push({
        type: 'setParam',
        nodeId: selId,
        paramPath: 'selectedProfile',
        value: survivor?.name ?? '',
      });
    }
  }

  return ops;
}
