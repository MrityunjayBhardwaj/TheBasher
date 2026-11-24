// workflowPaths — where a ComfyUI workflow node's pictures land in storage (D-04).
//
// Moved out of src/render/dryRun.ts for #1718 so the node itself can say where its still is
// (`ImageValue.storedAt`) without the node layer reaching into the runner. The runner, the cost
// preview, the stitch and the node all read these two, so a picture is looked for where it was
// written.

import type { WorkflowSockets } from './workflowSockets';

/** Where output `socket` of a workflow node writes its frames: the first output at the node's
 *  `outputPath` (what the stitch and the compositor read), every other one beside it. */
export function outputPathOf(outputPath: string, sockets: WorkflowSockets, socket: string): string {
  const first = sockets.outputs[0]?.socket;
  if (socket === first) return outputPath;
  return `${outputPath.replace(/\/+$/, '')}__${socket.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/**
 * D-04 frame path formula: `${outputPath}_${pad4(frame)}.png`.
 *
 * The Mutator sets outputPath to `renders/${jobId}/stylized_<workflow>`;
 * dryRun + runComfyUIWorkflow append `_${pad4(frame)}.png`. Stylized
 * frames live at the same OPFS prefix as raw passes per D-04 (parallel
 * tree decision) — the `stylized_` prefix prevents collision
 * with `${passKind}_NNNN.png` (raw passes from runRenderJob).
 */
export function framePath(outputPath: string, frame: number): string {
  const trimmed = outputPath.replace(/\/+$/, '');
  const padded = frame.toString().padStart(4, '0');
  return `${trimmed}_${padded}.png`;
}
