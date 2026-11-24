// What a Tripo generation is ESTIMATED to cost, in Tripo credits, so the cost is shown before a
// director runs one (#1720).
//
// 🔴 AN ESTIMATE, AND LABELLED ONE EVERYWHERE IT IS SHOWN. Tripo's API returns no price for a
// request before it runs, and nothing in this module asks it for one. The table below is the one
// Tripo's own Blender add-on prints on its Generate button — `calculate_generation_price`,
// `ref/sources/tripo-3d-for-blender/utils.py:244-272` — transcribed rule for rule. If Tripo
// changes its prices the add-on's table and this one drift together, and the surface says
// "estimate" so nobody mistakes it for a quote.
//
// Rigging has no row in that table, so a rigged request's estimate covers the mesh only and says
// so (`rigPriced: false`) rather than inventing a number.
//
// The table, as the add-on states it:
//   base 10; +10 for anything that is not text-to-model (an image or multiview);
//   on a v2.x model: +10 texture or PBR, +10 detailed texture, +20 detailed geometry, +5 quad
//   (the add-on's +5 for a non-original style is omitted: no v3 request carries a style, #1408);
//   on any other model (v3): +10.
//
// REF: ref/sources/tripo-3d-for-blender/utils.py:244 (`calculate_generation_price`);
//      ref/sources/tripo-3d-for-blender/ui.py:174,257 (where the add-on shows it).

import type { ModelGenerationRequest } from './ModelGenerationCapability';

export interface ModelGenerationCostEstimate {
  /** Credits for one run of the request. */
  readonly perRun: number;
  /** Credits for `runs` runs. */
  readonly total: number;
  readonly runs: number;
  /** False when the request also rigs: the table has no price for rigging. */
  readonly rigPriced: boolean;
}

/** The estimate's provenance, for a tooltip or a line under the number. */
export const MODEL_COST_ESTIMATE_SOURCE = "Tripo's Blender add-on price table";

/** Credits for ONE run of `request`, by the add-on's table. */
export function estimateTripoCredits(
  request: Pick<
    ModelGenerationRequest,
    'source' | 'modelVersion' | 'texture' | 'pbr' | 'textureQuality' | 'geometryQuality' | 'quad'
  >,
): number {
  let price = 10;
  if (request.source !== 'text') price += 10;
  const version = request.modelVersion ?? '';
  if (version.startsWith('v2.')) {
    // Texture and PBR default ON at the service (and in the add-on), so absent counts as on.
    if (request.texture !== false || request.pbr !== false) price += 10;
    if (request.textureQuality === 'detailed') price += 10;
    if (request.geometryQuality === 'detailed') price += 20;
    if (request.quad === true) price += 5;
  } else {
    price += 10;
  }
  return price;
}

/** The estimate for `runs` runs of `request`, rigged or not. */
export function estimateModelGenerationCost(
  request: Parameters<typeof estimateTripoCredits>[0],
  runs: number,
  rig: boolean,
): ModelGenerationCostEstimate {
  const perRun = estimateTripoCredits(request);
  return { perRun, total: perRun * runs, runs, rigPriced: !rig };
}
