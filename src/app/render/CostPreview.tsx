// CostPreview — Wave C5 cost-preview UI for a ComfyUIWorkflow node.
//
// Read-only from the DAG's perspective. Calls the dryRun probe (D-06)
// through the configured ComfyUICapability + StorageCapability, renders
// the probe frame inline, then gates "Submit Render" on the user
// confirming the estimate. Submit calls runWorkflow at the V8 seam
// (src/app/render/runWorkflow.ts — the only place a render-side dispatch
// is allowed).
//
// Pure component: capabilities + the dryRun/runWorkflow callables come in
// as deps so vitest can mock them. Inspector wires a connector that pulls
// from boot helpers (getComfyCapability + getStorage + the preset's
// compile factory).
//
// Progress bar reads node.params.lastGoodFrame. The runWorkflow seam
// dispatches setParam ops per frame (V8 pattern), so a zustand subscriber
// re-renders the bar every frame without a polling timer.
//
// REF: project_p5_close_prompt Wave C5; project_p5_context D-06; vyapti
// V8 (file-rooted dispatch — this component reads, runWorkflow seam
// dispatches); H22 isolation rule unchanged.

import { useCallback, useEffect, useState } from 'react';
import type { ComfyUICapability } from '../../core/comfy';
import { useDagStore } from '../../core/dag/store';
import type { NodeId } from '../../core/dag/types';
import type { StorageCapability } from '../../core/storage';
import { dryRun, type DryRunReport, type CompileWorkflowFn } from '../../render/dryRun';
import type { ComfyUIWorkflowParams } from '../../nodes/ComfyUIWorkflow';
import { useRenderJobsStore } from '../stores/renderJobsStore';
import { runWorkflow as defaultRunWorkflow, type RunWorkflowResult } from './runWorkflow';

export interface CostPreviewDeps {
  readonly capability: ComfyUICapability;
  readonly storage: StorageCapability;
  readonly compileWorkflow: CompileWorkflowFn;
  /** Optional override for tests; defaults to the production runWorkflow. */
  readonly runWorkflow?: typeof defaultRunWorkflow;
}

export interface CostPreviewProps {
  readonly workflowNodeId: NodeId;
  readonly deps: CostPreviewDeps;
}

type EstimateState =
  | { readonly status: 'idle' }
  | { readonly status: 'estimating' }
  | { readonly status: 'ready'; readonly report: DryRunReport; readonly imageUrl: string | null }
  | { readonly status: 'error'; readonly message: string };

type SubmitState =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'done'; readonly result: RunWorkflowResult }
  | { readonly status: 'error'; readonly message: string };

function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

/** Read OPFS bytes at `path` and return a blob: URL. Returns null if the
 *  read fails (probe wrote 0 bytes, file missing, etc). Caller revokes. */
