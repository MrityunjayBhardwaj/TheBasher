// resolveRigLightSources — the node ids of the lights the ACTIVE rig contributes,
// in render order (epic #201, slice #208). The renderer renders the rig's lights
// as a parallel band to the scene's direct `lights`, and — exactly as it recovers
// a direct light's node id from `Scene.inputs.lights[i]` by index-correspondence —
// it recovers each RIG light's node id from this list so Track-To aim ([[V60]]) and
// click-to-select keep working for studio lights.
//
// The order MUST mirror `LightRig.evaluate`'s light order (the evaluator pushes a
// list input in binding order), so `lightRig.lights[i]` ↔ `resolveRigLightSources(state)[i]`.
// This is the SAME index-correspondence contract the Scene's direct lights hold;
// the value side (LightRig.evaluate) and the id side (here) both read the SAME
// `LightRig.inputs.lights` edge list, so they cannot drift.
//
// #208 increment 1 follows a LightRig wired DIRECTLY to `Scene.inputs.lightRig`.
// Increment 2 adds the LightProfileSelect hop (Scene → select → the named rig);
// the indirection is resolved here so the renderer stays oblivious to it.
//
// REF: src/nodes/LightRig.ts (the value side); src/viewport/SceneFromDAG.tsx
//      (the direct-light index-correspondence this mirrors); vyapti V62/V60.

import type { DagState } from '../core/dag/state';
import type { NodeRef } from '../core/dag/types';

/** The active rig node feeding `Scene.inputs.lightRig`, following a
 *  LightProfileSelect hop when one sits between (increment 2). null when no rig is
 *  wired. Pure — a function of the node table + the selector's param. */
export function resolveActiveRigNode(state: DagState): string | null {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return null;
  const sceneNode = state.nodes[sceneRef.node];
  const binding = sceneNode?.inputs.lightRig;
  if (!binding || Array.isArray(binding)) return null; // single-cardinality input
  const wired = state.nodes[(binding as NodeRef).node];
  if (!wired) return null;

  if (wired.type === 'LightRig') return wired.id;

  // LightProfileSelect (increment 2): pick the rig whose `name` matches the
  // selector's `selectedProfile`, scanning its `rigs` edges in order.
  if (wired.type === 'LightProfileSelect') {
    const selected = (wired.params as { selectedProfile?: unknown }).selectedProfile;
    const rigsBinding = wired.inputs.rigs;
    const refs: NodeRef[] = Array.isArray(rigsBinding)
      ? (rigsBinding as NodeRef[])
      : rigsBinding
        ? [rigsBinding as NodeRef]
        : [];
    for (const ref of refs) {
      const rig = state.nodes[ref.node];
      if (rig?.type === 'LightRig' && (rig.params as { name?: unknown }).name === selected) {
        return rig.id;
      }
    }
    return null;
  }

  return null;
}

/**
 * The ordered light node ids the active rig contributes (its `inputs.lights` edge
 * order), parallel to `SceneValue.lightRig.lights`. Empty when no rig is active.
 */
export function resolveRigLightSources(state: DagState): string[] {
  const rigId = resolveActiveRigNode(state);
  if (!rigId) return [];
  const rig = state.nodes[rigId];
  const binding = rig?.inputs.lights;
  if (!binding) return [];
  const refs: NodeRef[] = Array.isArray(binding) ? (binding as NodeRef[]) : [binding as NodeRef];
  return refs.map((r) => r.node);
}
