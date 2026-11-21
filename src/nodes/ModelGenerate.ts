// ModelGenerate — text-to-3D / image-to-3D as a NODE, so a generated model keeps the arguments
// that made it and can be made again (#1720).
//
// A generated model used to arrive exactly as an imported file does, with nothing recording the
// prompt, the reference image or the seed — so it could not be regenerated, varied or traced.
// `MotionGenerate` (#902) settled the same question for motion, and this node takes its answer:
// the arguments that DETERMINE a result live on a producer in the graph. They are not a
// "generated" label on the result; the mesh itself still arrives through the import road, as an
// ordinary `Object` + `PolyMeshData`, and nothing downstream can branch on how it was made.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IT HOLDS, AND WHY IT HAS NO SOCKETS
// ─────────────────────────────────────────────────────────────────────────
// The request (`prompt`, `references`, `seed`, `provider`, `rig`, `count`) and the VARIANTS that
// request has produced so far. A variant is one run of the request with its own seed, stored as
// bytes outside the library until a director keeps it; keeping one imports it through the same
// road a dropped `.glb` takes and marks it `kept`.
//
// No inputs and no outputs, like `TemplateDefinition`: nothing in the graph reads it as a value.
// What it produces is an asset in the store, which the import road turns into nodes; the link
// back from the asset is the record the keep writes beside it (`generation.json`, read by
// `readGenerationRecord`), which names this node. A socket here would invent a value nothing
// consumes.
//
// `pure: true` and `evaluate` returns null: it does no I/O and has nothing to compute. The
// network call belongs to the app-layer road (`src/app/asset/generateModel.ts`), the same split
// MotionGenerate draws between its evaluator and its resolver.
//
// ─────────────────────────────────────────────────────────────────────────
// THE SEED IS REQUIRED
// ─────────────────────────────────────────────────────────────────────────
// For MotionGenerate's reason: a defaulted seed is a seed nobody chose. `seed` is the seed the
// FIRST variant ran with; each later variant (Regenerate included) records its own on its row.
//
// REF: src/nodes/MotionGenerate.ts (the producer this mirrors);
//      src/nodes/TemplateDefinition.ts (a node held in the graph that nothing reads as a value);
//      src/app/asset/generateModel.ts (the road that mints, runs and keeps);
//      issues #1720, #902, #837 (prompt and image cannot be combined), #806.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import { widget } from './paramWidget';

/** How many variants one run may ask for. A bound on a billed fan-out, not taste. */
export const MAX_MODEL_VARIANTS = 8;

/** The default number of variants a run asks for (design board 13b: "4 variants arrive"). */
export const DEFAULT_MODEL_VARIANTS = 4;

/**
 * How many reference images a request may carry. One: Tripo's image-to-model takes a single
 * image (`ref/sources/tripo-python-sdk/tripo3d/client.py:623`), and its multiview road wants four
 * NAMED views rather than a list of references (#806). A list, so that road can widen it without
 * a migration.
 */
export const MAX_MODEL_REFERENCES = 1;

export const ModelVariantSchema = z.object({
  /** The seed this variant ran with. */
  seed: z.number().int().finite(),
  /** Where its bytes are stored (`model-variants/<node>/…`) until a director keeps it. */
  path: z.string().min(1),
  /** The provider's task id, for the record and for a support request. */
  taskId: z.string(),
  /** A director kept it: it was imported and saved to the library. */
  kept: z.boolean().default(false),
});
export type ModelVariant = z.infer<typeof ModelVariantSchema>;

export const ModelGenerateParams = z.object({
  /**
   * What to generate. May be empty when a reference image is given: Tripo cannot take a prompt
   * beside an image (#837), so the image is the subject and the request schema in
   * `core/modelgen` refuses a text request with no prompt.
   */
  prompt: widget('text', z.string()),
  /** Reference images, as keys in the open project's image store (`projectImages.ts`). */
  references: z.array(z.string().min(1)).max(MAX_MODEL_REFERENCES).default([]),
  /** The seed the first variant ran with. Required and un-defaulted — see the header. */
  seed: z.number().int().finite(),
  /** The provider that answers (`stub-modelgen`, `tripo`) — recorded, so a result says where
   *  it came from. Required: a hidden default would name a service nobody chose. */
  provider: z.string().trim().min(1, 'must not be empty'),
  /** Give the result a skeleton (the character road). */
  rig: z.boolean().default(false),
  /** How many variants one run asks for. */
  count: z.number().int().min(1).max(MAX_MODEL_VARIANTS).default(DEFAULT_MODEL_VARIANTS),
  // The service's own knobs, optional: absent lets the service decide, which is what every
  // request before #1720 did. They determine the result, so they are arguments like the seed —
  // a Regenerate that dropped them would not be the same request.
  /** What to avoid (text requests only). */
  negativePrompt: z.string().trim().min(1).optional(),
  /** Cap on output triangles. Bounded like the request contract's `MAX_FACE_LIMIT`. */
  faceLimit: z.number().int().positive().max(2_000_000).optional(),
  quad: z.boolean().optional(),
  texture: z.boolean().optional(),
  pbr: z.boolean().optional(),
  /** Every variant this request has produced, oldest first. */
  variants: z.array(ModelVariantSchema).default([]),
});
export type ModelGenerateParams = z.infer<typeof ModelGenerateParams>;

export const MODEL_GENERATE_TYPE = 'ModelGenerate';

export const ModelGenerateNode: NodeDefinition<ModelGenerateParams, null> = {
  type: MODEL_GENERATE_TYPE,
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ModelGenerateParams,
  inputs: {},
  outputs: {},
  evaluate: () => null,
};

/** The seed a new variant of `params` runs with: one past every seed it has used, so a
 *  Regenerate never repeats a variant it already has. */
export function nextVariantSeed(params: Pick<ModelGenerateParams, 'seed' | 'variants'>): number {
  let max = params.seed - 1;
  for (const v of params.variants) if (v.seed > max) max = v.seed;
  return max + 1;
}
