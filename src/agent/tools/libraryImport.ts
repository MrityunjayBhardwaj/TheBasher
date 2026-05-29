// library.import — agent tool. Mirrors the human asset-drop path.
//
// Returns Op[] (never dispatches — V7). The Diff system applies to the fork;
// the user accepts before any real mutation.
//
// Two branches, matching the UI drop surfaces exactly:
//   - `.glb` / `.gltf` (case-insensitive) → the SAME async chokepoint the
//     human file-drop uses (`buildGltfImportOpsFromOpfs`), which eager-
//     extracts embedded animations into TransformClip + ClipSelect nodes.
//     Before this, the tool called only the static `buildAssetDropOps`, so
//     an animated glTF imported as a silent static mesh — the #81-class
//     drop, fixed on the UI surface but left open on the agent surface (#105).
//   - everything else → the static `buildAssetDropOps` GltfAsset → Transform
//     → Group chain, unchanged.
//
// V7 — the helper takes the FORKED `ctx.dagState`, never the live store, and
// the tool returns ops for the Diff (it does NOT dispatch).
//
// REF: THESIS.md §39, vyapti V7, krama K6; issue #105.

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { buildAssetDropOps } from '../../app/asset/dropChain';
import { buildGltfImportOpsFromOpfs } from '../../app/asset/importGltf';

export const libraryImportSchema = z.object({
  assetRef: z
    .string()
    .min(1, 'assetRef is required — use the library-relative path e.g. assets/cube.gltf'),
  position: z.array(z.number()).length(3).default([0, 0, 0]).describe('Position as [x, y, z]'),
});

export type LibraryImportArgs = z.infer<typeof libraryImportSchema>;

export const libraryImportTool: ToolDefinition<LibraryImportArgs> = {
  name: 'library.import',
  description:
    'Import a library asset into the scene. ' +
    'Returns an Op[] that creates a GltfAsset + Transform + Group chain ' +
    "and wires it into the Scene aggregator's children.",
  paramSchema: libraryImportSchema,
  async handler(args: LibraryImportArgs, ctx: ToolContext): Promise<ToolResult> {
    const sceneRef = ctx.dagState.outputs.scene;
    if (!sceneRef) {
      throw new Error('library.import: no Scene output found in the DAG');
    }

    // glTF → the same OPFS chokepoint the human file-drop uses, so embedded
    // animations become TransformClip + ClipSelect nodes (parity, #105). V7:
    // operate on the FORKED ctx.dagState, return ops for the Diff, never
    // dispatch. The helper reads bytes via getStorage() (client-side OPFS,
    // available in the tool handler exactly as in the UI path).
    const lower = args.assetRef.toLowerCase();
    if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
      const result = await buildGltfImportOpsFromOpfs(args.assetRef, sceneRef.node, ctx.dagState);
      return { ops: result.ops, text: `Imported ${args.assetRef} at [${args.position}]` };
    }

    // Non-glTF assetRef — unchanged static GltfAsset → Transform → Group chain.
    const dropOps = buildAssetDropOps({
      assetRef: args.assetRef,
      sceneNodeId: sceneRef.node,
      position: args.position as [number, number, number] | undefined,
    });
    return { ops: dropOps, text: `Imported ${args.assetRef} at [${args.position}]` };
  },
};
