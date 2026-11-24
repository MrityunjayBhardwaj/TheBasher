// shotClips — the Video space's one clip per shot (#1717, design board 12a).
//
// A shot is a stretch of film time and the camera filming it, read off the camera cuts
// (`shots.ts`); nothing stores one. A shot CLIP is a Layer in the composition whose source is that
// shot's ComfyUI workflow node, fed by the shot's render passes. Nothing stores the tie between a
// shot and its clip either: a shot's workflow is the workflow node with a frames output whose
// first frame falls inside the shot (the rule #1718's Generated tab reads a shot's video
// workflows by), and its clip is the layer that reads that workflow. Re-cutting the shots moves
// which clip a shot has; it cannot leave a record behind that disagrees with the film.
//
// "Make shot clips" adds, for each shot that has none: the workflow (Basher's built-in stylized
// workflow by default) over the shot's frames, with the render passes it asks for wired into it
// (beauty, depth and normal off the scene, through the scene's own camera, so each frame is
// filmed by the camera on screen then), and a layer that starts where the shot does and lasts as
// long. The passes are reused when the graph already has them wired that way.
//
// Each clip reads generated, stale (an input moved since; its old pictures stay until it is
// regenerated), not generated, or cannot run, through the made state every reader compares
// (`madeStateOf`, which covers every frame of the shot).
//
// V8: pure. The Ops are built here and dispatched by `shotClipActions.ts`.
//
// REF: src/app/shots.ts; src/app/generated/generatedStill.ts (`shotFrameRange`, the shot ↔
//      workflow rule); src/app/render/workflowMadeFrom.ts; src/app/video/addLayer.ts
//      (`buildAddLayerOps`); src/agent/mutators/builders/addAIPass.ts (passes wired by socket name).

import { applyOp } from '../../core/dag';
import type { EvaluatorCache } from '../../core/dag/evaluator';
import type { DagState } from '../../core/dag/state';
import type { NodeId, NodeRef, Op } from '../../core/dag/types';
import {
  STYLIZED_REALISM_META,
  STYLIZED_REALISM_WORKFLOW,
} from '../../core/comfy/builtinWorkflows';
import type { ComfyApiJson, ComfyGraphMeta } from '../../core/comfy/comfyGraph';
import { workflowSocketsOf, type ComfyUIWorkflowParams } from '../../nodes/ComfyUIWorkflow';
import type { WorkflowMadeState } from '../../nodes/comfyWorkflowMade';
import { shotFrameRange } from '../generated/generatedStill';
import { madeStateOf } from '../render/workflowMadeFrom';
import { shotsOf, type Shot } from '../shots';
import { sceneEndSeconds } from '../sceneRange';
import { buildAddLayerOps, freshLayerId } from './addLayer';
import { compositionLayerIds } from './videoLayers';
import { resolveEffectBase } from '../operatorStack';

/** The runner's cadence: workflow frames are film frames at 30 fps. */
const FILM_FPS = 30;

/** Where shot workflows write: their render passes are read beside them (`passFramePath`). */
export const SHOT_RENDER_DIR = 'renders/shots';

/** The render passes a workflow reads by socket name, and the node type that draws each. */
const PASS_TYPE: Readonly<Record<string, string>> = {
  beauty: 'BeautyPass',
  depth: 'DepthPass',
  normal: 'NormalPass',
  id: 'IDPass',
};

/** One shot and its clip, as the Video space shows it. */
export interface ShotClip {
  readonly shot: Shot;
  /** The shot's workflow node, or null when it has none yet. */
  readonly workflowId: NodeId | null;
  /** The layer in the composition that reads that workflow, or null. */
  readonly layerId: NodeId | null;
}

function refOf(binding: unknown): NodeRef | undefined {
  return (Array.isArray(binding) ? binding[0] : binding) as NodeRef | undefined;
}

function workflowParams(state: DagState, id: NodeId): Partial<ComfyUIWorkflowParams> | null {
  const node = state.nodes[id];
  return node?.type === 'ComfyUIWorkflow' ? (node.params as Partial<ComfyUIWorkflowParams>) : null;
}

/** True when the workflow at `id` makes frames (the kind of workflow a shot clip holds). */
function makesFrames(state: DagState, id: NodeId): boolean {
  const params = workflowParams(state, id);
  return !!params?.graph && workflowSocketsOf(params).outputs.some((o) => o.type === 'frames');
}

