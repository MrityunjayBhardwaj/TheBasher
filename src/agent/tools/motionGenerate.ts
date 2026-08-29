// motion.generate — agent tool. Text becomes an AnimationClip in the graph.
//
// The claim phase A1 makes is that a generated clip is indistinguishable
// downstream from an imported one, and this file is where that claim is either
// kept or quietly broken. It keeps it by having nothing of its own: the handler
// calls `buildGeneratedMotionOps`, which calls `buildBvhImportOps` — the same
// function, with the same arguments, that a dropped .bvh file calls. There is no
// second road to keep in step and no provenance flag for anything downstream to
// branch on.
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
// src/core/motiongen/generatedMotionChain.ts; ref/architecture/ai-track.md A1.

import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import { buildGeneratedMotionOps } from '../../core/motiongen';
import { conditionsFor } from '../../core/licensing/allowedModels';
import { MAX_MOTION_SECONDS } from '../../core/motiongen';

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
    'a Skeleton + AnimationClip wired to the project TimeSource — the identical ops ' +
    'a dropped .bvh file produces, carrying no mark of having been generated, so ' +
    'every road open to an imported clip is open to this one. Retarget it with ' +
    'mutator.animation.retarget. The checkpoint is configured in Settings, not ' +
    'chosen per call.',
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

    let result;
    try {
      result = await buildGeneratedMotionOps(
        ctx.motionCapability,
        {
          request: {
            prompt: args.prompt,
            model: ctx.motionModel,
            ...(args.seconds !== undefined ? { seconds: args.seconds } : {}),
            ...(args.seed !== undefined ? { seed: args.seed } : {}),
          },
          ...(args.name !== undefined ? { name: args.name } : {}),
        },
        // V7 — the FORKED state, never the live store. The tool returns ops for
        // the Diff; the user accepts before anything real changes.
        ctx.dagState,
      );
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

    return {
      ops: result.ops,
      text:
        `Generated "${args.name ?? args.prompt}" with ${ctx.motionModel} ` +
        `(job ${result.jobId}) — Skeleton ${result.skeletonId}, AnimationClip ` +
        `${result.clipId}. It is an ordinary clip, with nothing in the graph ` +
        `marking it as generated: retarget it onto a character with ` +
        `mutator.animation.retarget.` +
        owed,
    };
  },
};
