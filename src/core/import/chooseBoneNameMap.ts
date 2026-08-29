// Choose the bone-name map that bridges a motion clip's rig to a character's
// rig, by MEASURING both name sets against every registered candidate (#807).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS IS DERIVED AND NOT SPELLED
// ─────────────────────────────────────────────────────────────────────────
// `mutator.animation.retarget` takes a `mapPresetId` and therefore requires its
// caller to already know which of the six presets is right. A director dropping
// a file knows nothing of the sort, and the honest answer is not a default — it
// is a reading. Both name sets are in hand at the moment of the drop, so the
// choice is a countable fact: how many of the clip's bones does this map land on
// a bone the character actually has?
//
// Spelling the pair instead ("a dropped BVH is SOMA, a character is Mixamo, use
// somaToMixamo") would be correct today and wrong the first time either end
// changes, and it would be wrong SILENTLY — a map that lands on nothing still
// retargets, still emits a clip, and still produces a character that does not
// move. Deriving it means a newly registered preset becomes reachable by the act
// of registering it, which is the discipline `retarget.ts`'s own description
// already uses for the list it advertises.
//
// ─────────────────────────────────────────────────────────────────────────
// IDENTITY IS A CANDIDATE, AND IT IS NOT A DEGENERATE ONE
// ─────────────────────────────────────────────────────────────────────────
// No preset maps `mixamorig_*` onto `mixamorig_*`, because until now nothing
// needed to: the presets exist to cross vocabularies. But a Mixamo `.fbx` dropped
// onto a service-rigged character is exactly that case — both sides speak
// `mixamorig_`, every preset scores zero, and a preset-only chooser would refuse
// a pair that needs no translation at all. So the shared-name map is scored
// alongside the presets and wins ties, since matching names are evidence of one
// convention rather than of a lucky bridge.
//
// REF: src/core/import/boneNameMaps.ts (the candidates);
//      src/agent/mutators/builders/retarget.ts (the consumer of the choice);
//      src/app/asset/bindMotionToCharacter.ts (the caller); issue #807.

import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';

export interface BoneNameMapChoice {
  /** A registered preset id, or `null` when the shared-name map won. */
  readonly presetId: string | null;
  /** The explicit map, present only for the identity case. */
  readonly customMap: Readonly<Record<string, string>> | null;
  /** How many DISTINCT source bone names land on a bone the target carries. */
  readonly mapped: number;
  /** How many distinct source bone names there were to place. */
  readonly total: number;
  /** Human-facing name for the chosen bridge, for the message a refusal cannot give. */
  readonly label: string;
}

/**
 * Score one candidate map: the number of distinct SOURCE names it sends to a name
 * the TARGET actually carries.
 *
 * Both conditions matter and only one of them is obvious. A map entry whose key
 * the source lacks contributes nothing because that bone is never keyframed; a
 * map entry whose VALUE the target lacks contributes nothing because the retarget
 * has no bone to write. Counting entries in the map — the tempting cheap version
 * — measures the map's size and not its fit, and would rank a large irrelevant
 * preset above a small exact one.
 */
function scoreMap(
  map: Readonly<Record<string, string>>,
  sourceNames: ReadonlySet<string>,
  targetNames: ReadonlySet<string>,
): number {
  let hits = 0;
  for (const name of sourceNames) {
    const mapped = map[name];
    if (mapped !== undefined && targetNames.has(mapped)) hits += 1;
  }
  return hits;
}

/** The shared-name map: every source name the target also carries, sent to itself. */
function identityMap(
  sourceNames: ReadonlySet<string>,
  targetNames: ReadonlySet<string>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const name of sourceNames) {
    if (targetNames.has(name)) map[name] = name;
  }
  return map;
}

/**
 * Pick the map that places the most of `sourceBoneNames` onto `targetBoneNames`.
 *
 * Returns `null` when nothing lands anything — which is a real answer and not a
 * failure to decide. Two rigs with no shared vocabulary and no bridging preset
 * cannot be retargeted, and saying so is strictly better than picking the
 * least-bad map and producing a character that moves one finger.
 *
 * Deterministic (V22): candidates are scored in a fixed order — identity first,
 * then `BONE_NAME_MAP_PRESETS` in registration order — and ties keep the earlier
 * candidate, so the same two rigs always choose the same bridge.
 */
export function chooseBoneNameMap(
  sourceBoneNames: readonly string[],
  targetBoneNames: readonly string[],
): BoneNameMapChoice | null {
  const sourceNames = new Set(sourceBoneNames.filter((n) => n.length > 0));
  const targetNames = new Set(targetBoneNames.filter((n) => n.length > 0));
  const total = sourceNames.size;
  if (total === 0 || targetNames.size === 0) return null;

  // Identity first, so a tie resolves to "these rigs share a convention" rather
  // than to "a preset happened to bridge the same number of bones".
  const shared = identityMap(sourceNames, targetNames);
  let best: BoneNameMapChoice | null = null;
  const sharedScore = Object.keys(shared).length;
  if (sharedScore > 0) {
    best = {
      presetId: null,
      customMap: shared,
      mapped: sharedScore,
      total,
      label: 'matching bone names',
    };
  }

  for (const preset of BONE_NAME_MAP_PRESETS) {
    const score = scoreMap(preset.map, sourceNames, targetNames);
    // Strictly greater — an equal score leaves the earlier candidate standing.
    if (score > 0 && (best === null || score > best.mapped)) {
      best = {
        presetId: preset.id,
        customMap: null,
        mapped: score,
        total,
        label: preset.name,
      };
    }
  }

  return best;
}
