// #1448 — which nodes can be hidden, asked in ONE place.
//
// `meta.hidden` is a view flag (#227): the renderer skips a hidden node, and the offscreen
// render captures the live scene, so it is gone from both. It skips one only where the node
// is a direct entry of the Scene's `children` or `lights` band (`SceneFromDAG`), so a flag set
// anywhere else changes the row's glyph and nothing in the picture. Cameras are wired to
// `scene.camera`, not into either band, and are never hidden this way.
//
// The outliner's eye and the agent's hide verb (#1445) both ask this, so neither can offer
// to hide what the other refuses, and neither can report a hide the picture does not show.

import type { DagState } from '../core/dag/state';
import { isCameraNode } from './cameraNode';

type Ref = { node: string };

function sceneBand(state: DagState, socket: 'children' | 'lights'): readonly Ref[] {
  const sceneRef = state.outputs.scene;
  const scene = sceneRef ? state.nodes[sceneRef.node] : undefined;
  const refs = scene?.inputs[socket];
  return Array.isArray(refs) ? (refs as Ref[]) : [];
}

/** Why `nodeId` cannot be hidden, or null when hiding it removes it from the picture. */
export function hideRefusal(state: DagState, nodeId: string): string | null {
  const node = state.nodes[nodeId];
  if (!node) return `"${nodeId}" is not in the scene graph.`;
  if (isCameraNode(state, nodeId))
    return `"${nodeId}" is a camera; cameras are chosen with Set Active Camera, not hidden.`;
  const top =
    sceneBand(state, 'children').some((r) => r.node === nodeId) ||
    sceneBand(state, 'lights').some((r) => r.node === nodeId);
  if (!top)
    return (
      `"${nodeId}" (${node.type}) is not a direct child or light of the scene, and only those ` +
      'can be hidden; hide the top-level object that holds it.'
    );
  return null;
}

export function isHideable(state: DagState, nodeId: string): boolean {
  return hideRefusal(state, nodeId) === null;
}
