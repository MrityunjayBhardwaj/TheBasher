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
import { constraintStackForTarget, relationalPoseStackForTarget } from './nodeConstraints';
import { isAreaLightNode } from './lightNode';

type Vec3 = [number, number, number];

/** One profile as the bar sees it: the rig node + its name + whether it's live. */
export interface ProfileEntry {
  readonly rigId: string;
  readonly name: string;
  readonly active: boolean;
}

function rigName(nodes: Readonly<Record<string, Node>>, node: Node): string {
  // Takes BOTH the table and the node it already has: the table is what the display
  // resolver needs to follow a `data` edge, and the node is what the caller already
  // holds. Taking only an id would have made "no such node" representable here for the
  // first time, guarded by nothing but the caller iterating `Object.values`.
  const n = (node.params as { name?: unknown }).name;
  return typeof n === 'string' && n.length > 0 ? n : nodeDisplayName(nodes, node.id);
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
    out.push({
      rigId: node.id,
      name: rigName(state.nodes, node),
      active: node.id === activeRig,
    });
  }
  return out;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** A profile name not already taken by an existing rig (or by `taken`), suffixing
 *  with " (N)" on collision. The `LightProfileSelect` keys by NAME (V63), so a
 *  duplicate name would make the active profile ambiguous — every name-mint path
 *  (the "+ Profile" builder, JSON import) routes through here. */
export function uniqueProfileName(
  state: DagState,
  base: string,
  taken?: ReadonlySet<string>,
): string {
  const used = new Set(enumerateProfiles(state).map((p) => p.name));
  if (taken) for (const t of taken) used.add(t);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate)) return candidate;
  }
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
    // #386 C3 — a legacy studio light is now an Object posing an Area LightData (or a
    // still-fused AreaLight until its project migrates). Recognise both through `data`, or
    // the light this function exists to rescue vanishes from the first profile.
    if (!isAreaLightNode(state.nodes, ref.node)) continue;
    // AIMED by a Track-To → it's a rig light (studioLightRig discipline).
    // #317 — asked through the SHARED stack enumeration rather than a raw
    // `type === 'TrackTo'` scan. Muted members count: a bypassed aim still marks the
    // light as rig-authored (and the raw scan it replaces counted them too).
    // #339 — the AIM band specifically, and deliberately: this asks "is this light
    // rig-aimed?" (see the header), which only the aim band answers. A light that merely
    // follows a path is not "a rig light with no rig" and must not be adopted into a
    // profile. Contrast `constraintsForLights`, which asks "which nodes point at this
    // light" — a band-agnostic question that reads the type-agnostic scan.
    const aimed = constraintStackForTarget(state.nodes, ref.node, true).length > 0;
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
/** The BARE `LightRig` wired straight into `Scene.lightRig`, or null. */
function bareRigOnScene(state: DagState, sceneId: string): string | null {
  const binding = state.nodes[sceneId]?.inputs.lightRig;
  if (!binding || Array.isArray(binding)) return null;
  const wired = state.nodes[binding.node];
  return wired?.type === 'LightRig' ? wired.id : null;
}

/**
 * Ops that guarantee a `LightProfileSelect` feeds `Scene.lightRig` — ADOPTING a bare rig
 * that is wired there rather than displacing it (#789).
 *
 * ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────────────────
 *
 * A bare `LightRig` on `Scene.lightRig` is a legitimate state, and this file already knew
 * it: the delete path branches on detaching the rig "or directly from the scene". Only the
 * two MINT paths ignored it. `activeProfileSelect` answers `null` for a bare rig — correctly,
 * since there is no select — and both callers read that `null` as "no select exists", minted
 * one, and connected it onto the ALREADY-OCCUPIED `lightRig` socket. A single socket carries
 * one edge, so the authored edge was dropped with no `disconnect` and no `replace: true`.
 *
 * What the director lost was worse than one edge. The rig survives as a `LightRig`, so
 * `enumerateProfiles` keeps listing it — measured before the fix, "+ Profile" over an
 * authored rig gives `[Authored inactive, Key active]`, and re-selecting "Authored" leaves
 * `resolveActiveRigNode` answering **null**. A profile that is listed, looks selectable, and
 * selects to nothing.
 *
 * ── WHY ONE HELPER AND NOT TWO FIXES ─────────────────────────────────────────────────
 *
 * The `if (!selId)` block was duplicated verbatim across `buildAddProfileOps` and
 * `buildImportProfilesOps`. That duplication IS the defect's span — it is why one bug had two
 * sites — so the repair is one statement both callers share, and a third mint path cannot
 * reintroduce the gap by copying the old shape.
 *
 * ── ORDER IS LOAD-BEARING ────────────────────────────────────────────────────────────
 *
 * The detach comes FIRST. Connecting the select onto an occupied socket is precisely the
 * displacement being removed, so doing it before the disconnect would fix nothing and still
 * emit the `displaced-edge` badge.
 *
 * The adopted rig is not made active: "+ Profile" activates the profile it just added, which
 * is the behaviour that already held whenever a select existed. Adoption is about the rig
 * staying REACHABLE, not about which one is live.
 */
