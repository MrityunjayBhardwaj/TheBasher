// workflowMadeFrom — what a ComfyUI workflow's pictures are made from, over EVERY frame it makes
// (#1717). The hash `madeFrom` records when a run lands, and the one its stale badge compares.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY NOT THE NODE'S OWN HASH AT ITS FIRST FRAME (#1718)
// ─────────────────────────────────────────────────────────────────────────────
// #1718 compared the node's first output's `sourceHash` at its first frame. Two things that decide
// a shot's pictures were invisible to it:
//
//   1. Every frame after the first. A camera move in the middle of a shot changed nothing at the
//      shot's first frame, so the shot read current.
//   2. The camera the render actually films with. The graph is evaluated without its keyframe
//      channels (animation is sampled by the app, not the evaluator), so a render pass's own hash
//      sees the camera switch's AUTHORED camera at every frame: not the cuts, not a keyed camera,
//      and a move of the camera on screen in shot 2 does not reach it at all. Moving the
//      switch's authored camera instead reaches it at every frame, marking every shot stale.
//      (Measured on a 3-camera, 3-cut graph: moving shot 2's camera changed 0 of 90 pass hashes;
//      moving the authored camera changed 90 of 90.) #1950 put the camera on screen into the
//      pass's own hash, through the read this file takes its camera from (`filmedCameraAt`); the
//      keyed scene content below is still read here and not by the pass.
//
// So this reads a workflow the way its run reads it, frame by frame over the frames the run
// makes (`runFrameEnd`: a still-only workflow makes one), and reads a render pass the way the
// render draws it: the scene content at that frame (without the switch's authored camera), the
// camera on screen at that frame through the resolver the render and the viewport use
// (`filmedCameraAt` → `resolveCameraPoseAt`), and the samples, at that frame, of every keyframe
// channel on a node the scene is built from. Moving one shot's camera then changes the frames that
// camera is on screen for, and only those.
//
// Everything else arrives as the evaluator gives it: a still or a picture with a stored file by
// its own hash (a still workflow's edit reaches the shots it feeds by the wire, as in #1718), a
// number or text by its value, and the workflow file and image bindings whole.
//
// #1948 — and an unwired number or text input by its KEYED value at each frame, read through the
// run's own reader (`controllerValueReader`, `controller:<marker>`): the keys live off the graph,
// so the node's own hash never saw them. A key edit marks the workflow stale, putting it back marks
// it current, and a key on another node is not read. An un-keyed edit is written into the file.
//
// WHAT IT DOES NOT SEE YET: animation that reaches the scene through NLA strips or drivers rather
// than keyframe channels, and channels on nodes the scene is not built from.
//
// COST: one record per frame the workflow makes (~70 ms for a 10 s shot of the default scene,
// `workflowMadeFrom.test.ts`). Computed once per graph state however many badges ask, and only
// when something the workflow reads has changed: an edit elsewhere costs a walk of its upstream.
//
// REF: src/nodes/comfyWorkflowMade.ts (the states and the regenerate order, which take this hash);
//      src/nodes/ComfyUIWorkflow.ts (the node's own hash rule this mirrors for non-pass inputs);
//      src/app/filmedCamera.ts (`filmedCameraAt`); src/render/dryRun.ts (`runFrameEnd`,
//      `workflowInputsAt`, the run's own reading of the inputs).

import {
  evaluate,
  evaluateInputRef,
  topoSort,
  type EvaluatorCache,
} from '../../core/dag/evaluator';
import { hashValue } from '../../core/dag/hash';
import { getNodeType } from '../../core/dag/registry';
import { inputAvailable } from '../../core/dag/socketAvailability';
import type { DagState } from '../../core/dag/state';
import type { EvalCtx, Node, NodeId, NodeRef } from '../../core/dag/types';
import { textOf, workflowSocketsOf, type ComfyUIWorkflowParams } from '../../nodes/ComfyUIWorkflow';
import {
  regenerateOrder,
  workflowMadeState,
  type WorkflowHashFn,
  type WorkflowMadeState,
} from '../../nodes/comfyWorkflowMade';
import type { ImageValue, KeyframeChannelValue } from '../../nodes/types';
import { runFrameEnd } from '../../render/dryRun';
import { isCameraNode } from '../cameraNode';
import { filmedCameraAt } from '../filmedCamera';
import { keyframeChannelsTargeting } from '../nodeChannels';
import { sceneNodeId } from '../sceneRange';
import { controllerValueReader } from './controllerValue';

