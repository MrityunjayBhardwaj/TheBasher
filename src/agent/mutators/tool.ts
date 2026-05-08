// agent.listMutators + agent.proposePlan — the LLM-facing surface for
// the Mutator catalog.
//
// listMutators is read-only: returns metadata so the LLM can pick a
// mutator for a given intent without spending a dag.exec round.
//
// proposePlan is the main mutation surface: { mutator, spec, intent }
// runs the chosen mutator through the five-gate validator and returns
// either the proposed Op[] (the orchestrator forwards them to
// useDiffStore.propose with the Mutator-declared closureSpec) or a
// structured rejection (gate + reason) the LLM can react to.
//
// NOTE: proposePlan returns ops:[] when the gate rejects. The
// orchestrator inspects result.text to distinguish "rejected by gate"
// from "successfully proposed N ops" — the rejection structure carries
// `mutator` + `gate` so retry policies are deterministic.
//
// REF: P2.5.2 PLAN §5 Wave C step 4.

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../tools/types';
import { getMutator, listMutatorMetadata } from './catalog';
import { validatePlan } from './validate';
import type { MutatorValidationResult } from './types';

// ---------------------------------------------------------------------------
// agent.listMutators
// ---------------------------------------------------------------------------

const listMutatorsSchema = z.object({}).default({});

export const listMutatorsTool: ToolDefinition<Record<string, never>> = {
  name: 'agent.listMutators',
  description:
    'List the registered Mutators with their contracts (required edges, ' +
    'required node types, what they preserve / lose). Read-only. Call this ' +
    'BEFORE proposing a plan to pick the right Mutator for the intent.',
  paramSchema: listMutatorsSchema as unknown as z.ZodType<Record<string, never>, z.ZodTypeDef, unknown>,
  handler(_args, _ctx: ToolContext): ToolResult {
    return {
      ops: [],
      text: JSON.stringify({ mutators: listMutatorMetadata() }, null, 2),
    };
  },
};

// ---------------------------------------------------------------------------
// agent.proposePlan
// ---------------------------------------------------------------------------

const proposePlanSchema = z.object({
  mutator: z.string().min(1).describe('Mutator name, e.g. "mutator.rotate".'),
  intent: z
    .string()
    .min(1)
    .describe('Human-readable intent — surfaces in the diff bar + telemetry.'),
  spec: z.unknown().describe('Mutator-specific spec — see agent.listMutators for shapes.'),
});

export type ProposePlanArgs = z.infer<typeof proposePlanSchema>;

export const proposePlanTool: ToolDefinition<ProposePlanArgs> = {
  name: 'agent.proposePlan',
  description:
    'Propose a structured mutation plan via the Mutator catalog. Runs five ' +
    'gates (node existence, schema, closure, preconditions, adapter) BEFORE ' +
    'returning Op[]. On gate failure, returns a structured rejection with ' +
    'the gate number + reason — retry with corrected args or call ' +
    'dag.inspect for context.',
  paramSchema: proposePlanSchema,
  handler(args: ProposePlanArgs, ctx: ToolContext): ToolResult {
    const mutator = getMutator(args.mutator);
    if (!mutator) {
      const result: MutatorValidationResult = {
        ok: false,
        mutator: args.mutator,
        gate: 1,
        label: 'node_existence',
        reason: `Unknown mutator "${args.mutator}". Call agent.listMutators to see registered names.`,
      };
      return { ops: [], text: JSON.stringify(result) };
    }

    const specParse = mutator.spec.safeParse(args.spec);
    if (!specParse.success) {
      const result: MutatorValidationResult = {
        ok: false,
        mutator: args.mutator,
        gate: 2,
        label: 'param_schema',
        reason: `Mutator spec failed schema validation: ${specParse.error.message}`,
      };
      return { ops: [], text: JSON.stringify(result) };
    }

    const result = validatePlan(mutator, specParse.data, ctx.dagState, args.intent);

    if (!result.ok) {
      // Rejection — ops:[] keeps the diff path inert. The orchestrator
      // reads result.text and threads the rejection back to the LLM.
      return { ops: [], text: JSON.stringify(result) };
    }

    // Plan accepted. The orchestrator gets the ops AND the validation
    // text — text carries the closure metadata + warnings + intent for
    // downstream propose() invocation (which expects a closureSpec
    // object, reconstructed from result.closure.spec).
    return {
      ops: result.ops,
      text: JSON.stringify({
        ok: true,
        mutator: result.mutator,
        intent: result.intent,
        closureRoots: result.closure.spec.rootSelectors,
        closureFollowedEdges: result.closure.spec.followedEdges,
        nodesInClosure: result.closure.nodes.size,
        warnings: result.warnings,
      }),
    };
  },
};