export function ensureProfileSelectOps(
  state: DagState,
  sceneId: string,
  selectedProfile: string,
): { selId: string; ops: Op[]; adoptedRigId: string | null } {
  const existing = activeProfileSelect(state);
  if (existing !== null) return { selId: existing, ops: [], adoptedRigId: null };

  const selId = newId('profsel');
  const adoptedRigId = bareRigOnScene(state, sceneId);
  const ops: Op[] = [];
  if (adoptedRigId !== null) {
    ops.push({
      type: 'disconnect',
      from: { node: adoptedRigId, socket: 'out' },
      to: { node: sceneId, socket: 'lightRig' },
    });
  }
  ops.push(
    {
      type: 'addNode',
      nodeId: selId,
      nodeType: 'LightProfileSelect',
      params: { selectedProfile },
    },
    {
      type: 'connect',
      from: { node: selId, socket: 'out' },
      to: { node: sceneId, socket: 'lightRig' },
    },
  );
  if (adoptedRigId !== null) {
    ops.push({
      type: 'connect',
      from: { node: adoptedRigId, socket: 'out' },
      to: { node: selId, socket: 'rigs' },
    });
  }
  return { selId, ops, adoptedRigId };
}

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
  // De-dupe the name — the select keys by name (V63), so a collision (e.g. after a
  // delete renumbers the "Profile N" count) would make the active profile ambiguous.
  name = uniqueProfileName(state, name);
  const rigId = newId('rig');

  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: rigId,
      nodeType: 'LightRig',
      params: { name, center, radius: 6 },
    },
  ];

  // Ensure the select exists and feeds the scene — adopting a bare rig rather than
  // displacing it (#789).
  const ensured = ensureProfileSelectOps(state, sceneId, name);
  const selId = ensured.selId;
  ops.push(...ensured.ops);
  ops.push({
    type: 'connect',
    from: { node: rigId, socket: 'out' },
    to: { node: selId, socket: 'rigs' },
  });
  // Activate the new profile (selectedProfile == its name). Even when the select
  // already existed, switch to the freshly added profile.
  ops.push({ type: 'setParam', nodeId: selId, paramPath: 'selectedProfile', value: name });

  // First profile adopts the legacy free studio lights so nothing disappears.
  if (isFirst) {
    for (const lightId of legacyStudioLightsOnScene(state)) {
      ops.push(
        {
          type: 'disconnect',
          from: { node: lightId, socket: 'out' },
          to: { node: sceneId, socket: 'lights' },
        },
        {
          type: 'connect',
          from: { node: lightId, socket: 'out' },
          to: { node: rigId, socket: 'lights' },
        },
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

/**
 * The constraint node ids on any of `lightIds` (edge-less, removable directly).
 *
 * #317 — enumerated through the SHARED stack rather than a raw `type === 'TrackTo'` scan,
 * so deleting a profile takes the light's WHOLE stack with it. The old scan matched one
 * hardcoded type: a light carrying a second constraint (now possible from the Constraints
 * panel, and a Follow-Path once it lands) would have left an ORPHAN node pointing at a
 * deleted light. `includeMuted` — a bypassed constraint is still a node, and still has to go.
 *
 * #339 — and "the WHOLE stack" means the TYPE-AGNOSTIC scan, not one band's view. This is a
 * DELETE: the question is "which nodes point at this light", which has nothing to do with
 * what any of them writes. Asking the aim band would resurrect the exact orphan the note
 * above describes — for the very node it was waiting for. (Follow-Path landed; the sentence
 * came true.) Contrast `legacyStudioLightsOnScene`, which asks a band-SPECIFIC question and
 * rightly reads the aim view.
 */
function constraintsForLights(state: DagState, lightIds: readonly string[]): string[] {
  return lightIds.flatMap((id) =>
    relationalPoseStackForTarget(state.nodes, id, true).map((c) => c.nodeId),
  );
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
  const trackToIds = constraintsForLights(state, lightIds);

  const ops: Op[] = [];

  // Detach + remove each light and its Track-To.
  for (const lightId of lightIds) {
    ops.push({
      type: 'disconnect',
      from: { node: lightId, socket: 'out' },
      to: { node: rigId, socket: 'lights' },
    });
  }
  for (const ttId of trackToIds) {
    ops.push({ type: 'removeNode', nodeId: ttId });
  }
  for (const lightId of lightIds) {
    ops.push({ type: 'removeNode', nodeId: lightId });
  }

  // Detach the rig from the select (or directly from the scene), then remove it.
  if (selId) {
    ops.push({
      type: 'disconnect',
      from: { node: rigId, socket: 'out' },
      to: { node: selId, socket: 'rigs' },
    });
  } else {
    const sceneRef = state.outputs.scene;
    if (sceneRef) {
      ops.push({
        type: 'disconnect',
        from: { node: rigId, socket: 'out' },
        to: { node: sceneRef.node, socket: 'lightRig' },
      });
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