/** The runner's cadence (`runComfyUIWorkflow`). */
const FPS = 30;

/** Render pass node types, and the pass each draws. */
const PASS_OF_TYPE: Readonly<Record<string, string>> = {
  BeautyPass: 'beauty',
  DepthPass: 'depth',
  NormalPass: 'normal',
  IDPass: 'id',
};

const ctxAt = (frame: number): EvalCtx => ({
  time: { frame, seconds: frame / FPS, normalized: 0 },
});

function refOf(binding: unknown): NodeRef | undefined {
  return (Array.isArray(binding) ? binding[0] : binding) as NodeRef | undefined;
}

/** A node whose look the active-camera pose already carries: a camera (either half) or a switch. */
function isCameraSide(state: DagState, id: NodeId): boolean {
  const node = state.nodes[id];
  if (!node) return false;
  if (node.type === 'CameraSelect' || node.type === 'CameraData') return true;
  return isCameraNode(state, id);
}

/** What one render pass looks like at a frame, read the way the render draws it. */
interface PassReader {
  at(frame: number): unknown;
}

function passReader(state: DagState, pass: Node, cache: EvaluatorCache | undefined): PassReader {
  const sceneRef = refOf(pass.inputs.scene);
  // The channels on what the scene is built from, cameras aside (their pose arrives below).
  const channels: { id: NodeId; value: KeyframeChannelValue }[] = [];
  if (sceneRef) {
    for (const id of topoSort(state, sceneRef.node)) {
      if (isCameraSide(state, id)) continue;
      for (const ch of keyframeChannelsTargeting(state.nodes, id)) {
        const value = evaluate(state, ch.id, { cache, ctx: ctxAt(0) }).value as
          | KeyframeChannelValue
          | undefined;
        if (value && typeof value.sample === 'function') channels.push({ id: ch.id, value });
      }
    }
  }
  return {
    at(frame) {
      const seconds = frame / FPS;
      const scene = sceneRef
        ? (evaluateInputRef(state, pass.id, 'scene', sceneRef, { ctx: ctxAt(frame), cache })
            .value as Record<string, unknown> | undefined)
        : undefined;
      // The switch's AUTHORED camera rides in the scene value; the camera on screen is below.
      const content = scene ? { ...scene, camera: null } : null;
      return {
        pass: PASS_OF_TYPE[pass.type],
        params: pass.params,
        content,
        // #1950 — the read the pass's own hash takes its camera from.
        camera: filmedCameraAt(state, pass.id, seconds, cache),
        channels: channels.map((c) => [c.id, c.value.mute === true, c.value.sample(seconds)]),
      };
    },
  };
}

/**
 * The hash of what the workflow at `id` would make now, over every frame it makes. Null when it
 * cannot run (no node, no file, no output). `cache`: an evaluator cache to share.
 */
function computeWorkflowMadeFrom(
  state: DagState,
  id: NodeId,
  cache?: EvaluatorCache,
): string | null {
  const node = state.nodes[id];
  if (!node || node.type !== 'ComfyUIWorkflow') return null;
  const params = node.params as Partial<ComfyUIWorkflowParams>;
  if (!params.graph) return null;
  const sockets = workflowSocketsOf(params);
  if (sockets.outputs.length === 0) return null;
  const def = getNodeType(node.type)!;
  const first = params.frameStart ?? 0;
  const last = runFrameEnd(params, sockets);
  const anyFrames = sockets.outputs.some((o) => o.type === 'frames');

  // Each wired render pass, read the way the render draws it (one reader per pass node).
  const readers = new Map<NodeId, PassReader>();
  const readerOf = (passId: NodeId): PassReader | null => {
    const pass = state.nodes[passId];
    if (!pass || !PASS_OF_TYPE[pass.type]) return null;
    let r = readers.get(passId);
    if (!r) {
      r = passReader(state, pass, cache);
      readers.set(passId, r);
    }
    return r;
  };

  // #1948 — the keyed values of its own inputs, read as the run reads them (`controller:<marker>`).
  const keyedValue = controllerValueReader(state, id);

  const frames: unknown[] = [];
  for (let frame = first; frame <= last; frame++) {
    const ctx = ctxAt(frame);
    const inputs = sockets.inputs.map((input) => {
      const ref = refOf(node.inputs[input.socket]);
      if (!ref || !inputAvailable(def, node.params, input.socket)) {
        // #1948 — an unwired number or text input is sent its keyed value at this frame (the run's
        // own reader), else the file's default, which is in the hash with the file.
        const keyed =
          input.type === 'number' || input.type === 'text'
            ? keyedValue(input.nodeId, frame)
            : undefined;
        return [input.socket, keyed === undefined ? null : { keyed }];
      }
      const value = evaluateInputRef(state, id, input.socket, ref, { ctx, cache }).value;
      if (input.type === 'number') return [input.socket, value ?? null];
      if (input.type === 'text') return [input.socket, textOf(value)];
      const img = value as ImageValue | undefined;
      if (!img) return [input.socket, null];
      // A render pass straight off its node: what the render draws at the frame the run reads
      // (a still picked out of the pass's frames reads the frame it was picked at, #1716).
      const reader = img.storedAt ? null : readerOf(ref.node);
      if (reader) {
        const at =
          img.extent?.kind === 'still' && img.extent.pickedFrame !== undefined
            ? img.extent.pickedFrame
            : frame;
        return [input.socket, { rendered: reader.at(at) }];
      }
      return [input.socket, { passKind: img.passKind, sourceHash: img.sourceHash }];
    });
    frames.push({ frame: anyFrames ? frame : null, inputs });
  }

  return hashValue({
    madeFrom: 'workflow-range/1',
    graph: params.graph,
    imageBindings: params.imageBindings ?? {},
    outputs: sockets.outputs.map((o) => o.socket),
    frames,
  });
}

