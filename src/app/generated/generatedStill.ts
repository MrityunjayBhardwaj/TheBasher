// generatedStill — the 2D View's Generated tab, as graph edits and runs (#1718).
//
// A reference still is made by a ComfyUI workflow node whose file has a still output (a
// `basher_export kind=image`), from Basher's render of a shot's first frame plus a prompt. The
// director sees four variants, keeps one, and wires it into a shot's video workflow as its first
// frame. Every step is an ordinary graph edit, so the still stays an ordinary image:
//
//   - the render reaches the still workflow as an image clip (`MediaClip`, mediaKind image) wired
//     into its still input, stored under a name taken from its bytes, so a new render is a new
//     clip source and the still reads stale (the wire carries the clip's hash);
//   - the prompt is the still workflow's text input default, written into its file the way an
//     un-keyed edit in the Controls panel writes it;
//   - a VARIANT is the same workflow run with another seed (its number input named `seed`),
//     written to a path of its own. Nothing about it is saved: keeping one writes its seed into
//     the file, puts its picture where the node's still lands, and records the still as made
//     from that, so the kept still is exactly what the workflow makes now;
//   - "Use as first frame of Shot N" is one wire from the still output into a still input of the
//     shot's video workflow. Regenerating the shot runs the still first when it is stale
//     (`regenerateWorkflow`), because that is the graph's order, not a rule of this tab.
//
// WHICH WORKFLOW IS A SHOT'S. Nothing stores a shot (`shots.ts`: they are read off the camera
// cuts), and nothing ties a workflow to one. A video workflow renders a frame range, and a shot
// IS a frame range, so a shot's video workflows are the workflow nodes with a frames output whose
// first frame falls inside the shot. Derived, like the shots, so nothing new is saved and nothing
// can drift. Its first-frame input is its still input named like a first frame, or its only one.
//
// V8: the pure parts build Ops and derived states; the `…Action`-style functions at the bottom
// read the store and dispatch.
//
// REF: src/nodes/comfyWorkflowMade.ts (stale, regenerate order); src/core/comfy/workflowSockets.ts
//      (the sockets a file declares); src/app/shots.ts; issue #1718, design board 12b.

import { writeBasherControllerValues } from '../../core/comfy/basherControllers';
import type { ComfyApiJson, ComfyGraphMeta } from '../../core/comfy/comfyGraph';
import { framePath, outputPathOf } from '../../core/comfy/workflowPaths';
import type { WorkflowInput, WorkflowSockets } from '../../core/comfy/workflowSockets';
import type { ComfyUICapability } from '../../core/comfy';
import { applyOp } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { NodeId, NodeRef, Op } from '../../core/dag/types';
import type { StorageCapability } from '../../core/storage';
import { workflowSocketsOf, type ComfyUIWorkflowParams } from '../../nodes/ComfyUIWorkflow';
import { workflowMadeFrom } from '../render/workflowMadeFrom';
import type { CompileWorkflowFn, ControllerValueAt } from '../../render/dryRun';
import { runComfyUIWorkflow } from '../../render/runComfyUIWorkflow';
import type { Shot } from '../shots';

/** How many variants one Generate asks for (design board 12b: "shows 4 variants"). */
export const STILL_VARIANT_COUNT = 4;

/** The project's frame rate: the ComfyUI runner renders at 30 (`runComfyUIWorkflow`). */
const FPS = 30;

/** A workflow node the Generated tab can make a still with. */
export interface StillWorkflow {
  readonly id: NodeId;
  /** The still output the variants are read from: the file's first output, a still. */
  readonly stillOutput: string;
  /** The still input Basher's render goes into, or null when the file has none. */
  readonly renderInput: string | null;
  /** The text input the prompt box edits, or null. */
  readonly promptInput: WorkflowInput | null;
  /** The number input a variant varies, or null (then there is one picture, not four). */
  readonly seedInput: WorkflowInput | null;
}

function paramsOf(state: DagState, id: NodeId): Partial<ComfyUIWorkflowParams> | null {
  const node = state.nodes[id];
  return node?.type === 'ComfyUIWorkflow' ? (node.params as Partial<ComfyUIWorkflowParams>) : null;
}

