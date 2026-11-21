// ShotClipControls — the Video space's shot-clip surface (#1717, design board 12a): "Make shot
// clips", "Generate stale shots (N)", and the generated / stale / generating badge on each clip.
//
// Every state is read, not stored: the clips off the shots (`shotClipsOf`), each clip's state off
// its workflow (`madeStateOf`, every frame of the shot), and "generating" off the run store and
// the workflow's own resume sentinel (`lastGoodFrame`, which the runner advances frame by frame).
//
// REF: src/app/video/shotClips.ts; src/app/video/shotClipActions.ts.

import type { ReactNode } from 'react';
import { useDagStore } from '../../core/dag/store';
import type { NodeId } from '../../core/dag/types';
import type { ComfyUIWorkflowParams } from '../../nodes/ComfyUIWorkflow';
import type { WorkflowMadeState } from '../../nodes/comfyWorkflowMade';
import { madeStateOf } from '../render/workflowMadeFrom';
import { uiEvaluatorCache } from '../uiEvaluatorCache';
import { generateStaleShots, makeShotClips, useShotClipRunStore } from './shotClipActions';
import { layerWorkflowOf, shotClipsOf, shotsToGenerate } from './shotClips';

/** What a clip shows: its made state, or that it is being made now. */
export type ClipState = WorkflowMadeState | 'generating';

const WORDS: Record<ClipState, string> = {
  unmade: 'not generated',
  current: 'generated',
  stale: 'stale',
  'cannot-run': 'cannot run',
  generating: 'generating',
};

export interface ClipStatus {
  readonly state: ClipState;
  /** Shown beside "generating": what it is doing and how far. */
  readonly progress: string | null;
}

/** The status of workflow `id`'s clip: generating while the run store works on it, else its made
 *  state. */
export function useClipStatus(id: NodeId | null): ClipStatus | null {
  const made = useDagStore((s) => (id ? madeStateOf(s.state, id, uiEvaluatorCache) : null));
  const landed = useDagStore((s) => {
    const p = id ? (s.state.nodes[id]?.params as Partial<ComfyUIWorkflowParams> | undefined) : null;
    return p ? (p.lastGoodFrame ?? -1) - (p.frameStart ?? 0) + 1 : 0;
  });
  const run = useShotClipRunStore();
  if (!id || made === null) return null;
  if (run.current === id && run.phase !== null) {
    const done = run.phase === 'rendering' ? run.done : Math.max(0, landed);
    return {
      state: 'generating',
      progress: `${run.phase === 'rendering' ? 'rendering' : 'generating'} ${done}/${run.total}`,
    };
  }
  return { state: made, progress: null };
}

const TONE: Record<ClipState, string> = {
  current: 'border-accent text-accent',
  stale: 'border-warn text-warn',
  generating: 'border-accent text-fg',
  unmade: 'border-border text-fg-mute',
  'cannot-run': 'border-border text-fg-mute',
};

export function ClipStateBadge({ status, testId }: { status: ClipStatus; testId: string }) {
  return (
    <span
      data-testid={testId}
      data-state={status.state}
      title={status.progress ?? WORDS[status.state]}
      className={`shrink-0 rounded border px-1 font-mono text-[9px] uppercase tracking-wide ${TONE[status.state]}`}
    >
      {status.progress ?? WORDS[status.state]}
    </span>
  );
}

/** The badge on a layer row whose source is a workflow that stores its pictures; else nothing. */
export function LayerClipBadge({ layerId }: { layerId: NodeId }): ReactNode {
  const workflowId = useDagStore((s) => {
    const id = layerWorkflowOf(s.state, layerId);
    const p = id ? (s.state.nodes[id].params as Partial<ComfyUIWorkflowParams>) : null;
    return id && p?.outputPath ? id : null;
  });
  const status = useClipStatus(workflowId);
  if (!status) return null;
  return <ClipStateBadge status={status} testId={`layer-clip-state-${layerId}`} />;
}

const button =
  'rounded bg-bg-2 px-2 py-0.5 text-[11px] text-fg hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:text-fg/40';

/** "Make shot clips" and "Generate stale shots (N)", for the composition `compId`. */
export function ShotClipBar({ compId }: { compId: NodeId }): ReactNode {
  const missing = useDagStore(
    (s) => shotClipsOf(s.state, compId).filter((c) => !c.workflowId || !c.layerId).length,
  );
  const toGenerate = useDagStore((s) => shotsToGenerate(s.state, compId, uiEvaluatorCache).length);
  const running = useShotClipRunStore((s) => s.current !== null);
  return (
    <>
      <button
        type="button"
        data-testid="video-mode-make-shot-clips"
        disabled={missing === 0 || running}
        title={
          missing === 0
            ? 'Every shot has its clip.'
            : `Add a clip for ${missing} shot${missing === 1 ? '' : 's'}: a ComfyUI workflow (Stylized realism) fed by the shot's render passes`
        }
        onClick={() => makeShotClips(compId)}
        className={button}
      >
        Make shot clips
      </button>
      <button
        type="button"
        data-testid="video-mode-generate-stale"
        data-count={toGenerate}
        disabled={toGenerate === 0 || running}
        title="Render and generate only the shots that are stale or not generated yet, each once"
        onClick={() => void generateStaleShots(compId)}
        className={button}
      >
        Generate stale shots ({toGenerate})
      </button>
    </>
  );
}
