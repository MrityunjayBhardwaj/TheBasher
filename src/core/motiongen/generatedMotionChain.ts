// Generated motion → Op chain.
//
// This file is deliberately thin, and its thinness is the claim. A generated clip
// enters by calling `buildBvhImportOps` — the same function an imported .bvh
// calls, with the same arguments — so there is no second import road to keep in
// step, and nothing downstream can branch on how the motion arrived.
//
// If this file ever grows a code path that an import does not also take, that is
// the provenance branch phase A1 exists to avoid, and it should be deleted rather
// than maintained.
//
// REF: src/core/import/bvhImportChain.ts; ref/architecture/ai-track.md phase A1.

import { buildBvhImportOps, type BvhImportChainResult } from '../import/bvhImportChain';
import type { DagState } from '../dag/state';
import type {
  MotionGenerationCapability,
  MotionGenerationRequest,
} from './MotionGenerationCapability';

export interface GeneratedMotionArgs {
  readonly request: MotionGenerationRequest;
  readonly name?: string;
  readonly ids?: { skeleton: string; clip: string };
  readonly timeSourceId?: string;
}

export interface GeneratedMotionResult extends BvhImportChainResult {
  /** Echoed so a caller can record which checkpoint produced the clip. */
  readonly model: string;
  readonly jobId: string;
}

/**
 * Generate a clip and return the Ops that add it to the graph. The caller
 * dispatches them atomically, exactly as it would for an import, so the whole
 * thing lands as one undo entry.
 */
export async function buildGeneratedMotionOps(
  capability: MotionGenerationCapability,
  args: GeneratedMotionArgs,
  state: DagState,
): Promise<GeneratedMotionResult> {
  const generated = await capability.generate(args.request);
  const chain = buildBvhImportOps(
    {
      text: generated.bvh,
      name: args.name ?? args.request.prompt,
      ids: args.ids,
      timeSourceId: args.timeSourceId,
      // The one thing the generator knows that the clip does not say. Passed as
      // an ARGUMENT to the shared import function rather than handled here, so
      // this file still adds no step a file import does not also take — a
      // generated clip and a dropped one differ in what fills this parameter and
      // in nothing else.
      unitScale: generated.unitScale,
    },
    state,
  );
  return { ...chain, model: generated.model, jobId: generated.jobId };
}
