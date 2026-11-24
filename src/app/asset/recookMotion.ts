// recookMotion — the ONE road that re-cooks a single generated run (#1721).
//
// Three surfaces press it: the inspector card of a `MotionGenerate`, and the Re-cook / New seed
// buttons on that generator's strip in the NLA pane. They all come here, so "Re-cook" means one
// thing wherever it is pressed: cook THIS generator, then place what it walks.
//
// 🔴 SCOPED, ALWAYS. `cookMotionGenerations(producerId)` asks the generator for this producer only
// and bakes only its clip (#964, #1942), so a press is at most one generation call, however many
// other runs are stale. A global cook-everything press is #1470's bug, and nothing here offers one.
//
// NEW SEED goes through the same param road an inspector field takes (`routeAnimatedGrab` → the
// source write → `autoKeyCommit`), so a keyed or Auto-Keyed seed is treated exactly as typing a
// seed would treat it, and a DRIVEN seed is refused: the driver owns that value, and writing the
// base under it would be a change nobody sees.
//
// REF: src/app/asset/cookMotionGenerations.ts (the cook + placement);
//      src/app/asset/MotionGenerateCookConnector.tsx (the card);
//      src/app/animate/autoKeyCommit.ts (the param road);
//      src/timeline/NlaGeneratedRuns.tsx (the strip); issues #1721, #964, #1942.

import { useDagStore } from '../../core/dag/store';
import type { DagState } from '../../core/dag/state';
import { driverNodesForTarget } from '../paramDrivers';
import { autoKeyCommit, routeAnimatedGrab } from '../animate/autoKeyCommit';
import {
  cookMotionGenerations,
  placeCookedMotion,
  type CookOutcome,
} from './cookMotionGenerations';
import { chooseSeed } from './mintMotionGenerate';

/** Re-cook one generator: keeps its prompt and seed, follows its current path. */
export async function recookMotion(producerId: string): Promise<CookOutcome> {
  const outcome = await cookMotionGenerations(producerId);
  // A re-cook is on a clip that is already bound, so the character it walks exists and placement
  // can find it. On a first generation this is a no-op: the minting road placed after its bind.
  // Scoped like the cook (#1942): another stale run whose take is cached must not be moved.
  placeCookedMotion(producerId);
  return outcome;
}

/** Whether a driver owns this generator's seed — then New seed is not offered. */
export function seedIsDriven(
  producerId: string,
  nodes: DagState['nodes'] = useDagStore.getState().state.nodes,
): boolean {
  return driverNodesForTarget(nodes, producerId).some(
    (d) => (d.params as { paramPath?: unknown }).paramPath === 'seed',
  );
}

export type NewSeedResult =
  | { readonly ok: true; readonly seed: number; readonly outcome: CookOutcome }
  | { readonly ok: false; readonly reason: string };

/**
 * Pick a new seed for one generator and re-cook it. The prompt and the path stay as they are.
 *
 * `pick` is the seed source, a parameter so a test can name the seed it expects.
 */
export async function recookWithNewSeed(
  producerId: string,
  pick: () => number = chooseSeed,
): Promise<NewSeedResult> {
  const node = useDagStore.getState().state.nodes[producerId];
  if (!node || node.type !== 'MotionGenerate') {
    return { ok: false, reason: 'not a motion generator' };
  }
  if (seedIsDriven(producerId)) {
    return { ok: false, reason: 'the seed is driven — change it at its source' };
  }
  const current = (node.params as { seed?: unknown }).seed;
  let seed = pick();
  // A "new" seed equal to the old one would re-cook nothing and look like a broken button.
  if (seed === current) seed = (seed + 1) % 0x7fffffff;
  // The inspector field's road, in its order: an animated seed routes to its channel or the
  // transient store; otherwise the base is written, then Auto-Key keys it when it is on.
  if (!routeAnimatedGrab(producerId, 'seed', seed)) {
    useDagStore
      .getState()
      .dispatch({ type: 'setParam', nodeId: producerId, paramPath: 'seed', value: seed }, 'user');
    autoKeyCommit(producerId, 'seed', seed);
  }
  const outcome = await recookMotion(producerId);
  return { ok: true, seed, outcome };
}
