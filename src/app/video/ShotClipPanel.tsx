// ShotClipPanel — the Controls panel's top section for a selected shot clip (#1717, design board
// 12a): its state, the seed it runs with, Regenerate, Open in Nodes and Open in ComfyUI. The
// workflow's inputs and keyed controls are the ComfyUI source section below it (the same rows the
// Nodes view and the timeline read), so this does not repeat them.
//
// THE SEED IS LOCKED BY THE FILE. A seed that is a workflow input (`seed`, a number marker) is a
// control like any other and can be keyed below. A seed written into the file as a literal (the
// built-in stylized workflow's `KSamplerSeedSet`) is the same on every run, so a regenerate changes
// only what moved; it is shown here, read-only, so the director can see it is fixed.
//
// OPEN IN COMFYUI opens the ComfyUI web UI at the address in Settings. Basher has no way to hand
// the workflow to that page yet, so the button says so: load the file there by hand.
//
// REF: src/app/video/shotClipActions.ts (`regenerateShotClip`); src/app/video/ShotClipControls.tsx.

import type { ReactNode } from 'react';
import { useDagStore } from '../../core/dag/store';
import type { NodeId } from '../../core/dag/types';
import type { ComfyApiJson } from '../../core/comfy/comfyGraph';
import { workflowSocketsOf, type ComfyUIWorkflowParams } from '../../nodes/ComfyUIWorkflow';
import { useEditorStore } from '../stores/editorStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useTimelineDockStore } from '../stores/timelineDockStore';
import { useViewportStore } from '../stores/viewportStore';
import { ClipStateBadge, useClipStatus } from './ShotClipControls';
import { regenerateShotClip, useShotClipRunStore } from './shotClipActions';

/** The seed a workflow file runs with: a `seed` input (keyable), or a literal in the file. */
export function seedOf(
  params: Partial<ComfyUIWorkflowParams>,
): { value: number; locked: boolean; where: string } | null {
  const input = workflowSocketsOf(params).inputs.find(
    (i) => i.type === 'number' && i.socket === 'seed',
  );
  if (input) {
    return {
      value: typeof input.defaultValue === 'number' ? input.defaultValue : 0,
      locked: false,
      where: 'the seed input',
    };
  }
  const apiJson = (params.graph?.apiJson ?? {}) as ComfyApiJson;
  for (const id of Object.keys(apiJson).sort((a, b) => Number(a) - Number(b))) {
    const node = apiJson[id];
    const v = node?.inputs?.seed;
    if (typeof v === 'number') return { value: v, locked: true, where: `${node.class_type} ${id}` };
  }
  return null;
}

/** Open the Nodes view on workflow `id`: the 3D space, the drawer's Nodes tab, `id` selected. */
export function openInNodes(id: NodeId): void {
  useEditorStore.getState().setSpace('view3d');
  useViewportStore.getState().setTimelineDrawerOpen(true);
  useTimelineDockStore.getState().setActiveTab('nodes');
  useSelectionStore.getState().select(id);
}

const action =
  'rounded border border-border px-2 py-0.5 text-[11px] text-fg/80 transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50 disabled:hover:border-border disabled:hover:text-fg/80';

/** The shot-clip section for workflow `workflowId`, or nothing when it stores no pictures. */
export function ShotClipPanel({ workflowId }: { workflowId: NodeId }): ReactNode {
  const params = useDagStore(
    (s) => s.state.nodes[workflowId]?.params as Partial<ComfyUIWorkflowParams> | undefined,
  );
  const status = useClipStatus(params?.outputPath ? workflowId : null);
  const running = useShotClipRunStore((s) => s.current !== null);
  const comfyUrl = useSettingsStore((s) => s.comfyUrl);
  if (!params || !status) return null;
  const seed = seedOf(params);
  return (
    <div
      data-testid={`controls-shot-clip-${workflowId}`}
      className="flex flex-col gap-1.5 border-b border-border px-3 py-2 text-[11px]"
    >
      <div className="flex items-center gap-2">
        <span className="text-fg-dim">Shot clip</span>
        <span className="flex-1 truncate text-fg/80" title={params.graph?.meta.name}>
          {params.graph?.meta.name ?? 'ComfyUI workflow'} · frames {params.frameStart ?? 0}–
          {params.frameEnd ?? 60}
        </span>
        <ClipStateBadge status={status} testId="controls-shot-state" />
      </div>
      {seed && (
        <div
          data-testid="controls-shot-seed"
          data-locked={seed.locked}
          className="text-fg-dim"
          title={
            seed.locked
              ? `Written into the workflow file (${seed.where}): every run uses it, so a regenerate changes only what moved.`
              : 'A workflow input: set or key it in the controls below.'
          }
        >
          Seed <span className="font-mono text-fg">{seed.value}</span>
          {seed.locked ? ' · locked' : ' · an input below'}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-testid="controls-shot-regenerate"
          className={action}
          disabled={running || status.state === 'cannot-run'}
          title="Render this shot's passes and run its workflow again (what it depends on first)"
          onClick={() => void regenerateShotClip(workflowId)}
        >
          {status.state === 'unmade' ? 'Generate' : 'Regenerate'}
        </button>
        <button
          type="button"
          data-testid="controls-shot-open-nodes"
          className={action}
          title="Show this workflow node in the Nodes view"
          onClick={() => openInNodes(workflowId)}
        >
          Open in Nodes
        </button>
        <button
          type="button"
          data-testid="controls-shot-open-comfy"
          className={action}
          title={`Opens ComfyUI at ${comfyUrl}. Basher cannot hand the workflow to that page yet: load the file there yourself.`}
          onClick={() => window.open(comfyUrl, '_blank', 'noopener')}
        >
          Open in ComfyUI
        </button>
      </div>
    </div>
  );
}