const RENDER_NAME = /^(render|beauty|image|reference|ref|input)$/i;
const FIRST_FRAME_NAME = /^(first[ _-]?frame|start[ _-]?(frame|image)|init[ _-]?image)$/i;

function stillInputs(sockets: WorkflowSockets): WorkflowInput[] {
  return sockets.inputs.filter((i) => i.type === 'still');
}

/** The still workflow `id` reads as, or null when its file's first output is not a still. */
export function stillWorkflowOf(state: DagState, id: NodeId): StillWorkflow | null {
  const params = paramsOf(state, id);
  if (!params?.graph) return null;
  const sockets = workflowSocketsOf(params);
  const first = sockets.outputs[0];
  if (!first || first.type !== 'still') return null;
  const stills = stillInputs(sockets);
  const texts = sockets.inputs.filter((i) => i.type === 'text');
  return {
    id,
    stillOutput: first.socket,
    renderInput: (stills.find((i) => RENDER_NAME.test(i.socket)) ?? stills[0])?.socket ?? null,
    promptInput: texts.find((i) => i.socket === 'prompt') ?? texts[0] ?? null,
    seedInput: sockets.inputs.find((i) => i.type === 'number' && i.socket === 'seed') ?? null,
  };
}

/** Every workflow node in the graph that makes a still, in id order. */
export function stillWorkflowsOf(state: DagState): StillWorkflow[] {
  return Object.keys(state.nodes)
    .sort()
    .map((id) => stillWorkflowOf(state, id))
    .filter((w): w is StillWorkflow => w !== null);
}

/** The frames a shot covers at the runner's 30 fps: [start, endExclusive). */
export function shotFrameRange(shot: Pick<Shot, 'start' | 'end'>): {
  start: number;
  endExclusive: number;
} {
  const start = Math.round(shot.start * FPS);
  return { start, endExclusive: Math.max(start + 1, Math.round(shot.end * FPS)) };
}

/** The input a still goes into as a first frame: the still input named like one, else the only
 *  still input, else null (the director picks). */
export function firstFrameInputOf(sockets: WorkflowSockets): string | null {
  const stills = stillInputs(sockets);
  return (
    stills.find((i) => FIRST_FRAME_NAME.test(i.socket))?.socket ??
    (stills.length === 1 ? stills[0].socket : null)
  );
}

/** A shot's video workflow, as the "Use as first frame" action offers it. */
export interface ShotWorkflow {
  readonly id: NodeId;
  /** The input the still goes into, or null when the file has several and none is named so. */
  readonly firstFrameInput: string | null;
  /** Every still input it has (what the director picks from when `firstFrameInput` is null). */
  readonly stillInputs: readonly string[];
}

/** The video workflows of `shot`: workflow nodes with a frames output and a still input whose
 *  first frame falls inside the shot, in id order. */
export function shotVideoWorkflows(state: DagState, shot: Pick<Shot, 'start' | 'end'>) {
  const { start, endExclusive } = shotFrameRange(shot);
  const out: ShotWorkflow[] = [];
  for (const id of Object.keys(state.nodes).sort()) {
    const params = paramsOf(state, id);
    if (!params?.graph) continue;
    const sockets = workflowSocketsOf(params);
    if (!sockets.outputs.some((o) => o.type === 'frames')) continue;
    const stills = stillInputs(sockets);
    if (stills.length === 0) continue;
    const first = params.frameStart ?? 0;
    if (first < start || first >= endExclusive) continue;
    out.push({
      id,
      firstFrameInput: firstFrameInputOf(sockets),
      stillInputs: stills.map((i) => i.socket),
    });
  }
  return out;
}

/** The Ops that wire still `stillId`'s output into `target` as its first frame: one wire,
 *  replacing whatever that input held. Empty when it is wired so already. */
export function firstFrameOps(state: DagState, stillId: NodeId, target: NodeRef): Op[] {
  const still = stillWorkflowOf(state, stillId);
  if (!still) return [];
  const node = state.nodes[target.node];
  if (!node) return [];
  const held = node.inputs[target.socket];
  const ref = (Array.isArray(held) ? held[0] : held) as NodeRef | undefined;
  if (ref?.node === stillId && ref.socket === still.stillOutput) return [];
  return [
    {
      type: 'connect',
      from: { node: stillId, socket: still.stillOutput },
      to: target,
      replace: true,
    },
  ];
}

