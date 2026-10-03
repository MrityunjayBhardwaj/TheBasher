// #1451 — an empty project holding only its Scene, `n_scene`, as its scene output: what an import's
// ops land in when a test wants nothing else in the graph. An import stands each of the file's root
// nodes under the scene (no wrapper Group since #1451), so every one of its ops applies here as it
// stands — the old trick of applying all but the last op (the wrapper Group's edge to a scene the
// test never made) has nothing left to trim.
import { applyOp, emptyDagState } from '../core/dag';
import type { DagState } from '../core/dag/state';

export function sceneOnlyState(sceneId = 'n_scene'): DagState {
  const state = applyOp(emptyDagState(), {
    type: 'addNode',
    nodeId: sceneId,
    nodeType: 'Scene',
    params: {},
  }).next;
  return { ...state, outputs: { ...state.outputs, scene: { node: sceneId, socket: 'out' } } };
}
