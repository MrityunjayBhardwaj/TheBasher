// shotClipActions — the Video space's shot-clip actions (#1717): make the clips, and generate the
// shots that need it.
//
// GENERATE RUNS EACH SHOT ONCE, WHAT IT DEPENDS ON FIRST. "Generate stale shots (N)" takes the
// shots whose workflows are stale or never made (`shotsToGenerate`) and regenerates each through
// the one road (`regenerateWorkflow`): a stale still a shot starts from runs before the shot, and a
// workflow already made current earlier in the same pass (a still two shots share) is not run
// again, because each regenerate reads the graph afresh. Nothing else runs: a current shot sends
// ComfyUI nothing.
//
// BEFORE A SHOT RUNS, ITS PASSES ARE RENDERED. A shot's workflow reads its render passes from disk,
// one file per frame (`passFramePath`), and those files are only right for the scene as it is now.
// So each workflow the road runs first has its wired passes rendered over the frames it makes,
// through the still render's own road (`renderActiveProjectBlob`, the camera on screen at each
// frame), with the playhead put back after. A regenerated shot is made from the scene it shows.
//
// Progress (which shot, rendering or generating, how far) lives in `useShotClipRunStore`.
//
// V8: src/app — dispatches through the store; src/render never does.
//
// REF: src/app/video/shotClips.ts; src/app/render/regenerateWorkflow.ts; src/render/
//      compileWorkflowFrame.ts (`passFramePath`); src/app/renderAnimationAction.ts (the playhead
//      is applied with one synchronous frame-loop pass before each still).

import { advance } from '@react-three/fiber';
import { create } from 'zustand';
import { createEvaluatorCache } from '../../core/dag/evaluator';
import { useDagStore } from '../../core/dag/store';
import type { NodeId, NodeRef } from '../../core/dag/types';
import { workflowSocketsOf, type ComfyUIWorkflowParams } from '../../nodes/ComfyUIWorkflow';
import { passFramePath } from '../../render/compileWorkflowFrame';
import { runFrameEnd } from '../../render/dryRun';
import type { RenderPassKind } from '../../render/renderToImage';
import { getStorage } from '../boot';
import { appRunDeps } from '../generated/generatedStillActions';
import { regenerateWorkflow, type RegenerateDeps } from '../render/regenerateWorkflow';
import { madeStateOf } from '../render/workflowMadeFrom';
import { renderActiveProjectBlob } from '../renderImageAction';
import { useNotificationStore } from '../stores/notificationStore';
import { useTimeStore } from '../stores/timeStore';
import { makeShotClipsPlan, shotsToGenerate } from './shotClips';

/** What the shot-clip road is doing now. */
export interface ShotClipRun {
  /** The workflow being worked on, or null when idle. */
  readonly current: NodeId | null;
  readonly phase: 'rendering' | 'generating' | null;
  /** Frames done and total in the current phase. */
  readonly done: number;
  readonly total: number;
  /** The workflows still waiting in this Generate, in order. */
  readonly queued: readonly NodeId[];
}

interface ShotClipRunStore extends ShotClipRun {
  set(next: Partial<ShotClipRun>): void;
}

const IDLE: ShotClipRun = { current: null, phase: null, done: 0, total: 0, queued: [] };

export const useShotClipRunStore = create<ShotClipRunStore>((set) => ({
  ...IDLE,
  set: (next) => set(next),
}));

const PASS_KINDS: ReadonlySet<string> = new Set(['beauty', 'depth', 'normal']);

function refOf(binding: unknown): NodeRef | undefined {
  return (Array.isArray(binding) ? binding[0] : binding) as NodeRef | undefined;
}

/** The render passes wired into workflow `id`, by the pass each draws. */
export function wiredPasses(id: NodeId): RenderPassKind[] {
  const state = useDagStore.getState().state;
  const node = state.nodes[id];
  if (!node) return [];
  const kinds = new Set<RenderPassKind>();
  for (const input of workflowSocketsOf(node.params).inputs) {
    const ref = refOf(node.inputs[input.socket]);
    const type = ref ? state.nodes[ref.node]?.type : undefined;
    const kind =
      type === 'BeautyPass'
        ? 'beauty'
        : type === 'DepthPass'
          ? 'depth'
          : type === 'NormalPass'
            ? 'normal'
            : null;
    if (kind && PASS_KINDS.has(kind)) kinds.add(kind);
  }
  return [...kinds];
}

/**
 * Render the passes wired into workflow `id` over every frame it makes, to where its run reads
 * them. The playhead is put back after. Throws when the viewport cannot render.
 */
