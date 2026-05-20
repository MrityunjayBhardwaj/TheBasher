// camera.snapshot — agent tool that captures the editor camera pose into
// a new PerspectiveCamera DAG node.
//
// Pure: returns Op[] (never dispatches). The handler reads the editor camera
// pose from the dagState + a provided `cameraPose` arg (the orchestrator
// captures this from the ThreeBridge projection before invoking the tool).
//
// REF: THESIS.md §11, vyapti V7, krama K9.

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import type { Op } from '../../core/dag/types';

export const cameraSnapshotSchema = z.object({
  fov: z.number().positive().default(45).describe('Camera field of view in degrees'),
  position: z.array(z.number()).length(3).describe('Camera position as [x, y, z]'),
  lookAt: z
    .array(z.number())
    .length(3)
    .default([0, 0, 0])
    .describe('Target point the camera looks at as [x, y, z]'),
});

export type CameraSnapshotArgs = z.infer<typeof cameraSnapshotSchema>;

export const cameraSnapshotTool: ToolDefinition<CameraSnapshotArgs> = {
  name: 'camera.snapshot',
  description:
    'Create a new PerspectiveCamera node from a camera pose. ' +
    'The new camera is wired into the Scene aggregator, replacing any existing camera. ' +
    'Returns an Op[] that the Diff system applies to the fork.',
  paramSchema: cameraSnapshotSchema,
  handler(args: CameraSnapshotArgs, ctx: ToolContext): ToolResult {
    const sceneRef = ctx.dagState.outputs.scene;
    if (!sceneRef) {
      throw new Error('camera.snapshot: no Scene output found in the DAG');
    }
    const sceneNode = ctx.dagState.nodes[sceneRef.node];
    if (!sceneNode) {
      throw new Error('camera.snapshot: Scene aggregator node not found');
    }
    if (sceneNode.type !== 'Scene') {
      throw new Error(
        `camera.snapshot: outputs.scene points at "${sceneRef.node}" but its type is "${sceneNode.type}", expected "Scene"`,
      );
    }
    const existing = sceneNode.inputs.camera;
    if (Array.isArray(existing)) {
      throw new Error('camera.snapshot: Scene.camera input has unexpected list cardinality');
    }

    // Deterministic id (V2 / THESIS §48): content-addressed off the
    // tool args + the target scene node so the twice-call determinism
    // test holds byte-faithfully even when the two calls cross a
    // millisecond boundary (latent flake exposed under CI load — was
    // `Date.now().toString(36)`, which silently failed determinism
    // whenever the two calls landed in different ms).
    const idKey = JSON.stringify([sceneRef.node, args.fov, args.position, args.lookAt]);
    let h = 0x811c9dc5;
    for (let i = 0; i < idKey.length; i++) {
      h ^= idKey.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    const newId = `cam_agent_${h.toString(16).padStart(8, '0')}`;
    const ops: Op[] = [];

    if (existing) {
      ops.push({
        type: 'disconnect',
        from: existing,
        to: { node: sceneRef.node, socket: 'camera' },
      });
    }

    ops.push({
      type: 'addNode',
      nodeId: newId,
      nodeType: 'PerspectiveCamera',
      params: {
        fov: args.fov,
        near: 0.1,
        far: 1000,
        position: args.position,
        lookAt: args.lookAt,
      },
    });

    ops.push({
      type: 'connect',
      from: { node: newId, socket: 'out' },
      to: { node: sceneRef.node, socket: 'camera' },
    });

    return { ops, text: `Snapshot camera at [${args.position}] looking at [${args.lookAt}]` };
  },
};
