// #1518 — the LOAD boundary for "every camera is in the scene".
//
// Add ▸ Camera used to leave its camera wired to nothing, and the scene counted every camera as held
// anyway. Now Add stands a camera in `Scene.children` and that exception is gone, so a project saved
// before this holds cameras the scene does not reach: `isInScene` says no, their eye and duplicate
// are gone, while the outliner and the viewport still list them (`enumerateCameraNodeIds` walks the
// node table). This stands each one where Add now would. Nothing else about it changes.
//
// A REPAIR, NOT A FORMAT STEP, for the reason `repairRoleBindings.ts` gives: the file is not a
// different format, the graph just does not hold what is now asked of it, and this asks again of
// every load. It runs after the format ladder, so the graph it judges is the one the app hydrates.
//
// Cameras only. An old unwired Group or Transform was never listed anywhere, has no eye and draws
// nothing, so nobody has met it: standing it in the scene now would surprise the file's author with
// empties they never saw, and #1824 converts what membership has to convert.
//
// REF: src/app/sceneMembership.ts; src/app/addPrimitives.ts; #1518, #1822, #1824.

import { isCameraNode } from '../../app/cameraNode';
import { sceneMembersOf } from '../../app/sceneMembership';
import { subnetworkOf } from '../dag/subnetworks';
import type { DagState } from '../dag/state';
import type { NodeId, NodeRef } from '../dag/types';

/**
 * `state` with every camera the scene does not reach standing in `Scene.children`, and which those
 * are. The SAME state when there are none. A camera inside a sub-network belongs to its owner.
 */
export function repairFloatingCameras(state: DagState): { state: DagState; repaired: NodeId[] } {
  const sceneId = state.outputs.scene?.node;
  const scene = sceneId ? state.nodes[sceneId] : undefined;
  if (!scene || !sceneId) return { state, repaired: [] };
  const members = sceneMembersOf(state);
  const floating = Object.keys(state.nodes).filter(
    (id) => isCameraNode(state, id) && !members.has(id),
  );
  if (floating.length === 0) return { state, repaired: [] };
  const owned = new Set<NodeId>();
  for (const id of Object.keys(state.nodes)) for (const n of subnetworkOf(state, id)) owned.add(n);
  const repaired = floating.filter((id) => !owned.has(id));
  if (repaired.length === 0) return { state, repaired: [] };
  const held = scene.inputs.children;
  const children: NodeRef[] = Array.isArray(held) ? held : held ? [held] : [];
  return {
    state: {
      ...state,
      nodes: {
        ...state.nodes,
        [sceneId]: {
          ...scene,
          inputs: {
            ...scene.inputs,
            children: [...children, ...repaired.map((node) => ({ node, socket: 'out' }))],
          },
        },
      },
    },
    repaired,
  };
}
