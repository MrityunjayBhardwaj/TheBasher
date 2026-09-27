// Which character a node names: the nodes reached by walking up its input edges (#1213).
//
// One rule, read by the two gestures that turn "what is selected" into "which character": binding a
// motion (`bindMotionToCharacter.ts`) and locking the view to it (`viewport/followScan.ts`, #1275).
// A second walk for either would let the two disagree about which rig a click on a body names.
//
// It reaches a rig's armature Object only through edges a character is built from: the armature
// Object itself, a mesh Object it deforms (`data` → Armature modifier → `armature`, the one
// object-typed input that names an armature, `ArmatureModifier.ts`), or something that holds either
// (`children`). A prop parented to a bone does not reach it: the prop is the armature's CHILD
// (`parentBone` is a param, `ObjectNode.ts`), and the walk goes up inputs only.

import type { DagState } from '../../core/dag/state';

/**
 * The nodes a selection reaches by walking up input edges, a bounded three levels (#1213): the armature
 * Object itself, the skinned mesh's Object (data → Armature modifier → armature), and the Object the
 * import hangs both under (children → mesh Object → modifier → armature). Bounded so it never turns
 * into a search of the graph.
 */
export function reachedFromSelection(state: DagState, selectedNodeId: string): Set<string> {
  // Breadth-first, so each node is expanded at the SHALLOWEST depth it is reached: a depth-first walk
  // that met a node deep first would never expand it again from a shorter path.
  const reached = new Set<string>([selectedNodeId]);
  let frontier = [selectedNodeId];
  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const socket of Object.values(state.nodes[nodeId]?.inputs ?? {})) {
        const conns = Array.isArray(socket) ? socket : socket ? [socket] : [];
        for (const conn of conns) {
          if (!conn?.node || reached.has(conn.node) || !state.nodes[conn.node]) continue;
          reached.add(conn.node);
          next.push(conn.node);
        }
      }
    }
    frontier = next;
  }
  return reached;
}
