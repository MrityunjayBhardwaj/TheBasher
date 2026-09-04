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
  /**
   * The caller declares that it will place the character at `worldOffsetXZ`.
   *
   * Not a formality, and not a flag that turns a feature on: it is the whole of
   * what separates a caller that CAN place from one that cannot, and the two
   * exist side by side. The human road generates into the live graph and
   * continues into a bind, so it has a character to move. The agent tool runs on
   * a FORKED state and returns ops for the Diff — it never binds, so there is no
   * character in its world to place, and it must keep refusing rather than drop
   * the offset on the floor.
   *
   * Expressed as an argument the caller supplies rather than a condition this
   * file infers, because "can this caller place?" is a fact about the caller and
   * nothing here can see it. A caller that forgets to set it gets the refusal,
   * which is the safe direction: the failure is loud, and it fires at the moment
   * a world path is first requested rather than after a character has silently
   * been left at the origin.
   */
  readonly appliesWorldOffset?: boolean;
}

export interface GeneratedMotionResult extends BvhImportChainResult {
  /** Echoed so a caller can record which checkpoint produced the clip. */
  readonly model: string;
  readonly jobId: string;
  /**
   * The BVH text the generator returned, unchanged.
   *
   * Returned rather than dropped because the ONLY copy of a generated clip's
   * bytes used to be this call's local variable: the ops carry parsed keyframes,
   * and nothing can turn those back into the file that produced them. A caller
   * that wants to offer "save this" (#819) has to be handed the bytes here or
   * they are gone. It stays out of the Ops on purpose — a provenance field on the
   * graph is exactly what phase A1 refuses.
   */
  readonly bvh: string;
  /**
   * Where frame 0 belongs in world XZ, in metres, or `null` when no world path
   * was requested.
   *
   * Passed straight through from the generator rather than applied here. The
   * offset is a placement, and placement is a pose the Object owns — baking it
   * into the clip would make the clip carry a world position, so dropping the
   * same walk on a second character would teleport it to the first one's spot.
   *
   * `null` and `[0, 0]` stay distinct: no path was asked for, versus a path that
   * genuinely starts at the origin.
   */
  readonly worldOffsetXZ: readonly [number, number] | null;
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
  // 🔴 A WORLD OFFSET WE CANNOT PLACE IS A REFUSAL, NOT A DEFAULT (#826).
  //
  // When a world path is requested, the generator canonicalises frame 0 to the
  // origin and returns the offset needed to put the motion back where it was
  // asked for. Nothing in this chain applies it yet: placement is A2's build
  // (#730), and inventing a placement here — or dropping the offset — would put
  // the character at the origin instead of on the curve the director drew,
  // while every frame of the clip looks perfectly correct.
  //
  // #730 took that decision: the offset is applied to the placement node the
  // bound character ALREADY has — a glTF import's root Group — because that node
  // is what owns where a thing stands, and neither the clip nor this chain does.
  //
  // So the refusal narrows rather than disappears. It now fires for a caller that
  // cannot place, and only for that caller. The agent tool is exactly such a
  // caller and is not a hypothetical one: it runs on a forked state and returns
  // ops for the Diff without ever binding, so there is no character in its world
  // to move. Deleting the gate outright would have turned its refusal into a
  // silent origin-placement — trading a loud failure for the quiet wrong answer
  // this comment was written to prevent.
  if (generated.worldOffsetXZ !== null && !args.appliesWorldOffset) {
    const [x, z] = generated.worldOffsetXZ;
    throw new Error(
      `Motion was generated about the origin from a world path starting at ` +
        `[${x}, ${z}] (metres), and this caller cannot place it. A caller that ` +
        `binds the motion to a character can set \`appliesWorldOffset\` and move ` +
        `that character by the returned \`worldOffsetXZ\`; without it, the motion ` +
        `would land at the origin rather than where the path was drawn.`,
    );
  }
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
  return {
    ...chain,
    model: generated.model,
    jobId: generated.jobId,
    bvh: generated.bvh,
    worldOffsetXZ: generated.worldOffsetXZ,
  };
}