async function readAsBlobUrl(storage: StorageCapability, path: string): Promise<string | null> {
  try {
    const bytes = await storage.read(path);
    // BlobPart accepts ArrayBufferView; Uint8Array is fine.
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

export function CostPreview({ workflowNodeId, deps }: CostPreviewProps) {
  const node = useDagStore((s) => s.state.nodes[workflowNodeId]);
  const inFlight = useRenderJobsStore((s) => s.inFlight.has(workflowNodeId));
  const [estimate, setEstimate] = useState<EstimateState>({ status: 'idle' });
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' });

  // Revoke the blob URL when the estimate state changes or the component
  // unmounts. Without this every Estimate click would leak ~1 PNG of
  // memory (small per-click; significant across long sessions).
  useEffect(() => {
    if (estimate.status !== 'ready' || !estimate.imageUrl) return;
    const url = estimate.imageUrl;
    return () => URL.revokeObjectURL(url);
  }, [estimate]);

  const handleEstimate = useCallback(async () => {
    setEstimate({ status: 'estimating' });
    setSubmit({ status: 'idle' });
    try {
      // H19: read fresh state at click time. The DAG may have advanced
      // between mount and click (agent ops, undo).
      const state = useDagStore.getState().state;
      const report = await dryRun(workflowNodeId, state, {
        capability: deps.capability,
        storage: deps.storage,
        compileWorkflow: deps.compileWorkflow,
      });
      const imageUrl = await readAsBlobUrl(deps.storage, report.samplePath);
      setEstimate({ status: 'ready', report, imageUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setEstimate({ status: 'error', message });
    }
  }, [workflowNodeId, deps]);

  const handleSubmit = useCallback(async () => {
    setSubmit({ status: 'running' });
    try {
      const runner = deps.runWorkflow ?? defaultRunWorkflow;
      const result = await runner(workflowNodeId, {
        capability: deps.capability,
        storage: deps.storage,
        compileWorkflow: deps.compileWorkflow,
      });
      setSubmit({ status: 'done', result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmit({ status: 'error', message });
    }
  }, [workflowNodeId, deps]);

  if (!node || node.type !== 'ComfyUIWorkflow') return null;

  const params = (node.params ?? {}) as Partial<ComfyUIWorkflowParams>;
  const frameStart = params.frameStart ?? 0;
  const frameEnd = params.frameEnd ?? 60;
  const lastGoodFrame = params.lastGoodFrame ?? -1;
  const frameTotal = Math.max(1, frameEnd - frameStart + 1);
  const framesDone = Math.max(0, Math.min(frameTotal, lastGoodFrame - frameStart + 1));
  const progressPct = inFlight || framesDone > 0 ? (framesDone / frameTotal) * 100 : 0;

  const submitDisabled = estimate.status !== 'ready' || submit.status === 'running' || inFlight;

  return (
    <div
      data-testid="cost-preview"
      className="border-t border-border bg-muted/30 px-3 py-2 text-[11px]"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono uppercase tracking-wide text-fg/50">cost preview</span>
        <button
          type="button"
          onClick={handleEstimate}
          disabled={estimate.status === 'estimating' || inFlight}
          data-testid="cost-preview-estimate"
          className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] text-fg/80 hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-fg/80"
        >
          {estimate.status === 'estimating' ? 'estimating…' : 'estimate'}
        </button>
      </div>

      {estimate.status === 'error' ? (
        <div
          className="mb-2 rounded border border-red-500/40 bg-red-500/5 px-2 py-1 text-[10px] text-red-300"
          data-testid="cost-preview-error"
        >
          {estimate.message}
        </div>
      ) : null}

      {estimate.status === 'ready' ? (
        <div className="mb-2 space-y-1">
          <div className="flex items-baseline justify-between text-[10px]">
            <span className="text-fg/60">frames</span>
            <span className="font-mono text-fg/90" data-testid="cost-preview-frames">
              {estimate.report.frames}
            </span>
          </div>
          <div className="flex items-baseline justify-between text-[10px]">
            <span className="text-fg/60">est. time</span>
            <span className="font-mono text-fg/90" data-testid="cost-preview-est-seconds">
              {formatSeconds(estimate.report.estimatedSeconds)}
            </span>
          </div>
          {estimate.imageUrl ? (
            <img
              src={estimate.imageUrl}
              alt="probe frame"
              data-testid="cost-preview-sample"
              className="mt-1 max-h-32 w-full rounded border border-border object-contain bg-black/40"
            />
          ) : (
            <div
              className="mt-1 rounded border border-border bg-black/40 px-2 py-3 text-center text-[10px] text-fg/40"
              data-testid="cost-preview-sample-missing"
            >
              probe at {estimate.report.samplePath}
            </div>
          )}
        </div>
      ) : null}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitDisabled}
        data-testid="cost-preview-submit"
        className="w-full rounded border border-border bg-muted px-2 py-1 text-[11px] font-medium text-fg/90 hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-fg/80"
      >
        {inFlight || submit.status === 'running' ? 'rendering…' : 'submit render'}
      </button>

      {inFlight || submit.status === 'running' || framesDone > 0 ? (
        <div className="mt-2 space-y-0.5" data-testid="cost-preview-progress">
          <div className="flex justify-between text-[10px] text-fg/50">
            <span>progress</span>
            <span data-testid="cost-preview-progress-text">
              {framesDone}/{frameTotal}
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-accent transition-[width] duration-150"
              style={{ width: `${progressPct}%` }}
              data-testid="cost-preview-progress-bar"
            />
          </div>
        </div>
      ) : null}

      {submit.status === 'error' ? (
        <div
          className="mt-2 rounded border border-red-500/40 bg-red-500/5 px-2 py-1 text-[10px] text-red-300"
          data-testid="cost-preview-submit-error"
        >
          {submit.message}
        </div>
      ) : null}

      {submit.status === 'done' && submit.result.status === 'failed' ? (
        <div
          className="mt-2 rounded border border-red-500/40 bg-red-500/5 px-2 py-1 text-[10px] text-red-300"
          data-testid="cost-preview-submit-error"
        >
          {submit.result.error.message}
        </div>
      ) : null}

      {submit.status === 'done' && submit.result.status === 'busy' ? (
        <div
          className="mt-2 rounded border border-yellow-500/40 bg-yellow-500/5 px-2 py-1 text-[10px] text-yellow-300"
          data-testid="cost-preview-busy"
        >
          already in flight — wait for the current run to finish.
        </div>
      ) : null}
    </div>
  );
}