/** The workflow node a layer reads (through any effects on it), or null. */
export function layerWorkflowOf(state: DagState, layerId: NodeId): NodeId | null {
  const src = refOf(state.nodes[layerId]?.inputs?.source);
  if (!src) return null;
  const base = resolveEffectBase(state, src.node);
  return state.nodes[base]?.type === 'ComfyUIWorkflow' ? base : null;
}

/** The shot's workflows: frames-making workflow nodes whose first frame is inside the shot. */
export function shotWorkflowIds(state: DagState, shot: Pick<Shot, 'start' | 'end'>): NodeId[] {
  const { start, endExclusive } = shotFrameRange(shot);
  return Object.keys(state.nodes)
    .sort()
    .filter((id) => {
      if (!makesFrames(state, id)) return false;
      const first = workflowParams(state, id)!.frameStart ?? 0;
      return first >= start && first < endExclusive;
    });
}

/** The film's shots, each with its workflow and its clip in `compId`. A shot's workflow is the
 *  one a layer of the composition reads, else its first in id order. */
export function shotClipsOf(state: DagState, compId: NodeId): ShotClip[] {
  const layerOf = new Map<NodeId, NodeId>();
  for (const layerId of compositionLayerIds(state, compId)) {
    const wf = layerWorkflowOf(state, layerId);
    if (wf && !layerOf.has(wf)) layerOf.set(wf, layerId);
  }
  return shotsOf(state, sceneEndSeconds(state)).shots.map((shot) => {
    const ids = shotWorkflowIds(state, shot);
    const workflowId = ids.find((id) => layerOf.has(id)) ?? ids[0] ?? null;
    return { shot, workflowId, layerId: workflowId ? (layerOf.get(workflowId) ?? null) : null };
  });
}

/** A shot clip's state: its workflow's made state, or `unmade` when it has no workflow yet. */
export function shotClipState(
  state: DagState,
  clip: ShotClip,
  cache?: EvaluatorCache,
): WorkflowMadeState {
  return clip.workflowId ? madeStateOf(state, clip.workflowId, cache) : 'unmade';
}

/** The shots' workflows that need generating, in film order: stale or never made. */
export function shotsToGenerate(state: DagState, compId: NodeId, cache?: EvaluatorCache): NodeId[] {
  const out: NodeId[] = [];
  for (const clip of shotClipsOf(state, compId)) {
    if (!clip.workflowId) continue;
    const s = madeStateOf(state, clip.workflowId, cache);
    if (s === 'stale' || s === 'unmade') out.push(clip.workflowId);
  }
  return out;
}

function freshId(prefix: string, used: Set<NodeId>): NodeId {
  let n = 1;
  while (used.has(`${prefix}_${n}`)) n++;
  const id = `${prefix}_${n}`;
  used.add(id);
  return id;
}

/** The scene's output node, the camera it films with (the switch, when there is one) and the
 *  project clock: what a render pass is wired to. Null when any is missing. */
function filmingRefs(state: DagState): { scene: NodeId; camera: NodeId; time: NodeId } | null {
  const scene = state.outputs.scene?.node;
  if (!scene || !state.nodes[scene]) return null;
  const camera = refOf(state.nodes[scene].inputs.camera)?.node;
  const time = Object.values(state.nodes).find((n) => n.type === 'TimeSource')?.id;
  if (!camera || !time) return null;
  return { scene, camera, time };
}

/** An existing pass of `type` wired to exactly this scene, camera and clock, or null. */
function findPass(
  state: DagState,
  type: string,
  refs: { scene: NodeId; camera: NodeId; time: NodeId },
): NodeId | null {
  for (const id of Object.keys(state.nodes).sort()) {
    const n = state.nodes[id];
    if (n.type !== type) continue;
    if (
      refOf(n.inputs.scene)?.node === refs.scene &&
      refOf(n.inputs.camera)?.node === refs.camera &&
      refOf(n.inputs.time)?.node === refs.time
    )
      return id;
  }
  return null;
}

export interface MakeShotClipsPlan {
  readonly ops: Op[];
  /** The shots that got a new workflow or a new clip, by 0-based index. */
  readonly made: readonly number[];
  /** Why nothing could be made, when nothing could. */
  readonly reason?: string;
}

/**
 * The Ops that give every shot a clip in `compId`: a workflow (`file`, Basher's stylized workflow
 * by default) over the shot's frames fed by the render passes it reads, and a layer that reads it,
 * starting where the shot starts. Shots that already have both are left alone. Also lengthens the
 * composition to the film when it is shorter.
 */