function withFileValue(
  state: DagState,
  stillId: NodeId,
  markerNodeId: string,
  value: string | number,
): { graph: { apiJson: ComfyApiJson; meta: ComfyGraphMeta } } | null {
  const graph = paramsOf(state, stillId)?.graph;
  if (!graph) return null;
  const apiJson = writeBasherControllerValues(graph.apiJson as ComfyApiJson, {
    [markerNodeId]: [value],
  });
  return { graph: { apiJson, meta: graph.meta } };
}

/** The Op that sets the still workflow's prompt (its text input's default in the file). */
export function promptOps(state: DagState, stillId: NodeId, text: string): Op[] {
  const prompt = stillWorkflowOf(state, stillId)?.promptInput;
  if (!prompt || prompt.defaultValue === text) return [];
  const next = withFileValue(state, stillId, prompt.nodeId, text);
  return next ? [{ type: 'setParam', nodeId: stillId, paramPath: 'graph', value: next.graph }] : [];
}

/** Where a still workflow with no output path of its own writes. */
export function defaultStillOutputPath(stillId: NodeId): string {
  return `renders/generated/${stillId.replace(/[^a-zA-Z0-9_-]/g, '_')}/still`;
}

/** A storage path named by the bytes it holds, so a different render is a different path. */
export function renderPathFor(stillId: NodeId, bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  const digest = (h >>> 0).toString(16).padStart(8, '0');
  return `renders/generated/${stillId.replace(/[^a-zA-Z0-9_-]/g, '_')}/first_frame_${digest}.png`;
}

/**
 * The Ops that feed the render at `path` into still `stillId`'s render input: an image clip wired
 * there (made when the input holds none, its `src` moved when it holds one), plus an output path
 * when the node has none. Empty when it is fed so already.
 */
export function feedRenderOps(
  state: DagState,
  stillId: NodeId,
  path: string,
  size: { width: number; height: number },
): Op[] {
  const still = stillWorkflowOf(state, stillId);
  if (!still?.renderInput) return [];
  const ops: Op[] = [];
  if (!paramsOf(state, stillId)?.outputPath) {
    ops.push({
      type: 'setParam',
      nodeId: stillId,
      paramPath: 'outputPath',
      value: defaultStillOutputPath(stillId),
    });
  }
  const held = state.nodes[stillId]!.inputs[still.renderInput];
  const ref = (Array.isArray(held) ? held[0] : held) as NodeRef | undefined;
  const clip = ref ? state.nodes[ref.node] : undefined;
  if (
    clip?.type === 'MediaClip' &&
    (clip.params as { mediaKind?: unknown }).mediaKind === 'image'
  ) {
    if ((clip.params as { src?: unknown }).src !== path) {
      ops.push({ type: 'setParam', nodeId: clip.id, paramPath: 'src', value: path });
    }
    return ops;
  }
  let n = 1;
  while (state.nodes[`${stillId}_render_${n}`]) n++;
  const clipId = `${stillId}_render_${n}`;
  ops.push(
    {
      type: 'addNode',
      nodeId: clipId,
      nodeType: 'MediaClip',
      params: {
        name: 'Shot first frame',
        src: path,
        mediaKind: 'image',
        srcFps: FPS,
        srcFrames: 1,
        width: size.width,
        height: size.height,
      },
    },
    {
      type: 'connect',
      from: { node: clipId, socket: 'out' },
      to: { node: stillId, socket: still.renderInput },
      replace: true,
    },
  );
  return ops;
}

/** The seeds of one Generate: the file's seed and the three after it. */
export function stillVariantSeeds(base: number, count = STILL_VARIANT_COUNT): number[] {
  return Array.from({ length: count }, (_, i) => base + i);
}

/** Where the variant with `seed` is written: beside the node's own output. */
export function variantOutputPath(outputPath: string, seed: number): string {
  return `${outputPath.replace(/\/+$/, '')}__variant_seed${seed}`;
}

/** One variant of a still: its seed, where its picture is, and the hash it was made from (the
 *  still's hash with that seed written in), so a variant made before an edit is never kept as
 *  if it were current. */
export interface StillVariant {
  readonly seed: number;
  readonly path: string;
  readonly madeFrom: string | null;
}

