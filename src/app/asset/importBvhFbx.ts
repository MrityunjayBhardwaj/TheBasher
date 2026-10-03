// BVH / FBX OPFS import chokepoints + the cross-format extension dispatcher —
// Phase 7.14 Wave A (issue #111).
//
// The BVH and FBX importers (`buildBvhImportOps` / `buildFbxImportOps`) emit a Skeleton and its
// motion as keys on a base pose layer (#1211). #1429 — an FBX may also bring meshes, which stand
// with the skeleton (`motionImportOps`); such a file is a character and is not bound onto another
// (`landImportedMotion`). #1434 — an FBX with no bone is a model: its meshes and empties, with no
// skeleton and nothing to bind. #1451 — every import stands where Blender's does, with no wrapper,
// linked into the active collection. A BVH is motion only. Until now they were reachable
// only through the `__basher_importBvh` / `__basher_importFbx` dev seams
// (boot.ts:240-255). This module is the missing INGESTION SURFACE: read the
// OPFS bytes a drop/picker wrote, decode them per-format, build the op chain,
// dispatch atomically (K6), and bump the My-Imports refresh signal.
//
// Asymmetry vs glTF (grounded, CONTEXT D-03): glTF persists an `assetRef` on
// its GltfAsset node; BVH/FBX leave NO persistent reference (they dispatch
// a Skeleton and its layer, and nothing holds the OPFS path afterwards). So a
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

