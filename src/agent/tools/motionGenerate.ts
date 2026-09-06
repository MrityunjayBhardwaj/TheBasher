// motion.generate — agent tool. Text becomes an AnimationClip in the graph.
//
// The claim this file keeps is UI == agent: a director and the agent must end up
// with the same graph. It keeps it by having nothing of its own — the handler
// calls `mintMotionGenerateOps` and `bakeGeneratedClipOps`, the same two
// functions, over the same state, that the director's road calls. There is no
// second road to keep in step.
//
// 🔑 IT MINTS A PRODUCER, NOT A BARE CLIP (#948). It used to call
// `buildGeneratedMotionOps` and land exactly what a dropped .bvh lands. A
// director's road stopped doing that at #935: it now mints a `MotionGenerate`
// node and cooks it, so the prompt, the seed and the waypoints survive and the
// clip can be re-cooked when a control point moves. For as long as the agent kept
// the old road the two surfaces built genuinely different things, and the parity
// row went on passing because it asserted the agent against a road no director
// took — a claim measuring a road nobody walks.
//
// The clip is still an ordinary `AnimationClip` carrying no provenance flag; what
// is new is the input edge feeding it. Everything downstream reads the clip's
// params exactly as before, which is why the producer changes nothing for a
// consumer and everything for the director.
//
// WHAT "COOK" MEANS HERE, AND WHY IT IS STILL ONE Op[]. The mint is pure, so the
// handler applies it to a FORKED state (V7 — never the live store), resolves the
// producer against the capability, and asks for the bake ops that resolution made
// available. The director reaches the same place in two dispatches — mint, then
// the cook button on the node's card — because a director is present to press it.
// The agent returns both halves as one batch for the Diff, because a tool that
// returned a half-built node would ask the model to press a button it cannot see.
//
// Shaped after `library.import`, which is the closest sibling: async, brings an
// asset into the scene, returns Op[] for the Diff and NEVER dispatches (V7). It
// is a tool rather than a mutator because a mutator's `build` is synchronous and
// pure by contract, and generation is network I/O — modelling it as a mutator
// would have meant either lying about purity or inventing a node type whose
// evaluation performs I/O, which is the provenance branch A1 exists to avoid.
//
// The agent-facing text names only roads that exist. It used to offer the clip
// as one that could be "layered under a hand-authored clip", which is a
// capability the graph does not have: enumerating every input socket of all 81
// registered node types finds exactly one that consumes a pose —
// `LocomotionState.clip`, cardinality `single` — and `PosedSkeleton` has none at
// all, so two clips cannot meet anywhere. Nothing layers, for generated,
// imported or hand-authored motion alike; `AnimationLayer` carried it and was
// retired in #199. A description is an instruction to a model, and a capability
// named in it that the model then cannot reach costs a turn and teaches nothing,
// because wiring a second clip to that one socket silently replaces the first
// rather than refusing. A test derives the claim's premise from the live
// registry, so the day a fold node ships the guard reds and this text is
// rewritten deliberately instead of drifting back. Issues #758, #759, #760.
//
// The checkpoint is NOT an argument. It is configuration: a director chooses it
// once in Settings, and the tool generates with what is configured. Letting the
// agent name a checkpoint per call would spread the licence surface across every
// prompt for no gain — the model is not choosing between capabilities, it is
// asking for motion.
//
// REF: src/agent/tools/libraryImport.ts (the pattern);
// src/app/asset/mintMotionGenerate.ts and src/app/asset/bakeGeneratedClip.ts
// (the two halves, shared with the director's road);
// src/app/asset/generateMotionAsNode.ts (that road); ref/architecture/ai-track.md A1.
// Issues #948, #935, #902.

import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import type { Op } from '../../core/dag/types';
import type { DagState } from '../../core/dag/state';
import { applyOp } from '../../core/dag/ops';
import { conditionsFor } from '../../core/licensing/allowedModels';
import { MAX_MOTION_SECONDS } from '../../core/motiongen';
import { bakeGeneratedClipOps } from '../../app/asset/bakeGeneratedClip';
import { chooseSeed, mintMotionGenerateOps } from '../../app/asset/mintMotionGenerate';
import { resolvePendingMotionGenerations } from '../../app/asset/resolveMotionGenerate';

export const motionGenerateSchema = z.object({
  prompt: z
    .string()
    .min(1, 'prompt is required — describe the motion, e.g. "a figure walks forward and waves"')
    .describe('Natural-language description of the motion to generate'),
  seconds: z
    .number()
    .positive()
    .max(MAX_MOTION_SECONDS)
    .optional()
    .describe('Clip length in seconds (default 2)'),
  // No `fps` argument, deliberately. The rate belongs to the generator, and the
  // clip states it in its own header — so a model calling this tool is not offered
  // a knob that two of the three real backends cannot turn.
  seed: z.number().int().optional().describe('Determinism handle — same seed, same motion'),
  name: z.string().optional().describe('Name for the resulting clip (defaults to the prompt)'),
});

export type MotionGenerateArgs = z.infer<typeof motionGenerateSchema>;