export interface StillRunDeps {
  readonly capability: ComfyUICapability;
  readonly storage: StorageCapability;
  readonly compileWorkflow: CompileWorkflowFn;
  readonly controllerValue?: ControllerValueAt;
}

/**
 * Run still `stillId` once per seed, each to a path of its own, and return the variants. The
 * graph is not changed: each run is of the node as it would be with that seed written into its
 * file. A file with no `seed` input makes one variant (four runs would be four of one picture).
 */
export async function runStillVariants(
  state: DagState,
  stillId: NodeId,
  deps: StillRunDeps,
  count = STILL_VARIANT_COUNT,
): Promise<StillVariant[]> {
  const still = stillWorkflowOf(state, stillId);
  if (!still) throw new Error(`"${stillId}" is not a workflow that makes a still.`);
  const outputPath = paramsOf(state, stillId)?.outputPath ?? '';
  if (!outputPath) throw new Error(`"${stillId}" has no output path yet.`);
  const seedInput = still.seedInput;
  const base = typeof seedInput?.defaultValue === 'number' ? seedInput.defaultValue : 0;
  const seeds = seedInput ? stillVariantSeeds(base, count) : [base];
  const variants: StillVariant[] = [];
  for (const seed of seeds) {
    let s = state;
    if (seedInput) {
      const next = withFileValue(s, stillId, seedInput.nodeId, seed)!;
      s = applyOp(s, {
        type: 'setParam',
        nodeId: stillId,
        paramPath: 'graph',
        value: next.graph,
      }).next;
    }
    const path = variantOutputPath(outputPath, seed);
    s = applyOp(s, {
      type: 'setParam',
      nodeId: stillId,
      paramPath: 'outputPath',
      value: path,
    }).next;
    s = applyOp(s, {
      type: 'setParam',
      nodeId: stillId,
      paramPath: 'lastGoodFrame',
      value: -1,
    }).next;
    const base = deps.controllerValue;
    const report = await runComfyUIWorkflow(stillId, s, {
      capability: deps.capability,
      storage: deps.storage,
      compileWorkflow: deps.compileWorkflow,
      // The variant's seed wins over a keyed one: it is the variant.
      controllerValue: (marker, frame) =>
        seedInput && marker === seedInput.nodeId ? seed : base?.(marker, frame),
      onFrameComplete: () => {},
    });
    variants.push({ seed, path: report.outputs[0], madeFrom: workflowMadeFrom(s, stillId) });
  }
  return variants;
}

/** What keeping a variant does, or why it cannot. */
export type KeepPlan =
  | { readonly ok: true; readonly ops: Op[]; readonly stillPath: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Keeping `variant`: the Ops that write its seed into the file, record the still as made from
 * that (so it reads current), and mark its frame landed, plus where its picture must be copied to.
 * Refused when the variant was made from something else (the prompt or the render moved since
 * the Generate): recording it as current would be a lie the shot then inherits.
 */
export function keepVariantPlan(state: DagState, stillId: NodeId, variant: StillVariant): KeepPlan {
  const still = stillWorkflowOf(state, stillId);
  const params = paramsOf(state, stillId);
  if (!still || !params?.outputPath) {
    return { ok: false, reason: `"${stillId}" is not a still workflow with an output path.` };
  }
  const ops: Op[] = [];
  let s = state;
  if (still.seedInput) {
    const next = withFileValue(state, stillId, still.seedInput.nodeId, variant.seed)!;
    const op: Op = { type: 'setParam', nodeId: stillId, paramPath: 'graph', value: next.graph };
    ops.push(op);
    s = applyOp(s, op).next;
  }
  const madeFrom = workflowMadeFrom(s, stillId);
  if (variant.madeFrom === null || variant.madeFrom !== madeFrom) {
    return {
      ok: false,
      reason: 'These variants were made before the prompt or the render changed. Generate again.',
    };
  }
  const frameStart = params.frameStart ?? 0;
  ops.push(
    { type: 'setParam', nodeId: stillId, paramPath: 'madeFrom', value: madeFrom },
    { type: 'setParam', nodeId: stillId, paramPath: 'lastGoodFrame', value: frameStart },
  );
  const sockets = workflowSocketsOf(params);
  return {
    ok: true,
    ops,
    stillPath: framePath(outputPathOf(params.outputPath, sockets, still.stillOutput), frameStart),
  };
}
