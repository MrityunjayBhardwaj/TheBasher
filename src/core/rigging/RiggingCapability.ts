// RiggingCapability — the boundary between Basher and a service that gives a
// mesh a skeleton.
//
// SEPARATE FROM ModelGenerationCapability ON PURPOSE, and the reason is a named
// successor rather than tidiness. Tripo happens to do generation and rigging
// behind one API key, so folding rigging into the generation capability would
// work today. But UniRig is already recorded in this repo's licence manifest as a
// rigging backend, and it does not generate anything — a mesh goes in, a skeleton
// comes out. A capability whose implementations must all also be text-to-3D
// services cannot express that. Splitting now costs one interface; splitting after
// a second backend exists costs every call site.
//
// The same reasoning the other way: `import_model` means a mesh that Basher did
// not generate can be rigged too, so rigging is not downstream of generation even
// for Tripo. It is its own thing that generation happens to feed.
//
// 🔑 THE ROAD THIS OPENS. Rigging with `spec: mixamo` produces a skeleton Basher
// ALREADY speaks end to end — the importer, the bone-name maps and `retargetClip`
// all handle a Mixamo rig today, and a generated SOMA motion clip retargets onto
// Mixamo names through the `somaToMixamo` preset. So:
//
//     text-to-3D  →  rig (mixamo)  →  a Mixamo-named skeleton
//                                              ↑
//     text-to-motion  →  BVH  →  retargetClip(somaToMixamo)
//
// Both ends already exist; this is the middle. Note that TRIPO'S OWN RETARGET IS
// NOT ON THIS PATH: `animate_retarget` accepts only its `Animation` enum — sixteen
// canned presets — and no endpoint in its API accepts an uploaded motion file
// (measured across the SDK source). Driving a rigged mesh with OUR generated
// motion goes through Basher's retarget, not the service's.
//
// REF: ref/sources/tripo-python-sdk/tripo3d/client.py:1126 (check_riggable),
//      :1156 (rig_model), models.py:60-72 (RigType, RigSpec, TaskOutput.riggable);
//      src/core/import/boneNameMaps.ts (`somaToMixamo`); issue #795.

import { z } from 'zod';

/**
 * The skeletons a service can be ASKED for.
 *
 * `mixamo` is the one that matters here — it is the vocabulary Basher's existing
 * retarget targets. `tripo` is the service's own convention and is carried
 * because it is the API's default, not because anything downstream wants it.
 *
 * REF: tripo3d/models.py:60-62.
 */
export type RigSpec = 'mixamo' | 'tripo';
export const RIG_SPECS: readonly RigSpec[] = ['mixamo', 'tripo'];

/** The body plans a rig can be built for. REF: tripo3d/models.py:50-58. */
export type RigType =
  | 'biped'
  | 'quadruped'
  | 'hexapod'
  | 'octopod'
  | 'avian'
  | 'serpentine'
  | 'aquatic'
  | 'others';
export const RIG_TYPES: readonly RigType[] = [
  'biped',
  'quadruped',
  'hexapod',
  'octopod',
  'avian',
  'serpentine',
  'aquatic',
  'others',
];

/**
 * A mesh the service can address. An opaque handle rather than bytes, because
 * that is what the contract actually is: every rig call takes an
 * `original_model_task_id` and the service already holds the geometry. A mesh
 * Basher generated arrives with one; a mesh it did not must be uploaded first.
 */
export interface RigSubject {
  readonly sourceTaskId: string;
}

/** What a pre-check answers, and it answers two things, not one. */
export interface RiggableCheck {
  readonly taskId: string;
  /** Whether the service will attempt a rig at all. REF: TaskOutput.riggable. */
  readonly riggable: boolean;
  /**
   * The body plan the service RECOGNISED, when it says. `null` means it did not
   * answer — which is not the same as `others`, and collapsing the two would turn
   * "I could not tell" into a positive claim about a quadruped.
   */
  readonly detectedRigType: RigType | null;
}

export interface RigRequest extends RigSubject {
  /** Defaults to the service's own default (`biped`) when omitted. */
  readonly rigType?: RigType;
  /** Defaults to `mixamo` HERE, which is not the service's default — see below. */
  readonly spec?: RigSpec;
  /**
   * The AUTO-RIGGING model version — a different menu from the generation
   * model's, and one the service does not usefully default.
   *
   * Left unset, the transport supplies a version it knows is valid. That is not
   * belt-and-braces: a live rig call omitting it was refused with
   * `invalid model 'v2.5-20250123'` — a version the request never mentioned, so
   * the service's own default is outside its own allowed set.
   */
  readonly modelVersion?: string;
}

export interface RigResult {
  readonly taskId: string;
  /** GLB bytes, carrying the mesh and its skin — the same payload a dropped
   *  rigged .glb carries, so it takes the identical import road. */
  readonly glb: ArrayBuffer;
  /**
   * The spec that was REQUESTED. Deliberately not called `spec`, and deliberately
   * not presented as what arrived: which skeleton actually came back is a property
   * of the GLB, which states its own bone names. Read it with
   * `classifyRigSpec(boneNames)` rather than trusting this field — a result that
   * reported the skeleton it *asked* for would be a label, and a label can be
   * wrong while every test that reads it passes.
   */
  readonly requestedSpec: RigSpec;
}

