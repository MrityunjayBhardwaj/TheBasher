// THE IMPORTER CATEGORY — the four importable formats, written down once (#662).
//
// Before this module the four-format set was respelled by hand at NINE sites and none of
// them routed through the dispatcher, so "add a format" meant "find every place that spells
// the set". Six of the nine failed SILENTLY when a format was missed: a library drop built a
// static chain for a format that needed a real importer and landed it in undo history as a
// success; an ingested asset never appeared in My Imports, so the user concluded the import
// had failed; the agent road reported `Imported …` having built the wrong chain; and
// `importRefs` never offered a break-refs prompt for the new format, which is silent DATA
// LOSS discovered at the next load.
//
// ── WHY THIS IS DATA AND NOT A REGISTRY OF FUNCTIONS ──────────────────────────────────
//
// The obvious shape is `IMPORTERS: Record<ext, (path) => Promise<void>>`. It cannot live
// here: this module would have to import `importGltf` and `importBvhFbx`, and
// `importBvhFbx` needs the category to dispatch — a new module cycle, in a repo that
// enumerates the cycles it allows (`importCycles.gate.test.ts`, #814) precisely so a new one
// is a decision rather than an accident.
//
// So the category is PURE DATA with no import of any importer, and the ext→importer map
// stays in `importBvhFbx.ts` where the importers already are, typed
// `Record<ImportExt, …>` so a format added to `IMPORT_EXTENSIONS` and forgotten in the
// dispatch is a COMPILE error rather than a silent fall-through to "unsupported format".
// That is the unrepresentability ladder's type rung: the gap is not caught, it is
// unwritable.
//
// ── THE TWO ORDERS ARE DIFFERENT, AND BOTH ARE LOAD-BEARING ───────────────────────────
//
// `IMPORT_EXTENSIONS` is DECLARATION order and drives the file-dialog `accept` attribute
// (`.gltf,.glb,.bvh,.fbx`). `entryPriority` is a SEPARATE field because the My-Imports
// entry pick runs `.glb` BEFORE `.gltf` — a container priority, not a declaration one. A
// category that derived one order from the other would silently change which file a
// mixed folder lists. They are two facts and they are stored as two facts.
//
// REF: issue #662; CONTEXT D-03 (the persistent-reference asymmetry), D-04 (one affordance
//      accepts all four formats), D-05 (BVH/FBX list in My Imports like glTF);
//      `importCycles.gate.test.ts` (#814, why this module imports nothing);
//      `importFormats.gate.test.ts` (the gate that reds when a site forgets a format).

/**
 * The importable extensions, in the order the file-dialog `accept` attribute lists them.
 *
 * Adding one here without giving it an `IMPORT_FORMATS` entry does not typecheck, and
 * without giving it a dispatch arm in `importBvhFbx.ts` does not typecheck either.
 */
export const IMPORT_EXTENSIONS = ['.gltf', '.glb', '.bvh', '.fbx'] as const;

/** One of the four importable extensions, lowercased and dot-prefixed. */
export type ImportExt = (typeof IMPORT_EXTENSIONS)[number];

/**
 * What the format produces, which is the fact six of the nine sites actually branch on.
 *
 * `model` = geometry that lands as a `GltfAsset` chain and may arrive as a folder of
 * siblings. `motion` = a Skeleton + AnimationClip pair from one self-contained file.
 * FBX is `motion` in Basher despite being a model format elsewhere: the importer takes the
 * skeleton and the clip and explicitly defers mesh import (`src/core/import/fbx.ts:11`).
 */
export type ImportFamily = 'model' | 'motion';

/** Everything the nine sites need to know about one format. */
export interface ImportFormat {
  readonly ext: ImportExt;
  readonly family: ImportFamily;
  /**
   * Which file a My-Imports directory listing surfaces when it holds several. Lower wins.
   * `.glb` beats `.gltf` because a self-contained container is the better entry when both
   * are present (D-05).
   */
  readonly entryPriority: number;
  /**
   * The node type that holds a persistent OPFS reference to this import, or `null` when the
   * format leaves none.
   *
   * This is the CONTEXT D-03 asymmetry, and until now it was documented in prose and
   * enforced nowhere. A motion import dispatches a Skeleton + AnimationClip and nothing
   * retains the path, so its rename is a folder move and its delete needs no break-refs
   * prompt. A model import persists `params.assetRef` on its `GltfAsset`, so both operations
   * have to rewrite or offer to break it.
   */
  readonly persistsRefAs: string | null;
}

/**
 * The category. Keyed by extension so a missing entry is a compile error rather than an
 * array someone has to remember to extend.
 */
export const IMPORT_FORMATS: Readonly<Record<ImportExt, ImportFormat>> = {
  '.gltf': { ext: '.gltf', family: 'model', entryPriority: 1, persistsRefAs: 'GltfAsset' },
  '.glb': { ext: '.glb', family: 'model', entryPriority: 0, persistsRefAs: 'GltfAsset' },
  '.bvh': { ext: '.bvh', family: 'motion', entryPriority: 2, persistsRefAs: null },
  '.fbx': { ext: '.fbx', family: 'motion', entryPriority: 3, persistsRefAs: null },
};

/** The `accept` attribute for a picker that takes any importable format. */
export const IMPORT_ACCEPT = IMPORT_EXTENSIONS.join(',');

/** The `accept` attribute for a picker that takes models only (the glTF file picker). */
export const MODEL_ACCEPT = IMPORT_EXTENSIONS.filter(
  (e) => IMPORT_FORMATS[e].family === 'model',
).join(',');

/**
 * The message an unrecognised extension reports. Derived, so a fifth format widens the
 * hint the user sees without anyone editing the string.
 */
export const UNSUPPORTED_FORMAT_MESSAGE = `import failed: unsupported format (expected ${IMPORT_EXTENSIONS.join('/')})`;

/** The node types that persist a reference to their import — the break-refs scan's subjects. */
export const REF_PERSISTING_NODE_TYPES: ReadonlySet<string> = new Set(
  IMPORT_EXTENSIONS.map((e) => IMPORT_FORMATS[e].persistsRefAs).filter(
    (t): t is string => t !== null,
  ),
);

/** The format a path names, or `null` when the extension is not importable. */
export function importFormatOf(path: string): ImportFormat | null {
  const lower = path.toLowerCase();
  for (const ext of IMPORT_EXTENSIONS) {
    if (lower.endsWith(ext)) return IMPORT_FORMATS[ext];
  }
  return null;
}

/** True iff the path names an importable format (any family). */
export function isImportablePath(path: string): boolean {
  return importFormatOf(path) !== null;
}

/** True iff the path names a format of the given family. */
export function isFamilyPath(path: string, family: ImportFamily): boolean {
  return importFormatOf(path)?.family === family;
}

/**
 * Pick the entry file from a directory listing, by `entryPriority`. Returns the matched
 * filename, or `null` when the listing holds no importable entry.
 */
export function pickEntryFile(files: readonly string[]): string | null {
  const byPriority = [...IMPORT_EXTENSIONS].sort(
    (a, b) => IMPORT_FORMATS[a].entryPriority - IMPORT_FORMATS[b].entryPriority,
  );
  for (const ext of byPriority) {
    const hit = files.find((f) => f.toLowerCase().endsWith(ext));
    if (hit !== undefined) return hit;
  }
  return null;
}