export function makeShotClipsPlan(
  state: DagState,
  compId: NodeId,
  file: { apiJson: ComfyApiJson; meta: ComfyGraphMeta } = {
    apiJson: STYLIZED_REALISM_WORKFLOW,
    meta: STYLIZED_REALISM_META,
  },
): MakeShotClipsPlan {
  const comp = state.nodes[compId];
  if (comp?.type !== 'Composition') return { ops: [], made: [], reason: 'No composition.' };
  const refs = filmingRefs(state);
  if (!refs) {
    return { ops: [], made: [], reason: 'The scene has no camera to film the shots with.' };
  }
  const cp = comp.params as {
    fps?: number;
    durationFrames?: number;
    width?: number;
    height?: number;
  };
  const compFps = cp.fps ?? 30;
  const toComp = (filmFrame: number) => Math.round((filmFrame * compFps) / FILM_FPS);
  const sockets = workflowSocketsOf({ graph: file });
  const output = sockets.outputs.find((o) => o.type === 'frames');
  if (!output) return { ops: [], made: [], reason: 'That workflow makes no frames.' };

  const ops: Op[] = [];
  let s = state;
  const push = (op: Op) => {
    ops.push(op);
    s = applyOp(s, op).next;
  };
  const used = new Set<NodeId>(Object.keys(state.nodes));

  // The passes the file reads by name, made once and shared by every shot.
  const passes = new Map<string, NodeId>();
  const passOf = (kind: string): NodeId => {
    const known = passes.get(kind) ?? findPass(s, PASS_TYPE[kind], refs);
    if (known) {
      passes.set(kind, known);
      return known;
    }
    const id = freshId(`shot_pass_${kind}`, used);
    push({ type: 'addNode', nodeId: id, nodeType: PASS_TYPE[kind], params: {} });
    for (const [socket, from] of [
      ['scene', refs.scene],
      ['camera', refs.camera],
      ['time', refs.time],
    ] as const) {
      push({ type: 'connect', from: { node: from, socket: 'out' }, to: { node: id, socket } });
    }
    passes.set(kind, id);
    return id;
  };

  const made: number[] = [];
  let filmEnd = 0;
  for (const clip of shotClipsOf(state, compId)) {
    const { start, endExclusive } = shotFrameRange(clip.shot);
    filmEnd = Math.max(filmEnd, endExclusive);
    let workflowId = clip.workflowId;
    if (!workflowId) {
      workflowId = freshId(`shot_${clip.shot.index + 1}_comfy`, used);
      push({
        type: 'addNode',
        nodeId: workflowId,
        nodeType: 'ComfyUIWorkflow',
        params: {
          graph: { apiJson: structuredClone(file.apiJson), meta: { ...file.meta } },
          frameStart: start,
          frameEnd: endExclusive - 1,
          outputPath: `${SHOT_RENDER_DIR}/shot_${String(start).padStart(4, '0')}_${output.socket}`,
          width: cp.width ?? 1280,
          height: cp.height ?? 720,
        },
      });
      push({
        type: 'setMeta',
        nodeId: workflowId,
        name: `Shot ${clip.shot.index + 1} · ${file.meta.name}`,
      });
      for (const input of sockets.inputs) {
        if ((input.type !== 'frames' && input.type !== 'still') || !PASS_TYPE[input.socket])
          continue;
        push({
          type: 'connect',
          from: { node: passOf(input.socket), socket: 'out' },
          to: { node: workflowId, socket: input.socket },
        });
      }
      push({
        type: 'connect',
        from: { node: refs.time, socket: 'out' },
        to: { node: workflowId, socket: 'time' },
      });
    }
    if (!clip.layerId) {
      const layerId = freshLayerId(used);
      used.add(layerId);
      const length = toComp(endExclusive) - toComp(start);
      for (const op of buildAddLayerOps(
        s,
        layerId,
        compId,
        workflowId,
        `Shot ${clip.shot.index + 1}`,
        { startFrame: toComp(start), inPoint: 0, outPoint: Math.max(1, length) },
        workflowSocketsOf(workflowParams(s, workflowId)).outputs.find((o) => o.type === 'frames')
          ?.socket ?? output.socket,
      ))
        push(op);
    }
    if (!clip.workflowId || !clip.layerId) made.push(clip.shot.index);
  }

  const filmFrames = toComp(filmEnd);
  if (made.length > 0 && filmFrames > (cp.durationFrames ?? 150)) {
    push({ type: 'setParam', nodeId: compId, paramPath: 'durationFrames', value: filmFrames });
  }
  return { ops, made };
}
