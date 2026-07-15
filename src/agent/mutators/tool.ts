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
import { getMutator, getMutatorMetadata, listMutatorSummaries } from './catalog';
import { validatePlan } from './validate';
import type { MutatorValidationResult } from './types';

// ---------------------------------------------------------------------------
// agent.listMutators  (the PICKER — name + one-line summary + specExample)
// ---------------------------------------------------------------------------

const listMutatorsSchema = z.object({}).default({});

export const listMutatorsTool: ToolDefinition<Record<string, never>> = {
  name: 'agent.listMutators',
  description:
    'List the Mutator catalog as name + one-line summary + specExample — ' +
    'everything needed to pick a Mutator AND build the agent.proposePlan call. ' +
    'Read-only; call once, then go straight to agent.proposePlan (copy the ' +
    "chosen entry's specExample). Only call agent.getMutator if a plan is " +
    'rejected and you need the full contract to understand why. ' +
    'IMPORTANT: the names ("mutator.rotate", "mutator.duplicate", etc.) are ' +
    'VALUES for the `mutator` arg of agent.proposePlan, NOT callable tool ' +
    'names — never call "mutator.X" directly.',
  paramSchema: listMutatorsSchema as unknown as z.ZodType<
    Record<string, never>,
    z.ZodTypeDef,
    unknown
  >,
  handler(_args, _ctx: ToolContext): ToolResult {
    // Compact (no pretty-print) — the picker is machine-read, and the
    // indentation is pure overhead the model re-parses every round (#332).
    return {
      ops: [],
      text: JSON.stringify({ mutators: listMutatorSummaries() }),
    };
  },
};

// ---------------------------------------------------------------------------
// agent.getMutator  (the DETAIL — full contract + specExample for ONE)
// ---------------------------------------------------------------------------

const getMutatorSchema = z.object({
  name: z.string().min(1).describe('Mutator name from agent.listMutators, e.g. "mutator.rotate".'),
});

export type GetMutatorArgs = z.infer<typeof getMutatorSchema>;

export const getMutatorTool: ToolDefinition<GetMutatorArgs> = {
  name: 'agent.getMutator',
  description:
    "Fetch ONE Mutator's full detail — the complete description plus the " +
    'contract (required edges / node types, preserved + lossy aspects). ' +
    'Read-only. agent.listMutators already gives the summary + specExample you ' +
    'need to propose; call THIS only when a plan was rejected and you need the ' +
    'contract to understand the gate failure.',
  paramSchema: getMutatorSchema,
  handler(args: GetMutatorArgs, _ctx: ToolContext): ToolResult {
    const meta = getMutatorMetadata(args.name);
    if (!meta) {
      return {
        ops: [],
        text: `ERROR: unknown mutator "${args.name}". Call agent.listMutators for the registered names.`,
      };
    }
    return { ops: [], text: JSON.stringify(meta, null, 2) };
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
  spec: z
    .unknown()
    .describe(
      "Mutator-specific spec object. Copy the chosen entry's `specExample` " +
        'shape from agent.listMutators — substitute real node ids into ' +
        '`targetSelectors` and adjust value fields as needed.',
    ),
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
