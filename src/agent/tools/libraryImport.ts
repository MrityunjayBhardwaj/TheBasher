// library.import — agent tool. Mirrors the human asset-drop path.
//
// Returns Op[] (never dispatches — V7). The Diff system applies to the fork;
// the user accepts before any real mutation.
//
// One branch per import family, matching the UI's extension dispatcher
// (`routeImportByExtension`) exactly:
//   - a model (`.glb` / `.gltf`) → the SAME async chokepoint the human
//     file-drop uses (`buildGltfImportOpsFromOpfs`). Before #105 the tool
//     called only a static drop chain, so an animated glTF imported as a
//     silent static mesh.
//   - a motion (`.bvh` / `.fbx`) → `buildMotionImportOpsFromOpfs`, the chain
//     the UI's motion import dispatches: Skeleton + base pose layer + the
//     Object that stands it. Before #1307 a motion fell through to that static
//     chain and became a GltfAsset reading a motion file, reported "Imported".
//   - anything else is refused by name. No format, no chain.
//
// V7 — the helper takes the FORKED `ctx.dagState`, never the live store, and
// the tool returns ops for the Diff (it does NOT dispatch).
//
// REF: THESIS.md §39, vyapti V7, krama K6; issue #105.

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { buildMotionImportOpsFromOpfs } from '../../app/asset/importBvhFbx';
import { IMPORT_EXTENSIONS, importFormatOf } from '../../app/asset/importFormats';
import {
  buildGltfImportOpsFromOpfs,
  leftBehindNotice,
  refusalNotice,
} from '../../app/asset/importGltf';

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
    "Returns an Op[] that imports the model and wires it into the Scene aggregator's children: " +
    'a Group of Object + mesh data nodes when the file can become native geometry, otherwise ' +
    'a GltfAsset + Group chain that reads the file. A motion (.bvh, .fbx) imports as a ' +
    'skeleton with its keys on a base pose layer and an Object that stands it, not bound to a ' +
    'character; an .fbx with meshes or empties lands with them in a Group (a character), and ' +
    'one with no bone as a model of meshes and empties in a Group. A file in no import format ' +
    'is refused.',
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
    // #662 — the family, from the category, not a respelled pair. This site reported
    // `Imported …` for a format it had built the WRONG chain for, because a format missing
    // from the spelling fell through to the static branch below and still looked like a win.
    const format = importFormatOf(args.assetRef);
    if (!format) {
      return {
        ops: [],
        text: `Error: ${args.assetRef} was not imported — it is in no import format (expected ${IMPORT_EXTENSIONS.join(', ')}).`,
      };
    }
    if (format.family === 'model') {
      const result = await buildGltfImportOpsFromOpfs(args.assetRef, sceneRef.node);
      // #1053 — a file the native reader refused is not imported at all.
      if (result.road === 'refused') {
        return {
          ops: [],
          text: `Error: ${args.assetRef} was not imported — ${refusalNotice(result.nativeRefusal)}.`,
        };
      }
      return {
        ops: result.ops,
        text: `Imported ${args.assetRef} at [${args.position}]${leftBehindNotice(result.notices)}`,
      };
    }

    // #1307 — a motion stands where its file puts it, as the UI import does: `position` is not
    // applied, and the text says so rather than claiming it. Binding it to a character is a
    // separate step on this surface (the UI's drop binds after dispatch, which a Diff cannot).
    const motion = await buildMotionImportOpsFromOpfs(args.assetRef, ctx.dagState);
    // #1434 — the text says what landed, by the kind the import decided.
    const meshes = `${motion.meshCount} mesh${motion.meshCount === 1 ? '' : 'es'}`;
    const said =
      motion.kind === 'model'
        ? `Imported ${args.assetRef} as a model: ${meshes} and the file's empties in a Group (${motion.groupId}), standing where the file puts them. It has no skeleton.`
        : motion.kind === 'character'
          ? `Imported ${args.assetRef} as a character: a skeleton (${motion.skeletonId}) with its keys on a base pose layer (${motion.motionId}) and ${meshes}, in a Group, standing where the file puts it.`
          : `Imported ${args.assetRef} as a motion: a skeleton (${motion.skeletonId}) with its keys on a base pose layer (${motion.motionId}), standing where the file puts it. It is not bound to a character.`;
    return { ops: [...motion.ops], text: `${said}${leftBehindNotice(motion.notices)}` };
  },
};