import type { DagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import type { Op } from '../../core/dag/types';
import { buildBvhImportOps } from '../../core/import/bvhImportChain';
import { buildFbxImportOps } from '../../core/import/fbxImportChain';
import { buildSkeletonObjectOps, skeletonObjectId } from '../../core/import/skeletonObject';
import { activeCollectionOf, intoActiveCollection } from '../collections';
import type { FbxImportChainResult } from '../../core/import/fbxImportChain';
import type { BoneSpec } from '../../nodes/types';
import { getStorage } from '../boot';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { useSelectionStore } from '../stores/selectionStore';
import { importGltfFromOpfs, leftBehindNotice, storeImageInOpenProject } from './importGltf';
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
export type MotionImportResult =
  | (BindableMotion & {
      /**
       * #1434 — a MOTION is a rig alone, and a landing binds it onto a character. A CHARACTER is a
       * rig with meshes or empties beside it: it is not bound onto another, which would hide it.
       */
      readonly kind: 'motion' | 'character';
      /** #1451 — the collection the import linked its objects into, or null for the scene itself. */
      readonly collectionId: string | null;
      /** #1429 — how many meshes the file brought with its skeleton. */
      readonly meshCount: number;
    })
  | {
      /** #1434 — an FBX with no bone: no skeleton, no motion, nothing to bind. */
      readonly kind: 'model';
      /** #1451 — the collection the import linked its objects into, or null for the scene itself. */
      readonly collectionId: string | null;
      readonly meshCount: number;
    };

/** What a bind takes: a skeleton and the node its motion comes out of. */
export interface BindableMotion {
  readonly skeletonId: string;
  /** #1211 — the node the motion comes out of: what a bind retargets from. */
  readonly motionId: string;
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
 * A bound motion does not leave a second rig standing beside its character: the bind that
 * follows hides this Object in its own op batch (`mutator.animation.retarget`), so undoing
 * the bind brings it back. It lands in the import's single dispatch (K6). A project with no
 * scene aggregator has nowhere to stand one, and gets the import alone.
 *
 * SCALE — the Object stands at 1, for both formats, and neither is guessed. BVH declares no unit,
 * so the rig stands at the file's own size and its Scale is the director's to set (#791) — as
 * Blender's BVH importer does, with a Scale defaulted to 1.0 and no detection code
 * (`io_anim_bvh/__init__.py:60-66`); the import selects the Object so that field is in front of
 * them (`landImportedMotion`). FBX declares its unit, and `readFbx` has already read the rig in
 * it (`fbxMetresPerUnit`, #1086). What used to stand here — a fit to 1.8 m measured on the
 * rig's frame 0 — was right for a person and silently wrong for anything else.
 */
function skeletonObjectOps(
  ops: readonly Op[],
  skeletonId: string,
  // The base pose layer the file's keys land on (#1211), whose `out` poses the Object.
  layerId: string,
  // #1101 — the name the import gave the motion, so the Object and its motion read the same.
  name: string,
  // The scene node the Object stands under.
  parentId: string,
): Op[] {
  const skeleton = ops.find((op) => op.type === 'addNode' && op.nodeId === skeletonId);
  const params = skeleton?.type === 'addNode' ? skeleton.params : undefined;
  const bones = (params as { bones?: BoneSpec[] } | undefined)?.bones ?? [];
  if (bones.length === 0) return [];
  // Blender names the armature after the file and never renames it after the action, so the name
  // follows nothing.
  return buildSkeletonObjectOps({
    skeletonId,
    sceneNodeId: parentId,
    name,
    pose: { node: layerId, socket: 'out' },
    nameFollowsClip: false,
  }).ops;
}

/** A motion import's ops, built and not yet dispatched (#1307). */
export type MotionImportOps = MotionImportResult & {
  readonly ops: Op[];
  /** #1429 — what the file held that the import left out, each said once. Empty when nothing. */
  readonly notices: readonly string[];
};

/**
 * #1307 — the ops a `.bvh` or `.fbx` import makes, against a CALLER-SUPPLIED state, without
 * dispatching: a Skeleton, the file's keys on a base pose layer (#1211) and the Object that
 * stands it (#1056). Two callers, one chain — the drop/picker/Library import below dispatches
 * them against the live store, and the agent's `library.import` returns them for its Diff (V7).
 * Before this the agent had no motion road at all and minted a glTF node reading the file.
 *
 * BVH is TEXT and is decoded before parsing; FBX is BINARY and is handed over as a fresh,
 * non-shared ArrayBuffer (the OPFS read may back a SharedArrayBuffer — the same detach as the
 * glTF road). Throws when the file cannot be read or parsed; each caller reports that its way.
 */
export async function buildMotionImportOpsFromOpfs(
  path: string,
  state: DagState,
): Promise<MotionImportOps> {
  const ext = importFormatOf(path)?.ext;
  if (ext !== '.bvh' && ext !== '.fbx') throw new Error(`${path} is not a motion file`);
  const storage = await getStorage();
  const bytes = await storage.read(path);
  const name = nameFromPath(path);
  if (ext === '.bvh') {
    return motionImportOps(
      { ...buildBvhImportOps({ text: new TextDecoder().decode(bytes), name }), kind: 'motion' },
      name,
      state,
    );
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return motionImportOps(
    await buildFbxImportOps({ data: copy.buffer, name, storeImage: storeImageInOpenProject }),
    name,
    state,
  );
}

/** A BVH's built import: a motion, and nothing of a scene. */
interface BuiltBvh {
  readonly kind: 'motion';
  readonly ops: Op[];
  readonly skeletonId: string;
  readonly motionId: string;
}

/**
 * #1429 — a built motion import with what stands it in the scene: the skeleton's Object, then (an
 * FBX's) meshes and empties, which may hang under that Object and so go after it. Every FBX door
 * takes this, the dev seam included, so no door imports the rig and drops the meshes.
 *
 * #1451 — where Blender puts an import (`io_scene_fbx/import_fbx.py:2777` and `:2921`,
 * `io_anim_bvh/import_bvh.py:350` and `:424`): every object the file makes stands in the scene where
 * the file hangs it, with no wrapper, and is linked into the ACTIVE COLLECTION
 * (`intoActiveCollection`) — membership, never a transform. By what the file is (#1434,
 * `FbxImportKind`): a MOTION stands its rig and is bound by its landing (the bind hides the rig); a
 * CHARACTER stands rig, meshes and empties; a MODEL its meshes and empties, with no rig at all. A BVH
 * is a motion.
 */
export function motionImportOps(
  built: BuiltBvh | FbxImportChainResult,
  name: string,
  state: DagState,
): MotionImportOps {
  const sceneNodeId = state.outputs.scene?.node;
  const meshCount = 'meshCount' in built ? built.meshCount : 0;
  const notices = 'notices' in built ? built.notices : [];
  const fbx = 'meshOps' in built ? built : null;
  const collectionId = activeCollectionOf(state);
  const leftOut = (n: number) =>
    n > 0
      ? [`${n} mesh${n === 1 ? '' : 'es'} left out: the project has no scene to stand them in`]
      : [];
  if (built.kind === 'model') {
    // With no scene to stand in, nothing of the file has anywhere to go.
    const placed = sceneNodeId !== undefined;
    return {
      kind: 'model',
      collectionId,
      ops: placed ? intoActiveCollection(state, [...built.ops, ...built.meshOps(sceneNodeId)]) : [],
      meshCount: placed ? meshCount : 0,
      notices: [...notices, ...(placed ? [] : leftOut(meshCount))],
    };
  }
  const { ops, skeletonId, motionId } = built;
  const standing =
    sceneNodeId === undefined
      ? []
      : skeletonObjectOps(ops, skeletonId, motionId, name, sceneNodeId);
  // With no scene to stand in, the skeleton has no Object either, and the meshes nowhere to go.
  const placed = sceneNodeId !== undefined && standing.length > 0;
  return {
    kind: built.kind,
    collectionId,
    ops: intoActiveCollection(state, [
      ...ops,
      ...standing,
      ...(placed && fbx !== null ? fbx.meshOps(sceneNodeId) : []),
    ]),
    skeletonId,
    motionId,
    meshCount: placed ? meshCount : 0,
    notices: [...notices, ...(placed ? [] : leftOut(meshCount))],
  };
}

/**
 * Import a `.bvh` or `.fbx` from OPFS into the live project, as one undo step (K6).
 *
 * A wrong decode or a TimeSource-less project throws inside the builder; the catch routes it
 * to assetErrorStore so the failure is visible, not swallowed.
 */
async function importMotionFromOpfs(path: string): Promise<MotionImportResult | null> {
  try {
    const dag = useDagStore.getState();
    const { ops, notices, ...imported } = await buildMotionImportOpsFromOpfs(path, dag.state);
    dag.dispatchAtomic(ops, 'user', `import ${importFormatOf(path)!.ext.slice(1)}: ${path}`);
    // Bump AFTER dispatch (pre-mortem: a pre-dispatch bump re-enumerates the
    // My-Imports list before the import lands → stale/empty on failure).
    useImportRefreshStore.getState().bump();
    // #1429 — said where the glTF road says its own (`importGltf.ts`).
    if (notices.length > 0) console.warn(`FBX import (${path}):${leftBehindNotice(notices)}`);
    return imported;
  } catch (err) {
    useAssetErrorStore.getState().report(path, `import failed: ${formatAssetError(err)}`);
    // `null` means "nothing landed", and the banner is already showing why. It is
    // NOT an empty success — a caller that went on to bind would find no motion.
    return null;
  }
}

/** Read a `.bvh` from OPFS and import it (`buildMotionImportOpsFromOpfs`). */
export async function importBvhFromOpfs(path: string): Promise<MotionImportResult | null> {
  return importMotionFromOpfs(path);
}

/** Read a `.fbx` from OPFS and import it (`buildMotionImportOpsFromOpfs`). */
export async function importFbxFromOpfs(path: string): Promise<MotionImportResult | null> {
  return importMotionFromOpfs(path);
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
    landImportedMotion(await importBvhFromOpfs(entryPath));
  },
  '.fbx': async (entryPath) => {
    landImportedMotion(await importFbxFromOpfs(entryPath));
  },
};

/**
 * #791 — bind a dropped motion, and when nothing takes it, select the Object that stands it.
 *
 * Blender's importers end by selecting what they made and making it active
 * (`io_anim_bvh/import_bvh.py:425-426`; FBX `import_fbx.py:2908-2913`), which is how the
 * import dialog's Scale reaches the director a second time: the result is in the properties
 * panel the moment it lands. A drop has no dialog, so the selection is the whole of that road
 * — a BVH lands at file scale, and its Object's Scale is the field that fixes it.
 *
 * The bind goes FIRST because it reads the selection to choose a character
 * (`chooseMotionTarget`). Selecting beforehand would retarget the choice onto the motion's
 * own rig. A bind that takes hides the Object, and a hidden Object is not what a director
 * wants selected; the selection is then left where the bind found it.
 */
function landImportedMotion(imported: MotionImportResult | null): void {
  // #1434 — a model has no rig to bind or to select: it stands where it landed, as a glTF's does
  // (selection after an import is #1442's, for both formats).
  if (!imported || imported.kind === 'model') return;
  // #1429 — a file that brought its own meshes or empties is a character: it stands where it landed.
  const outcome = imported.kind === 'character' ? null : bindImportedMotion(imported, 'imported');
  if (outcome?.ok) return;
  const objectId = skeletonObjectId(imported.skeletonId);
  if (!useDagStore.getState().state.nodes[objectId]) return;
  useSelectionStore.getState().select(objectId);
}

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
  imported: BindableMotion | null,
  arrival: MotionArrival,
): BindMotionOutcome | null {
  if (!imported) return null;
  return bindMotionToCharacter(imported, arrival);
}
