// shotCompare — the 3D render a generated shot came from, at a playhead (#1717, design board 12a:
// "the viewer compares Generated with the 3D render it came from, or wipes between them").
//
// "The render it came from" is literal: the beauty pass file the shot's workflow read for that
// frame (`passFramePath`, written when the shot was generated, #1717's prepare step). The viewer
// shows that file, the composite, or a wipe between the two. A frame whose render has not been
// written yet has none (the viewer says so rather than inventing one).
//
// PURE: which file, at which frame. The viewer reads and draws it.
//
// REF: src/app/video/shotClips.ts (the clip ↔ workflow tie); src/render/compileWorkflowFrame.ts
//      (`passFramePath`, where the run reads its passes).

import type { DagState } from '../../core/dag/state';
import type { NodeId, NodeRef } from '../../core/dag/types';
import type { ComfyUIWorkflowParams } from '../../nodes/ComfyUIWorkflow';
import { passFramePath } from '../../render/compileWorkflowFrame';
import { collectLayerRows } from './videoLayers';
import { layerBarSpan } from './videoTimelineGeometry';
import { layerWorkflowOf } from './shotClips';

/** What the viewer shows: the composite, the 3D render it came from, or a wipe between them. */
export type ViewerCompare = 'generated' | 'render' | 'wipe';

/** The runner's cadence: workflow frames are film frames at 30 fps. */
const FILM_FPS = 30;

/**
 * The beauty render the topmost visible workflow clip at `compFrame` was made from: its path, the
 * clip's layer and the film frame. Null when no workflow clip with a beauty pass covers the frame.
 */
export function renderSourceAt(
  state: DagState,
  compId: NodeId,
  compFrame: number,
): {
  readonly path: string;
  readonly layerId: NodeId;
  readonly filmFrame: number;
  /** Changes when a run rewrites the file (what it was made from, how far it got). */
  readonly version: string;
} | null {
  const comp = state.nodes[compId]?.params as { fps?: number } | undefined;
  const compFps = comp?.fps ?? 30;
  const rows = collectLayerRows(state, compId);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row.enabled) continue;
    const span = layerBarSpan(row, row.srcFrames);
    if (compFrame < span.startFrame || compFrame >= span.startFrame + span.lengthFrames) continue;
    const workflowId = layerWorkflowOf(state, row.id);
    if (!workflowId) continue;
    const wf = state.nodes[workflowId];
    const params = wf.params as Partial<ComfyUIWorkflowParams>;
    const beauty = wf.inputs.beauty as NodeRef | NodeRef[] | undefined;
    const ref = Array.isArray(beauty) ? beauty[0] : beauty;
    if (!params.outputPath || !ref || state.nodes[ref.node]?.type !== 'BeautyPass') continue;
    // Comp frame → the workflow's frame: the layer starts at the workflow's first frame.
    const local = compFrame - row.startFrame + row.inPoint;
    const filmFrame = (params.frameStart ?? 0) + Math.round((local * FILM_FPS) / compFps);
    return {
      path: passFramePath(params.outputPath, 'beauty', filmFrame),
      layerId: row.id,
      filmFrame,
      version: `${params.madeFrom ?? ''}|${params.lastGoodFrame ?? -1}`,
    };
  }
  return null;
}