export const motionGenerateTool: ToolDefinition<MotionGenerateArgs> = {
  name: 'motion.generate',
  description:
    'Generate an animation clip from a text description. Returns an Op[] that adds ' +
    'a MotionGenerate producer feeding a Skeleton + AnimationClip wired to the ' +
    'project TimeSource — the same three nodes a director gets. The clip itself is ' +
    'an ordinary AnimationClip carrying no mark of having been generated, so every ' +
    'road open to an imported clip is open to this one: retarget it with ' +
    'mutator.animation.retarget. The producer keeps the prompt and seed, so the ' +
    'clip can be re-generated later without retyping them. The checkpoint is ' +
    'configured in Settings, not chosen per call.',
  paramSchema: motionGenerateSchema,
  async handler(args: MotionGenerateArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.motionCapability) {
      return {
        ops: [],
        text:
          'Error: no motion-generation capability configured. Set the service URL ' +
          'in Settings; with no service reachable the offline stub generates instead.',
      };
    }
    if (!ctx.motionModel) {
      // Distinct from the case above on purpose. A capability with no checkpoint
      // is a different misconfiguration from no capability at all, and reporting
      // both as one would send the reader to the wrong setting.
      return {
        ops: [],
        text:
          'Error: no motion checkpoint configured. Choose one in Settings — it is ' +
          'named explicitly rather than defaulted, because the licence varies per ' +
          'checkpoint within a single release.',
      };
    }

    // MINT — pure, and the same call the director's road makes. A seed is chosen
    // here when the model did not name one, by the SAME chooser that road uses:
    // `MotionGenerate` gives `seed` no default on purpose, so a clip that cannot
    // say which seed produced it is a clip reproducible by accident.
    let mint;
    try {
      mint = mintMotionGenerateOps(ctx.dagState, {
        prompt: args.prompt,
        seed: args.seed ?? chooseSeed(),
        model: ctx.motionModel,
        ...(args.seconds !== undefined ? { seconds: args.seconds } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
      });
    } catch (err) {
      // A graph with no TimeSource lands here. It is a real refusal with a real
      // remedy, and the message names it.
      return {
        ops: [],
        text: `Error: could not add a motion generator — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // V7 — the FORKED state, never the live store. The producer has to EXIST
    // before it can be resolved, and it does not exist until these ops are
    // applied; applying them to a fork is how the tool gets a graph to resolve
    // against without anything real changing before the user accepts.
    let forked: DagState = ctx.dagState;
    for (const op of mint.ops) forked = applyOp(forked, op).next;

    // COOK — the network half, then the pure half, exactly as `cookMotionGenerations`
    // sequences them.
    let bakeOps: Op[] = [];
    let refusal: string | undefined;
    try {
      const resolutions = await resolvePendingMotionGenerations(forked, ctx.motionCapability);
      // The resolver catches per node and RECORDS the reason rather than throwing,
      // so a licence block arrives here as a `failed` row, not as an exception.
      // Carrying its reason out is the difference between "no clip this time" and
      // "this checkpoint is blocked — change it in Settings", and only the second
      // tells the model what to do next.
      refusal = resolutions.find(
        (r) => r.nodeId === mint.producerId && r.outcome !== 'generated',
      )?.reason;
      bakeOps = bakeGeneratedClipOps(forked);
    } catch (err) {
      // A licence refusal and a transport failure both land here, and both are
      // things the model can act on — a blocked checkpoint is a settings change,
      // a timeout is a retry. Returning the message beats throwing, which would
      // end the turn with nothing the model could read.
      return {
        ops: [],
        text: `Error: motion generation failed — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // A conditional grant's obligations, at the point of use. The NOTICE file
    // discharges the shipping condition; this is the other half — an obligation
    // nobody can see at the moment they incur it is one nobody weighs.
    const conditions = conditionsFor(ctx.motionModel);
    const owed = conditions.length
      ? ` This checkpoint is licensed WITH CONDITIONS: ${conditions.join(' ')}`
      : '';

    const subject = args.name ?? args.prompt;

    if (bakeOps.length === 0) {
      // The generator refused. The MINT still ships, deliberately — the director's
      // road makes the same choice for the same reason: a generator that vanished
      // on a server hiccup takes the prompt and the seed with it, and re-cooking a
      // node that is already there beats retyping a sentence. The text says the
      // clip is empty so the model does not report success.
      return {
        ops: mint.ops,
        text:
          `Added a motion generator for "${subject}" (${ctx.motionModel}), but it ` +
          `produced no clip — AnimationClip ${mint.clipId} is still empty` +
          (refusal !== undefined ? `: ${refusal}` : '.') +
          ` The generator keeps the prompt and seed, so once the cause is fixed it ` +
          `can be re-cooked from its inspector card rather than asked for again.` +
          owed,
      };
    }

    return {
      ops: [...mint.ops, ...bakeOps],
      text:
        `Generated "${subject}" with ${ctx.motionModel} — MotionGenerate ` +
        `${mint.producerId} feeding Skeleton ${mint.skeletonId} and AnimationClip ` +
        `${mint.clipId}. The clip is ordinary, with nothing in the graph marking it ` +
        `as generated: retarget it onto a character with mutator.animation.retarget. ` +
        `The producer keeps the prompt and seed, so moving a curve control point and ` +
        `re-cooking regenerates it.` +
        owed,
    };
  },
};
