// The viewport's selectable UNIVERSE — the top-level scene objects a box-select
// (or a future Select-All) considers. A Blender user box-selecting expects to
// catch meshes, lights AND cameras, so this gathers all three of the Scene's
// object sockets: `children` (meshes/groups), `lights`, and the active `camera`.
//
// Pure — a function of DagState, no store reads. Mirrors how resolveWorldTransform
// reaches each kind (children/lights via index-correspondence, camera by node
// type), so every id returned here resolves to a world origin there.
//
// Out of scope (same boundary resolveWorldTransform documents): rig-profile lights
// (nested inside a LightRig), glTF children (name-addressed inside an asset), and
// Scatter/Character sub-objects — none are addressable top-level scene objects.

import type { DagState } from '../core/dag/state';
import type { NodeRef } from '../core/dag/types';

function refNodes(binding: unknown): string[] {
  if (Array.isArray(binding)) {
    return (binding as NodeRef[]).map((r) => r?.node).filter((n): n is string => Boolean(n));
  }
  const ref = binding as NodeRef | undefined;
  return ref && typeof ref === 'object' && 'node' in ref ? [ref.node] : [];
}

/** Top-level selectable node ids in scene order: children, then lights, then the
 *  active camera. Empty when there's no scene. */
export function getViewportSelectableIds(state: DagState): string[] {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return [];
  const scene = state.nodes[sceneRef.node];
  if (!scene) return [];
  return [
    ...refNodes(scene.inputs.children),
    ...refNodes(scene.inputs.lights),
    ...refNodes(scene.inputs.camera),
  ];
}
