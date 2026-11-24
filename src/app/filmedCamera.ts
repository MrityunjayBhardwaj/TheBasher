// filmedCamera — the camera a render pass films through, as it is on screen at a time (#1950).
//
// A pass describes what it would render with a `sourceHash`. The graph is evaluated without its
// keyframe channels (they live off the graph), so a pass that hashed only its inputs saw a camera
// switch's AUTHORED camera at every frame: not the cuts, not a keyed camera move, and a move of the
// camera on screen in shot 2 did not reach it at all (measured on a 3-camera, 3-cut graph: 0 of 90
// hashes changed; moving the authored camera changed 90 of 90).
//
// So the evaluator asks this read for every node that declares `filmsCamera` and puts the answer in
// the node's cache key by its value. It goes through the resolver the render and the viewport film
// with: `cameraNodeAt` (the switch's cut at the time) and `resolveCameraPoseAt` (keys, aim, path,
// parent, held edits). One resolver, so the hash and the pixels cannot disagree about the camera.
//
// The record has the shape `workflowMadeFrom` hashes for a pass's camera, so that file can read
// its camera from here and keep the hashes it has already recorded.
//
// WHAT IT DOES NOT COVER: a pass with no camera wired keeps hashing its scene's camera as the scene
// value carries it (the authored one); `addPass` always wires one.
//
// REF: src/app/activeCamera.ts (`cameraNodeAt`, `resolveCameraPoseAt`);
//      src/core/dag/evaluator.ts (`setFilmedCamera`); src/nodes/passes/passHash.ts.

import { setFilmedCamera, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { NodeId, NodeRef } from '../core/dag/types';
import { cameraNodeAt, resolveCameraPoseAt, type CameraPose } from './activeCamera';
import { cameraDataOf, cameraLensParams } from './cameraNode';

/** What a pass films with at a time: the camera on screen, its resolved pose and its lens. */
export interface FilmedCamera {
  readonly id: NodeId;
  readonly pose: CameraPose;
  readonly lens: unknown;
  readonly data: NodeId | null;
}

function refOf(binding: unknown): NodeRef | undefined {
  return (Array.isArray(binding) ? binding[0] : binding) as NodeRef | undefined;
}

/**
 * The camera the pass `passId` films through at film time `seconds`: the camera behind its
 * `camera` wire (through a switch, the one its cut names then), posed as the render poses it.
 * Null when no camera is wired or the switch has none.
 */
export function filmedCameraAt(
  state: DagState,
  passId: NodeId,
  seconds: number,
  cache?: EvaluatorCache,
): FilmedCamera | null {
  const ref = refOf(state.nodes[passId]?.inputs.camera);
  if (!ref) return null;
  const camera = cameraNodeAt(state, ref.node, seconds);
  if (!camera) return null;
  const id = camera.id;
  return {
    id,
    pose: resolveCameraPoseAt(state, id, seconds, cache),
    lens: cameraLensParams(state, id) ?? state.nodes[id]?.params ?? null,
    data: cameraDataOf(state, id)?.id ?? null,
  };
}

/** Hands the evaluator this read. Called by `registerAllNodes`. */
export function registerFilmedCamera(): void {
  setFilmedCamera((state, nodeId, ctx, cache) =>
    filmedCameraAt(state, nodeId, ctx.time.seconds, cache),
  );
}