export async function renderWorkflowPasses(id: NodeId): Promise<void> {
  const kinds = wiredPasses(id);
  if (kinds.length === 0) return;
  const node = useDagStore.getState().state.nodes[id];
  const params = (node?.params ?? {}) as Partial<ComfyUIWorkflowParams>;
  const outputPath = params.outputPath ?? '';
  if (!outputPath) throw new Error(`"${id}" has no output path to render its passes beside.`);
  const first = params.frameStart ?? 0;
  const last = runFrameEnd(params, workflowSocketsOf(params));
  const storage = await getStorage();
  const time = useTimeStore.getState();
  const was = time.filmSeconds;
  const wasPlaying = time.playing;
  if (wasPlaying) time.pause();
  const run = useShotClipRunStore.getState();
  run.set({ current: id, phase: 'rendering', done: 0, total: last - first + 1 });
  try {
    for (let frame = first; frame <= last; frame++) {
      useTimeStore.getState().setTime(frame / 30);
      // Apply the playhead to the live scene now (the Render Animation road's one frame-loop pass).
      advance(performance.now());
      for (const kind of kinds) {
        const out = await renderActiveProjectBlob(kind);
        if (!out) throw new Error('The 3D view is not ready, so the shot could not be rendered.');
        await storage.write(
          passFramePath(outputPath, kind, frame),
          new Uint8Array(await out.blob.arrayBuffer()),
        );
      }
      useShotClipRunStore.getState().set({ done: frame - first + 1 });
    }
  } finally {
    useTimeStore.getState().setTime(was);
    advance(performance.now());
  }
}

/** The deps the Video space generates with: the app's runner, and its passes rendered first. */
async function shotRunDeps(): Promise<RegenerateDeps> {
  const deps = await appRunDeps();
  return {
    ...deps,
    prepare: async (id) => {
      await renderWorkflowPasses(id);
      const node = useDagStore.getState().state.nodes[id];
      const p = (node?.params ?? {}) as Partial<ComfyUIWorkflowParams>;
      const first = p.frameStart ?? 0;
      useShotClipRunStore.getState().set({
        current: id,
        phase: 'generating',
        done: 0,
        total: runFrameEnd(p, workflowSocketsOf(p)) - first + 1,
      });
    },
  };
}

/** Make a clip for every shot that has none in `compId` (one undo). Returns the shots made. */
export function makeShotClips(compId: NodeId): readonly number[] {
  const dag = useDagStore.getState();
  const plan = makeShotClipsPlan(dag.state, compId);
  if (plan.reason) {
    useNotificationStore.getState().notify({ severity: 'warn', message: plan.reason });
    return [];
  }
  if (plan.ops.length > 0) dag.dispatchAtomic(plan.ops, 'user', 'make shot clips');
  return plan.made;
}

export interface GenerateShotsResult {
  /** Every workflow that ran, in order (upstream stills included). */
  readonly ran: readonly NodeId[];
  /** Where it stopped, when a run failed. */
  readonly failed?: { readonly at: NodeId; readonly message: string };
}

/**
 * Generate `ids` (shot workflows), each through the regenerate road, in order. A workflow that is
 * already current when its turn comes (made earlier in this pass) is skipped. Stops at the first
 * failure. `deps` defaults to the app's runner with each shot's passes rendered first.
 */
export async function generateShotWorkflows(
  ids: readonly NodeId[],
  deps?: RegenerateDeps,
  /** Run each of `ids` even when it is current (Regenerate on one clip). */
  opts: { always?: boolean } = {},
): Promise<GenerateShotsResult> {
  const run = useShotClipRunStore.getState();
  if (run.current !== null) return { ran: [], failed: { at: run.current, message: 'busy' } };
  const ran: NodeId[] = [];
  try {
    const d = deps ?? (await shotRunDeps());
    const queue = [...ids];
    while (queue.length > 0) {
      const id = queue.shift()!;
      useShotClipRunStore.getState().set({ current: id, queued: [...queue], phase: null });
      if (
        !opts.always &&
        madeStateOf(useDagStore.getState().state, id, createEvaluatorCache()) === 'current'
      )
        continue;
      const result = await regenerateWorkflow(id, d);
      ran.push(...result.ran);
      if (result.status !== 'completed') {
        const message =
          result.status === 'busy'
            ? `"${result.at}" is already running.`
            : (result.error?.message ?? 'unknown error');
        useNotificationStore
          .getState()
          .notify({ severity: 'error', message: `Generating the shot failed: ${message}` });
        return { ran, failed: { at: result.at, message } };
      }
    }
    return { ran };
  } finally {
    useShotClipRunStore.getState().set(IDLE);
  }
}

/** "Generate stale shots (N)": every shot of `compId` that is stale or never made. */
export function generateStaleShots(compId: NodeId, deps?: RegenerateDeps) {
  return generateShotWorkflows(
    shotsToGenerate(useDagStore.getState().state, compId, createEvaluatorCache()),
    deps,
  );
}

/** Regenerate on one shot clip: its passes rendered and its workflow run, current or not, with
 *  anything stale it depends on first. */
export function regenerateShotClip(workflowId: NodeId, deps?: RegenerateDeps) {
  return generateShotWorkflows([workflowId], deps, { always: true });
}
