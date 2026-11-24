// compileWorkflowFrame — #1715: one frame of ANY workflow file, ready to submit.
//
// The generic replacement for the per-preset compilers. It reads the node's sockets off the
// workflow file (`socketsOfWorkflow`, the one derivation) and fills each Basher input marker for
// this frame:
//   - a still image / frames input with what arrives on its socket: that frame's picture is
//     uploaded and the marker reads it as an image file (one frame per submit, so a frames
//     marker is submitted as kind image too);
//   - a number / text input with its value (wired, keyed, or the marker's own default), written
//     into the marker's `values_json` like the batch path does;
//   - a FED input (`feedback_of`) with the picture its output made on the frame before. On the
//     first frame there is none: the marker keeps its own `image` file when it names one, and
//     gets a black picture when it does not.
// Nothing about any particular model is known here.
//
// Where a picture's bytes come from: a picture that says where it is stored (`storedAt`: an image
// clip's file, another workflow's still) is read from there. A render pass writes each frame next to the job
// (`${jobDir}/${passKind}_NNNN.png`, runRenderJob), and the workflow's output path sits in the
// same job directory (D-04), so an arriving pass is read from there, at the frame it carries.
//
// REF: src/core/comfy/workflowSockets.ts; src/core/comfy/basherControllers.ts (the marker
// fields); docs/COMFYUI-BASHER-NODES.md; dryRun.ts (CompileWorkflowFn).

import type { ComfyInputs } from '../core/comfy';
import type { ComfyApiJson, ComfyInputValue } from '../core/comfy/comfyGraph';
import { socketsOfWorkflow } from '../core/comfy/workflowSockets';
import type { StorageCapability } from '../core/storage';
import { textOf } from '../nodes/ComfyUIWorkflow';
import type { ImageValue } from '../nodes/types';
import type { CompileWorkflowFn } from './dryRun';

/** A 1×1 black PNG: the picture a fed input gets on the first frame when its marker names none. */
export const BLACK_FRAME_PNG = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x02,
  0x00,
  0x00,
  0x00,
  0x90,
  0x77,
  0x53,
  0xde,
  0x00,
  0x00,
  0x00,
  0x10,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0x01,
  0x01,
  0x04,
  0x00,
  0xfb,
  0xff,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0x0d,
  0x0a,
  0x2d,
  0xb4,
  0x95,
  0x73,
  0x95,
  0xff,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
);

/** The render passes that write their frames next to the job. */
const PASS_KINDS: ReadonlySet<string> = new Set(['beauty', 'id', 'depth', 'normal']);

/** The upload name a marker's picture goes under (the capability uploads `${key}.png`). */
export function uploadKeyOf(markerNodeId: string): string {
  return `basher_${markerNodeId}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

function jobDirOf(workflowOutputPath: string): string {
  const trimmed = workflowOutputPath.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash < 0 ? '' : trimmed.slice(0, slash);
}

/** Where a render pass wrote `frame`: `${jobDir}/${passKind}_NNNN.png`. */
export function passFramePath(workflowOutputPath: string, passKind: string, frame: number): string {
  const dir = jobDirOf(workflowOutputPath);
  const name = `${passKind}_${frame.toString().padStart(4, '0')}.png`;
  return dir ? `${dir}/${name}` : name;
}

async function bytesOfArrival(
  storage: StorageCapability,
  workflowOutputPath: string,
  socket: string,
  value: ImageValue,
  frame: number,
): Promise<Uint8Array> {
  // #1947 — a picture that says where its bytes are is read from there (an image clip), never
  // taken for the job's render pass of the same kind.
  if (value.storedAt) {
    if (!(await storage.exists(value.storedAt))) {
      throw new Error(
        `The picture on "${socket}" is not at ${value.storedAt} yet. Make it first (run the ` +
          'node it comes from).',
      );
    }
    return storage.read(value.storedAt);
  }
  if (!PASS_KINDS.has(value.passKind)) {
    throw new Error(
      `The picture on "${socket}" comes from a ${value.passKind} node; a frame-by-frame run can ` +
        'read render passes only.',
    );
  }
  // #1716 — a still picked out of a run of frames names the frame it was picked from.
  const at =
    value.extent?.kind === 'still' && value.extent.pickedFrame !== undefined
      ? value.extent.pickedFrame
      : frame;
  const path = passFramePath(workflowOutputPath, value.passKind, at);
  if (!(await storage.exists(path))) {
    throw new Error(
      `The ${value.passKind} pass for frame ${at} is not at ${path}. Render the passes first.`,
    );
  }
  return storage.read(path);
}

/** The default `CompileWorkflowFn`: any workflow file, one frame, from its markers. */
export function compileWorkflowFrame({
  storage,
}: {
  storage: StorageCapability;
}): CompileWorkflowFn {
  return async ({ apiJson, frame, inputs, fed, workflowOutputPath }) => {
    const sockets = socketsOfWorkflow(apiJson);
    const out = structuredClone(apiJson) as ComfyApiJson;
    const images: Record<string, Uint8Array> = {};
    const fill = (nodeId: string, fields: Record<string, ComfyInputValue>) => {
      const node = out[nodeId];
      if (node?.inputs) Object.assign(node.inputs as Record<string, ComfyInputValue>, fields);
    };
    const putImage = (nodeId: string, bytes: Uint8Array) => {
      const key = uploadKeyOf(nodeId);
      images[key] = bytes;
      fill(nodeId, { kind: 'image', image: `${key}.png` });
    };

    for (const input of sockets.inputs) {
      const value = inputs[input.socket];
      if (input.type === 'still' || input.type === 'frames') {
        // Nothing wired: the marker keeps whatever file it names itself.
        if (value === undefined) continue;
        putImage(
          input.nodeId,
          await bytesOfArrival(
            storage,
            workflowOutputPath,
            input.socket,
            value as ImageValue,
            frame,
          ),
        );
        continue;
      }
      const given =
        input.type === 'text' ? textOf(value) : typeof value === 'number' ? value : null;
      const v = given ?? input.defaultValue;
      fill(input.nodeId, { values_json: JSON.stringify([v]), frame_count: 1 });
    }

    for (const f of sockets.fed) {
      const prev = fed[f.nodeId] ?? null;
      if (prev && (await storage.exists(prev))) {
        putImage(f.nodeId, await storage.read(prev));
        continue;
      }
      // The first frame: the marker's own file when it names one, else black.
      const own = out[f.nodeId]?.inputs?.image;
      if (typeof own === 'string' && own.trim()) continue;
      putImage(f.nodeId, BLACK_FRAME_PNG);
    }

    const compiled: ComfyInputs = { images, scalars: { frame } };
    return { workflowJson: out, inputs: compiled };
  };
}
