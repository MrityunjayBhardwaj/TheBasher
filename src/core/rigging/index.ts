// rigging — giving a mesh a skeleton.
//
// The public face of the module. Nothing outside `src/core/rigging/` decides
// which implementation it holds; callers take a `RiggingCapability`.
//
// REF: ref/architecture/ai-track.md phase A4; issue #795.

import { StubRiggingCapability } from './StubRiggingCapability';
import {
  TripoModelGenerationCapability,
  tripoFallbackOf,
  type TripoFallback,
} from '../modelgen/TripoModelGenerationCapability';
import type { TripoApiVersion } from '../modelgen/tripoDialect';
import type { RiggingCapability } from './RiggingCapability';

/**
 * Choose an implementation. Mirrors `pickModelGeneration` — reach for the real
 * service, fall back to the stub, never make the caller decide.
 *
 * It returns the Tripo class because that one service does generation and rigging
 * behind one key, and duplicating the transport to keep the modules visually
 * separate would be tidiness bought with a second thing to keep in step. The
 * seam that matters is the TYPE: this returns `RiggingCapability`, so the day a
 * rigging-only backend lands it plugs in here and no caller changes.
 */
export async function pickRigging(
  apiKey: string | undefined,
  opts: {
    readonly baseUrl?: string;
    readonly fetchImpl?: typeof fetch;
    readonly apiVersion?: TripoApiVersion;
  } = {},
  onFallback?: (fallback: TripoFallback) => void,
): Promise<RiggingCapability> {
  if (!apiKey?.trim()) return new StubRiggingCapability();
  const tripo = new TripoModelGenerationCapability({ apiKey: apiKey.trim(), ...opts });
  const probe = await tripo.probe();
  if (probe.ok) return tripo;
  // 🔑 THE SAME ANNOUNCEMENT `pickModelGeneration` MAKES, AND FOR A SHARPER
  // REASON. `StubRiggingCapability` returns a real skinned GLB with real bone
  // names, so a stub rig imports, binds, and animates — a retarget onto it
  // succeeds. A silent fall-through here does not produce a visibly wrong
  // result; it produces a plausible one, which is worse.
  //
  // This has no app surface yet. It is fixed now rather than when one lands,
  // because the defect is already written and a wiring commit is exactly the
  // change that would not think to look for it.
  onFallback?.(tripoFallbackOf(probe));
  return new StubRiggingCapability();
}

export {
  DEFAULT_RIG_SPEC,
  RIG_SPECS,
  RIG_TYPES,
  RigRequestInvalidError,
  RigRequestSchema,
  assertValidRigRequest,
  classifyRigSpec,
  missingForRetarget,
  mixamoBonesRequiredForRetarget,
  type RigProgress,
  type RigRequest,
  type RigResult,
  type RigSpec,
  type RigSpecClassification,
  type RigSubject,
  type RigType,
  type RiggableCheck,
  type RiggingCapability,
} from './RiggingCapability';
export {
  StubRiggingCapability,
  synthesiseRiggedGlb,
  STUB_RIG_BONES,
} from './StubRiggingCapability';