// One answer per (graph state, node): every badge, the regenerate order and the run read the same
// state, and an edit makes a new state object.
const memo = new WeakMap<DagState, Map<NodeId, string | null>>();

// ...and one answer per workflow while nothing it reads has changed. The graph is immutable and
// shares what an edit leaves alone, so "nothing it reads changed" is "every node it reads is the
// same object": the workflow and everything upstream of it (its passes, the scene and every node
// in it, the cameras, the switch), every node aimed at one of those (`params.target`: keyframe
// channels, drivers, the cut channel, the workflow's own keyed inputs), and the scene the project
// renders. Without this, an edit anywhere (a layer's opacity in the Video space, a cube in the 3D
// view) re-read every frame of every shot: ~0.4 s per edit for a 60 s film (#1717, measured).
const byWorkflow = new Map<
  NodeId,
  { readonly reads: readonly unknown[]; readonly hash: string | null }
>();

function readsOf(state: DagState, id: NodeId): unknown[] {
  const upstream = topoSort(state, id);
  const ids = new Set(upstream);
  const reads: unknown[] = [sceneNodeId(state)];
  for (const n of upstream) reads.push(state.nodes[n]);
  for (const node of Object.values(state.nodes)) {
    const target = (node.params as { target?: unknown } | undefined)?.target;
    if (typeof target === 'string' && ids.has(target)) reads.push(node);
  }
  return reads;
}

function sameReads(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** {@link computeWorkflowMadeFrom}, once per graph state and node, and reused while nothing the
 *  workflow reads has changed. */
export function workflowMadeFrom(
  state: DagState,
  id: NodeId,
  cache?: EvaluatorCache,
): string | null {
  let byNode = memo.get(state);
  if (!byNode) {
    byNode = new Map();
    memo.set(state, byNode);
  }
  if (byNode.has(id)) return byNode.get(id)!;
  const reads = state.nodes[id] ? readsOf(state, id) : [];
  const known = byWorkflow.get(id);
  const hash =
    known && sameReads(known.reads, reads) ? known.hash : computeWorkflowMadeFrom(state, id, cache);
  if (state.nodes[id]) byWorkflow.set(id, { reads, hash });
  byNode.set(id, hash);
  return hash;
}

// It is the hash the made states compare.
workflowMadeFrom satisfies WorkflowHashFn;

/** A workflow's made state, by {@link workflowMadeFrom}: the one every app reader compares. */
export function madeStateOf(
  state: DagState,
  id: NodeId,
  cache?: EvaluatorCache,
): WorkflowMadeState {
  return workflowMadeState(state, id, cache, workflowMadeFrom);
}

/** What regenerating `id` runs, by {@link workflowMadeFrom}: stale upstream workflows first. */
export function regenerateOrderOf(state: DagState, id: NodeId, cache?: EvaluatorCache): NodeId[] {
  return regenerateOrder(state, id, cache, workflowMadeFrom);
}
