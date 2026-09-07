// The road that puts a `MotionGenerate` into a graph (#935).
//
// Before this, the node was registered and reachable from nothing: no menu, no
// drop road, no mutator minted one, so a director could not get a producer into
// a project at all. A node type nobody can construct is a lying entry in the
// registry — it reads as a capability and is a declaration.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT MINTS THREE NODES AND NOT ONE
// ─────────────────────────────────────────────────────────────────────────────
// The producer is not what the render band reads; an ordinary `AnimationClip`
// is, and the cook writes the produced keys into its params. So the smallest
// USEFUL thing to mint is the whole chain:
//
//   [curve Object] --path--> MotionGenerate --source--> AnimationClip
//                                                        |
//                                            Skeleton ---+
//
// No clock on the clip: it is time-free (#920). Sampling belongs to the consumer
// that holds a `Time`, so there is no `time` socket to wire and no `TimeSource`
// to require — the same removal the BVH import chain took for the same reason.
//
// Minting only the producer would leave a node whose output reaches nobody,
// which is the exact defect this issue exists to close — one layer down.
//
// The `Skeleton` starts EMPTY rather than guessed. The generator's rig is not
// known until it answers, and a placeholder rig would give the clip's future
// bone indices something plausible to address that is not what they mean.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE CURVE IS OPTIONAL AND ITS ABSENCE IS NOT A FAILURE
// ─────────────────────────────────────────────────────────────────────────────
// "Generate a walk" is a complete request. "Generate a walk along this path" is
// a different one. Refusing the first would make the path mandatory, which the
// node's own schema does not say — `path` is an optional input, and `null` vs an
// empty point list is a distinction the request hash already keeps.
//
// REF: src/core/import/bvhImportChain.ts (the chain this mirrors, node for node);
//      src/app/asset/bakeGeneratedClip.ts (what fills the clip in);
//      src/nodes/MotionGenerate.ts; issues #935, #902.

import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';

export interface MintMotionGenerateArgs {
  readonly prompt: string;
  readonly seed: number;
  readonly model: string;
  readonly seconds?: number;
  /** Clip name. Defaults to the prompt, the way an import defaults to a filename. */
  readonly name?: string;
  /**
   * The `Object` carrying the curve to walk, when there is one.
   *
   * An OBJECT and not the `CurveData` beneath it: placement lives on the Object
   * under the object/data split, and where the path sits is part of the request.
   */
  readonly curveObjectId?: string;
  /** Explicit ids, so a caller can address the nodes it just made. */
  readonly ids?: { producer: string; clip: string; skeleton: string };
}

export interface MintMotionGenerateResult {
  readonly ops: Op[];
  readonly producerId: string;
  readonly clipId: string;
  readonly skeletonId: string;
}

/**
 * A seed a caller did not supply but the node will always carry.
 *
 * It lives HERE, beside the mint, because both roads to a producer need one and
 * two independent choosers would be two answers to "what seed did this clip use"
 * — the exact question `MotionGenerate` refuses to leave unanswered by giving
 * `seed` no default. Positive and 32-bit so it round-trips through JSON and reads
 * as a number rather than an artefact.
 */
export function chooseSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

let mintCounter = 0;
function mintId(prefix: string): string {
  mintCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${mintCounter}`;
}

/**
 * Ops that add a motion generator and the clip it will fill.
 *
 * Returns ops rather than dispatching, the same contract every import road uses,
 * so the whole chain lands as ONE undo entry.
 *
 * It requires no `TimeSource`. It used to throw without one — a clip with no
 * clock never advances — but a clip stopped carrying a clock at #920, so the
 * condition can no longer arise here. The BVH chain dropped the same lookup for
 * the same reason.
 */
export function mintMotionGenerateOps(
  // Unread since the clock lookup went (#920), and KEPT: every op-builder on
  // this road takes the state it builds against, and a mint that needs to
  // consult the graph again — to reuse an existing skeleton, say — should not
  // have to change its signature at every call site to do it.
  _state: DagState,
  args: MintMotionGenerateArgs,
): MintMotionGenerateResult {
  const ids = args.ids ?? {
    producer: mintId('motiongen'),
    clip: mintId('motionclip'),
    skeleton: mintId('motionskel'),
  };

  const name = (args.name ?? args.prompt).trim() || args.prompt;

  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: ids.producer,
      nodeType: 'MotionGenerate',
      params: {
        prompt: args.prompt,
        seed: args.seed,
        model: args.model,
        ...(args.seconds !== undefined ? { seconds: args.seconds } : {}),
        name,
      },
    },
    // Empty until the generator says what rig it produced.
    { type: 'addNode', nodeId: ids.skeleton, nodeType: 'Skeleton', params: { bones: [] } },
    {
      type: 'addNode',
      nodeId: ids.clip,
      nodeType: 'AnimationClip',
      // No keys and no `sourceHash`, so the clip reads as never-baked and the
      // first cook is not mistaken for a no-op. `duration` is left to the schema
      // default: nothing has been produced, so any number here would be a length
      // this clip does not have, and the cook overwrites it with the real one.
      // `'hold'` is what the old boolean `false` meant (#930): the clip is a
      // placeholder until the cook lands keys, and a placeholder that claimed to
      // cycle would extend nothing past a range it does not have yet.
      params: { name, loop: 'hold', keyframes: [], sourceHash: '' },
    },
    {
      type: 'connect',
      from: { node: ids.skeleton, socket: 'out' },
      to: { node: ids.clip, socket: 'skeleton' },
    },
    // The edge that makes the clip a produced one rather than an imported one.
    {
      type: 'connect',
      from: { node: ids.producer, socket: 'out' },
      to: { node: ids.clip, socket: 'source' },
    },
  ];

  if (args.curveObjectId !== undefined) {
    ops.push({
      type: 'connect',
      from: { node: args.curveObjectId, socket: 'out' },
      to: { node: ids.producer, socket: 'path' },
    });
  }

  return { ops, producerId: ids.producer, clipId: ids.clip, skeletonId: ids.skeleton };
}
