// generatedStillActions — the Generated tab's buttons (#1718): Generate, Keep, Use as first frame,
// Regenerate. Each reads the store fresh, does its I/O, and dispatches through the one op road.
//
// Generate renders the shot's first frame through the same offscreen road "Render Image" uses
// (`renderActiveProjectBlob`, at the shot's start, the playhead put back after), stores it under
// a name taken from its bytes, feeds it to the still workflow, and runs the variants. Every
// dependency is injectable so the road runs under a unit test with the stub and no viewport.
//
// V8: app layer — dispatches; src/render/ never does.
//
// REF: src/app/generated/generatedStill.ts (the graph edits and runs); src/app/render/
//      regenerateWorkflow.ts; src/app/renderImageAction.ts.

import { useDagStore } from '../../core/dag/store';
import type { NodeId, NodeRef, Op } from '../../core/dag/types';
import { compileWorkflowFrame } from '../../render/compileWorkflowFrame';
import { getComfyCapability, getStorage } from '../boot';
import { controllerValueReader } from '../render/controllerValue';
import { regenerateWorkflow, type RegenerateResult } from '../render/regenerateWorkflow';
import type { RunWorkflowDeps } from '../render/runWorkflow';
import { renderActiveProjectBlob } from '../renderImageAction';
import { useGeneratedStillStore } from '../stores/generatedStillStore';
import { useTimeStore } from '../stores/timeStore';
import type { Shot } from '../shots';
import {
  feedRenderOps,
  firstFrameOps,
  keepVariantPlan,
  promptOps,
  renderPathFor,
  runStillVariants,
  type StillVariant,
} from './generatedStill';

/** A rendered first frame: PNG bytes and their size. */
export interface RenderedFrame {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export type RenderFirstFrame = (shot: Pick<Shot, 'start'>) => Promise<RenderedFrame | null>;

function commit(ops: readonly Op[], label: string): void {
  if (ops.length > 0) useDagStore.getState().dispatchAtomic([...ops], 'user', label);
}

const nextPaint = () =>
  new Promise<void>((resolve) =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => resolve())
      : setTimeout(resolve, 0),
  );

/** Render the beauty pass at the shot's first frame, putting the playhead back after. */
export const renderShotFirstFrame: RenderFirstFrame = async (shot) => {
  const time = useTimeStore.getState();
  const was = time.filmSeconds;
  time.setTime(shot.start);
  // The live scene follows the playhead on the render loop's next paint.
  await nextPaint();
  await nextPaint();
  try {
    const out = await renderActiveProjectBlob('beauty');
    if (!out) return null;
    return {
      bytes: new Uint8Array(await out.blob.arrayBuffer()),
      width: out.width,
      height: out.height,
    };
  } finally {
    useTimeStore.getState().setTime(was);
  }
};

/** The capability, storage and compiler the app runs workflows with. */
export async function appRunDeps(): Promise<RunWorkflowDeps> {
  const [capability, storage] = await Promise.all([getComfyCapability(), getStorage()]);
  return { capability, storage, compileWorkflow: compileWorkflowFrame({ storage }) };
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  useGeneratedStillStore.getState().setStatus('error', message);
}

/** Set the still workflow's prompt. */
export function setStillPrompt(stillId: NodeId, text: string): void {
  commit(promptOps(useDagStore.getState().state, stillId, text), 'still prompt');
}

/**
 * Generate: render the shot's first frame, feed it to the still workflow, and run the variants.
 * Never rejects; a failure lands on the store's message.
 */
export async function generateStillVariants(
  stillId: NodeId,
  shot: Pick<Shot, 'start'>,
  opts: { render?: RenderFirstFrame; deps?: RunWorkflowDeps } = {},
): Promise<readonly StillVariant[]> {
  const store = useGeneratedStillStore.getState();
  try {
    store.setStatus('rendering');
    const deps = opts.deps ?? (await appRunDeps());
    const frame = await (opts.render ?? renderShotFirstFrame)(shot);
    if (!frame) throw new Error("The shot's first frame could not be rendered (no viewport).");
    const path = renderPathFor(stillId, frame.bytes);
    await deps.storage.write(path, frame.bytes);
    commit(
      feedRenderOps(useDagStore.getState().state, stillId, path, frame),
      "feed the shot's first frame to the still",
    );
    store.setStatus('generating');
    const state = useDagStore.getState().state;
    const variants = await runStillVariants(state, stillId, {
      ...deps,
      controllerValue: controllerValueReader(state, stillId),
    });
    useGeneratedStillStore.getState().setVariants(stillId, variants);
    useGeneratedStillStore.getState().setStatus('idle');
    return variants;
  } catch (err) {
    fail(err);
    return [];
  }
}

/** Keep variant `seed`: its picture becomes the node's still and its seed goes into the file. */
export async function keepStillVariant(
  stillId: NodeId,
  variant: StillVariant,
  deps?: Pick<RunWorkflowDeps, 'storage'>,
): Promise<boolean> {
  try {
    const storage = deps?.storage ?? (await getStorage());
    const plan = keepVariantPlan(useDagStore.getState().state, stillId, variant);
    if (!plan.ok) throw new Error(plan.reason);
    await storage.write(plan.stillPath, await storage.read(variant.path));
    commit(plan.ops, `keep still variant (seed ${variant.seed})`);
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

/** Use the still as `target`'s first frame: one wire. */
export function wireStillAsFirstFrame(stillId: NodeId, target: NodeRef): void {
  commit(firstFrameOps(useDagStore.getState().state, stillId, target), 'use still as first frame');
}

/** Regenerate a shot's video workflow: the stale still first, then the shot. */
export async function regenerateShot(
  workflowId: NodeId,
  deps?: RunWorkflowDeps,
): Promise<RegenerateResult | null> {
  const store = useGeneratedStillStore.getState();
  try {
    store.setStatus('running');
    const result = await regenerateWorkflow(workflowId, deps ?? (await appRunDeps()));
    if (result.status === 'completed') {
      useGeneratedStillStore.getState().setStatus('idle', `Ran ${result.ran.join(' → ')}.`);
    } else {
      useGeneratedStillStore
        .getState()
        .setStatus(
          'error',
          result.status === 'busy'
            ? `"${result.at}" is already running.`
            : `"${result.at}" failed: ${result.error?.message ?? 'unknown error'}`,
        );
    }
    return result;
  } catch (err) {
    fail(err);
    return null;
  }
}
