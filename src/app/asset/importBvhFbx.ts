// BVH / FBX OPFS import chokepoints + the cross-format extension dispatcher —
// Phase 7.14 Wave A (issue #111).
//
// The BVH and FBX importers (`buildBvhImportOps` / `buildFbxImportOps`) already
// exist and emit ONLY a Skeleton + AnimationClip pair (FBX in Basher is MOTION,
// not a model — P3.1 Mixamo-retarget heritage). Until now they were reachable
// only through the `__basher_importBvh` / `__basher_importFbx` dev seams
// (boot.ts:240-255). This module is the missing INGESTION SURFACE: read the
// OPFS bytes a drop/picker wrote, decode them per-format, build the op chain,
// dispatch atomically (K6), and bump the My-Imports refresh signal.
//
// Asymmetry vs glTF (grounded, CONTEXT D-03): glTF persists an `assetRef` on
// its GltfAsset node; BVH/FBX leave NO persistent reference (they dispatch
// Skeleton+AnimationClip and nothing holds the OPFS path afterwards). So a
// re-import is a fresh import, and a My-Imports rename of a BVH/FBX entry is a
// folder move only — no ref rewrite.
//
// Invariants honored:
//   - V8: no `src/viewport/` imports. App-layer module.
//   - K6: ONE dispatchAtomic per import.
//   - silent-failure: every failure path routes to assetErrorStore — a bad
//     decode or a missing TimeSource surfaces in the banner, never console-only.
//
// REF: phase 7.14 PLAN Wave A (A2), CONTEXT D-02/D-03/D-04; boot.ts:240-255
//      (the existing seams); bvhImportChain.ts / fbxImportChain.ts (the
//      importers, unchanged).

import { applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import type { Op } from '../../core/dag/types';
import { buildBvhImportOps } from '../../core/import/bvhImportChain';
import { buildFbxImportOps } from '../../core/import/fbxImportChain';
import { buildSkeletonObjectOps } from '../../core/import/skeletonObject';
import type { AnimationClipValue, BoneSpec } from '../../nodes/types';
import { getStorage } from '../boot';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { importGltfFromOpfs } from './importGltf';
import {
  bindMotionToCharacter,
  type BindMotionOutcome,
  type MotionArrival,
} from './bindMotionToCharacter';
import { importFormatOf, UNSUPPORTED_FORMAT_MESSAGE, type ImportExt } from './importFormats';

/**
 * What a motion import produced, so a caller can act on it (#807).
 *
 * These two ids were always minted and always thrown away: `buildBvhImportOps`
 * returns them and this module destructured `{ ops }` alone, which left the
 * clip that had just landed unaddressable by anything downstream. Returning them
 * is what lets a drop bind the motion to a character instead of stopping at "the
 * nodes exist somewhere".
 */
export interface MotionImportResult {
  readonly skeletonId: string;
  readonly clipId: string;
}

/** Strip the directory + extension to a display name for the import label. */
function nameFromPath(path: string): string {
  const base = path.split('/').filter(Boolean).pop() ?? path;
  return base.replace(/\.[^.]+$/, '') || base;
}

/**
 * #1056 — the ops that stand an imported motion in the scene as an Object of its own, or none.
 *
 * EVERY import gets one, whatever else is in the scene. What an import produces must not
 * depend on whether a character happens to be there: neither a director nor the agent could
 * say what a drop will make, and deleting the character later would leave the motion with no
 * scene presence at all. Blender's BVH importer never reads the scene either — `load()` always
 * creates an armature Object (io_anim_bvh/import_bvh.py, Blender 5.1.1).
 *
 * A bound clip does not leave a second rig standing beside its character: the bind that
 * follows hides this Object in its own op batch (`mutator.animation.retarget`), so undoing
 * the bind brings it back. It lands in the import's single dispatch (K6). A project with no
 * scene aggregator has nowhere to stand one, and gets the import alone.
 *
 * `normalise` is true for both file formats: BVH declares no unit, and the FBX road does not
 * read one either, so neither knows how big the rig is meant to be. The size is measured on
 * the clip's frame 0 — the pose the director first sees — not on the file's rest pose, which
 * need not stand up (`normalisedRigScale`).
 */
function skeletonObjectOps(
  ops: readonly Op[],
  skeletonId: string,
  clipId: string,
  // #1101 — the name the import gave the clip, so the Object and its motion read the same.
  name: string,
): Op[] {
  const skeleton = ops.find((op) => op.type === 'addNode' && op.nodeId === skeletonId);
  const params = skeleton?.type === 'addNode' ? skeleton.params : undefined;
  const bones = (params as { bones?: BoneSpec[] } | undefined)?.bones ?? [];
  if (bones.length === 0) return [];
  const { state } = useDagStore.getState();
  const sceneNodeId = state.outputs.scene?.node;
  if (!sceneNodeId) return [];
  const clip = importedClip(state, ops, clipId);
  return buildSkeletonObjectOps({ skeletonId, bones, clip, sceneNodeId, normalise: true, name })
    .ops;
}

/**
 * The clip this import is about to add, evaluated on a scratch copy of the graph with the
 * import applied. It has to be read BEFORE the dispatch, because the scale it sets is part of
 * that same single dispatch. Null when it does not evaluate — the rig is then sized from its
 * rest pose, which can be wrong for a file whose rest pose lies down, but still draws.
 */
function importedClip(
  state: DagState,
  ops: readonly Op[],
  clipId: string,
): AnimationClipValue | null {
  try {
    let scratch = state;
    for (const op of ops) scratch = applyOp(scratch, op).next;
    const value = evaluate(scratch, clipId, {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    }).value as AnimationClipValue | undefined;
    return value?.kind === 'AnimationClip' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read a `.bvh` from OPFS and import it as a Skeleton + AnimationClip.
 *
 * BVH is TEXT: decode the bytes with TextDecoder before parsing. A wrong decode
 * (or a TimeSource-less project) throws inside `buildBvhImportOps`; the catch
 * routes it to assetErrorStore so the failure is visible, not swallowed.
 */
export async function importBvhFromOpfs(path: string): Promise<MotionImportResult | null> {
  try {
    const storage = await getStorage();
    const bytes = await storage.read(path);
    const text = new TextDecoder().decode(bytes);
    const dag = useDagStore.getState();
    const name = nameFromPath(path);
    const { ops, skeletonId, clipId } = buildBvhImportOps({ text, name });
    const standIn = skeletonObjectOps(ops, skeletonId, clipId, name);
    dag.dispatchAtomic([...ops, ...standIn], 'user', `import bvh: ${path}`);
    // Bump AFTER dispatch (pre-mortem: a pre-dispatch bump re-enumerates the
    // My-Imports list before the import lands → stale/empty on failure).
    useImportRefreshStore.getState().bump();
    return { skeletonId, clipId };
  } catch (err) {
    useAssetErrorStore.getState().report(path, `import failed: ${formatAssetError(err)}`);
    // `null` means "nothing landed", and the banner is already showing why. It is
    // NOT an empty success — a caller that went on to bind would find no clip.
    return null;
  }
}

/**
 * Read a `.fbx` from OPFS and import it as a Skeleton + AnimationClip.
 *
 * FBX is BINARY: pass the raw ArrayBuffer straight to `buildFbxImportOps`
 * (`parseFbx` accepts ArrayBuffer | string). Detach a fresh, non-shared
 * ArrayBuffer (the OPFS read may back a SharedArrayBuffer) so the parser gets a
 * plain buffer — mirror of the glTF detach in buildGltfImportOpsFromOpfs.
 */
export async function importFbxFromOpfs(path: string): Promise<MotionImportResult | null> {
  try {
    const storage = await getStorage();
    const bytes = await storage.read(path);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const dag = useDagStore.getState();
    const name = nameFromPath(path);
    const { ops, skeletonId, clipId } = buildFbxImportOps({ data: copy.buffer, name });
    const standIn = skeletonObjectOps(ops, skeletonId, clipId, name);
    dag.dispatchAtomic([...ops, ...standIn], 'user', `import fbx: ${path}`);
    useImportRefreshStore.getState().bump();
    return { skeletonId, clipId };
  } catch (err) {
    useAssetErrorStore.getState().report(path, `import failed: ${formatAssetError(err)}`);
    return null;
  }
}

/**
 * What each format does with an already-ingested OPFS entry.
 *
 * 🔑 THE TYPE IS THE POINT. `Record<ImportExt, …>` is exhaustive, so adding a format to
 * `IMPORT_EXTENSIONS` without giving it an arm here does not compile. Before #662 the same
 * omission fell through an `else if` chain to "unsupported format" — a format that had been
 * added to the picker, the drop zone and the library, and then refused at the one site that
 * actually imports it. That failure is now unwritable rather than merely tested for.
 *
 * The map lives HERE and not in `importFormats.ts` because it needs the importers, and a
 * category module that imported them would close a new module cycle (#814).
 */
const IMPORT_BY_EXT: Readonly<Record<ImportExt, (entryPath: string) => Promise<void>>> = {
  '.gltf': async (entryPath) => {
    await importGltfFromOpfs(entryPath);
  },
  '.glb': async (entryPath) => {
    await importGltfFromOpfs(entryPath);
  },
  '.bvh': async (entryPath) => {
    bindImportedMotion(await importBvhFromOpfs(entryPath), 'imported');
  },
  '.fbx': async (entryPath) => {
    bindImportedMotion(await importFbxFromOpfs(entryPath), 'imported');
  },
};

/**
 * Route an already-ingested OPFS entry to the right per-format importer by its
 * file extension. The single dispatch point that AssetDropZone + MenuBar call
 * after writing bytes to OPFS (D-04: one affordance accepts all four formats).
 *
 * An unrecognised extension is NOT a silent no-op — it reports to
 * assetErrorStore so a mistaken drop tells the user why nothing happened.
 */
export async function routeImportByExtension(entryPath: string): Promise<void> {
  const format = importFormatOf(entryPath);
  if (!format) {
    useAssetErrorStore.getState().report(entryPath, UNSUPPORTED_FORMAT_MESSAGE);
    return;
  }
  await IMPORT_BY_EXT[format.ext](entryPath);
}

/**
 * Put a just-landed motion clip onto a character (#807).
 *
 * This sits at the extension dispatcher rather than in the drop handler on
 * purpose: the drop zone, the Import… picker and the Library all funnel through
 * here, and motion that animates a character when it is dropped but not when it
 * is picked would be a difference no director could predict. `null` means the
 * import itself failed and already reported — there is nothing to bind, and
 * saying anything more would be a second message about one problem.
 *
 * EXPORTED for the generation road (#820), which is the same argument one step
 * wider: a clip that animates a character when it is dropped but not when it is
 * generated is the same unpredictable difference, on the pair a director is far
 * more likely to notice. The generated road calls THIS function rather than
 * `bindMotionToCharacter` directly, so "bind after motion lands" — and the
 * null-handling that goes with it — is decided in exactly one place.
 *
 * `bindMotionToCharacter` surfaces its own outcome, so a caller that only wants
 * the motion bound can keep ignoring the return — the drop road above does, and
 * nothing is left unreported when it does.
 *
 * It is RETURNED rather than swallowed because the generation road needs to know
 * WHICH character was chosen (#730): a motion generated along an authored path
 * has to move that character to the path's start, and the choice is made in here.
 * `null` means no bind was attempted at all, which is a different answer from a
 * bind that was attempted and refused.
 */
export function bindImportedMotion(
  imported: MotionImportResult | null,
  arrival: MotionArrival,
): BindMotionOutcome | null {
  if (!imported) return null;
  return bindMotionToCharacter(imported, arrival);
}
