// resolveEditTargetId — selection → the node that OWNS the animatable params.
//
// #160 (H40 grab-side asymmetry). When a param is keyframed, its node is wrapped
// in an AnimationLayer and the LAYER becomes the scene child (addLayer rewires
// Scene.children to the layer). A viewport click then selects the LAYER, not the
// wrapped node. Every EDIT — a held transient, a keyframe, a setParam — must land
// on the WRAPPED TARGET: the id the render overlay (AnimationLayerR's
// `animationTargetId`, SceneFromDAG.tsx) and the read resolvers
// (resolveEvaluatedTransform) key the transient by. If the edit lands on the
// LAYER id instead, the animation check (`paramAnimationState`) sees the layer as
// un-animated (the channel targets the box, not the layer) → no transient is set
// → the gizmo proxy moves while the rendered object stays frozen.
//
// The RENDER side already unwraps layer→target; this is the symmetric GRAB-side
// unwrap that #149 never added (its tests selected the box directly, never the
// layer a real click selects). Single-hop, mirroring SceneFromDAG.tsx's
// `animationTargetId` shape EXACTLY (Chesterton — do not invent a parallel walk).
// Identity for any non-AnimationLayer selection → byte-identical for the common
// box / sphere / glTF case.
import type { DagState } from '../../core/dag/state';

export function resolveEditTargetId(state: DagState, selectedId: string): string {
  const node = state.nodes[selectedId];
  if (node?.type !== 'AnimationLayer') return selectedId;
  const tb = node.inputs?.target;
  const tref = Array.isArray(tb) ? tb[0] : tb;
  const targetId = (tref as { node?: string } | undefined)?.node;
  return targetId ?? selectedId;
}