/**
 * Basher's default rig spec, which is NOT the service's.
 *
 * `rig_model` defaults to `spec: tripo`. We default to `mixamo`, because that is
 * the only one of the two that anything downstream can already drive: a generated
 * motion clip retargets onto Mixamo names through an existing preset, and a Tripo
 * skeleton has no map at all. A default that produces an unusable rig is a worse
 * default than one that disagrees with upstream.
 */
export const DEFAULT_RIG_SPEC: RigSpec = 'mixamo';

export interface RiggingCapability {
  readonly id: string;
  readonly kind: 'http' | 'stub';

  isAvailable(): Promise<boolean>;

  /**
   * Ask whether a mesh can be rigged, before spending a rig on it.
   *
   * Worth its own call rather than letting `rig` fail: a rig is billable and slow,
   * and "this mesh is not riggable" is a fact a director should get in seconds
   * with a reason, not minutes with a task failure.
   */
  checkRiggable(subject: RigSubject): Promise<RiggableCheck>;

  /** Rig a mesh. Throws on transport failure, timeout, an invalid request, or a
   *  licence refusal — which must land BEFORE anything leaves the process. */
  rig(request: RigRequest, onProgress?: (p: RigProgress) => void): Promise<RigResult>;

  cancel(taskId: string): Promise<void>;
}

/** Coarse progress, mirroring the generation capability's. */
export interface RigProgress {
  readonly taskId: string;
  readonly status: string;
  readonly progress: number;
}

export const RigRequestSchema = z
  .object({
    sourceTaskId: z.string().trim().min(1, 'must not be empty'),
    rigType: z.enum(RIG_TYPES as [RigType, ...RigType[]]).optional(),
    spec: z.enum(RIG_SPECS as [RigSpec, ...RigSpec[]]).optional(),
    // Not an enum: the valid set is the service's to state and it has changed
    // once already. A closed list here would refuse a version the service added.
    modelVersion: z.string().trim().min(1).optional(),
  })
  .strict();

/** Thrown when a rig request is malformed. Names the field, never clamps. */
export class RigRequestInvalidError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Rig request is invalid — ${issues.join('; ')}.`);
    this.name = 'RigRequestInvalidError';
    this.issues = issues;
  }
}

export function assertValidRigRequest(request: RigRequest): void {
  const parsed = RigRequestSchema.safeParse(request);
  if (parsed.success) return;
  throw new RigRequestInvalidError(
    parsed.error.issues.map((i) => `${i.path.join('.') || '<request>'}: ${i.message}`),
  );
}

/**
 * The bones a skeleton must carry to be drivable as a Mixamo rig HERE.
 *
 * Not "every bone Mixamo defines" — the test is whether Basher's existing
 * retarget can hit it, so the set is derived from the `somaToMixamo` preset's own
 * targets at module load. That coupling is the point: if the preset gains a bone,
 * this set gains it too, and a stub that stopped satisfying it goes red rather
 * than drifting. Hand-listing the names would let the two disagree silently,
 * which is the exact failure this module exists downstream of.
 */
export function mixamoBonesRequiredForRetarget(
  presetTargets: readonly string[],
): readonly string[] {
  return [...new Set(presetTargets)].sort();
}

export type RigSpecClassification = RigSpec | 'unknown';

/**
 * Which skeleton a GLB actually carries, read from its bone names.
 *
 * This is the reader that keeps `requestedSpec` from being a lying label. A
 * service that accepted `spec: mixamo` and returned its own convention would
 * otherwise be invisible: the request succeeded, the field says `mixamo`, and the
 * retarget silently binds nothing.
 *
 * `mixamo` is decided by the `mixamorig` prefix, which is the naming Adobe emits
 * and which this repo already sanitises `:` out of. Anything else with bones is
 * reported as `tripo` only when it is NOT Mixamo and the caller asked for tripo —
 * so the function never guesses a positive identity it cannot see. A skeleton with
 * no bones at all is `unknown`, never a spec.
 */
export function classifyRigSpec(boneNames: readonly string[]): RigSpecClassification {
  if (boneNames.length === 0) return 'unknown';
  const mixamo = boneNames.filter((n) => n.toLowerCase().startsWith('mixamorig')).length;
  // A majority rather than "any", so one stray bone named after the convention
  // cannot make a foreign skeleton read as Mixamo.
  if (mixamo * 2 > boneNames.length) return 'mixamo';
  return 'unknown';
}

/**
 * Whether a skeleton carries everything `retargetClip` needs to drive it with a
 * generated motion clip. Returns the MISSING names, so a failure says what to fix
 * rather than just that something is wrong.
 */
export function missingForRetarget(
  boneNames: readonly string[],
  required: readonly string[],
): readonly string[] {
  const have = new Set(boneNames);
  return required.filter((n) => !have.has(n));
}
