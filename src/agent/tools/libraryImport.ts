// library.import — agent tool wrapping buildAssetDropOps.
//
// Pure: returns Op[] (never dispatches). The 6-op chain mirrors the human
// asset-drop path. The Diff system applies to the fork; user accepts before
// any real mutation.
//
// REF: THESIS.md §39, vyapti V7, krama K6.

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { buildAssetDropOps } from '../../app/asset/dropChain';

export const libraryImportSchema = z.object({
  assetRef: z
    .string()
    .min(1, 'assetRef is required — use the library-relative path e.g. assets/cube.gltf'),
  position: z
    .array(z.number())
    .length(3)
    .default([0, 0, 0])
    .describe('Position as [x, y, z]'),
});

export type LibraryImportArgs = z.infer<typeof libraryImportSchema>;

export const libraryImportTool: ToolDefinition<LibraryImportArgs> = {
  name: 'library.import',
  description:
    'Import a library asset into the scene. ' +
    'Returns an Op[] that creates a GltfAsset + Transform + Group chain ' +
    'and wires it into the Scene aggregator\'s children.',
  paramSchema: libraryImportSchema,
  handler(args: LibraryImportArgs, ctx: ToolContext): ToolResult {
    const sceneRef = ctx.dagState.outputs.scene;
    if (!sceneRef) {
      throw new Error('library.import: no Scene output found in the DAG');
    }
    const dropOps = buildAssetDropOps({
      assetRef: args.assetRef,
      sceneNodeId: sceneRef.node,
      position: args.position as [number, number, number] | undefined,
    });
    return { ops: dropOps, text: `Imported ${args.assetRef} at [${args.position}]` };
  },
};
