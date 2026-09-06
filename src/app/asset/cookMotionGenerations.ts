// The cook affordance's callee (#935) — the one thing that runs the resolver.
//
// Before this, `resolvePendingMotionGenerations` was a function nobody invoked,
// so every `MotionGenerate` in a graph stayed `pending` forever. This is the
// trigger, and the shape it takes IS the re-cook policy #902 left open.
//
// ─────────────────────────────────────────────────────────────────────────────
// EXPLICIT COOK, NOT DEBOUNCE — AND THE DATA MODEL ALREADY ENFORCES IT
// ─────────────────────────────────────────────────────────────────────────────
// A generation is a paid, several-second call. Firing it from a render reaction
// would spend a director's money on every drag of a control point, and a debounce
// only moves that decision behind a timer nobody chose. So the cook is a call, and
// a director makes it.
//
// What makes that safe rather than merely deferred is that a stale clip keeps
// playing: the band reads the sink clip's params, and `bakeGeneratedClipOps` only
// ever writes a `ready` result. So the interval between an edit and a cook is a
// clip that is out of date, never a character standing still.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO DISPATCHES, NOT ONE, AND NOT THREE
// ─────────────────────────────────────────────────────────────────────────────
// The generation itself writes nothing to the graph — it lands in the content
// store — so there is exactly one batch of ops here, the bake. It goes out as a
// single atomic dispatch so a cook is ONE undo entry covering every clip it
// refreshed. Undoing a cook returns every clip to its previous keys together,
// which is what a director means by "undo that".
//
// REF: src/app/asset/resolveMotionGenerate.ts (performs the call);
//      src/app/asset/bakeGeneratedClip.ts (turns a landed result into Ops);
//      src/app/render/runWorkflow.ts (the same cook shape for images);
//      issues #935, #902.

import { useDagStore } from '../../core/dag/store';
import { getMotionCapability } from '../boot';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { bakeGeneratedClipOps, clipBakeStates } from './bakeGeneratedClip';
import { resolvePendingMotionGenerations } from './resolveMotionGenerate';

export interface CookOutcome {
  /** How many producers this pass generated for. */
  readonly generated: number;
  /** How many refused, each already recorded as a terminal state on its node. */
  readonly failed: number;
  /** How many sink clips had their params refreshed. */
  readonly baked: number;
  /** Set only when the pass could not START — no capability, no settings. */
  readonly reason?: string;
}

/** Whether anything in the graph is waiting to be cooked — the affordance's enabled state. */
export function hasStaleGenerations(): boolean {
  const { state } = useDagStore.getState();
  return clipBakeStates(state).some((c) => c.stale || c.status === 'pending');
}

/**
 * Resolve every pending generation and write the results into their clips.
 *
 * Never throws. A generation that refuses is recorded ON the node as a `failed`
 * state by the resolver, which is a thing the graph can show; throwing would
 * leave the surface that invoked this with no way back to idle, and the reason
 * would live only in a console.
 */
export async function cookMotionGenerations(): Promise<CookOutcome> {
  let capability;
  try {
    capability = await getMotionCapability();
  } catch (err) {
    const reason = formatAssetError(err);
    useAssetErrorStore.getState().report('motion generation', reason);
    return { generated: 0, failed: 0, baked: 0, reason };
  }

  // Read the state fresh at each step rather than once: the resolver awaits, and
  // a director can edit the graph while a several-second call is out. Baking a
  // state captured before the await would write into a graph that has moved.
  const resolutions = await resolvePendingMotionGenerations(
    useDagStore.getState().state,
    capability,
  );

  const ops = bakeGeneratedClipOps(useDagStore.getState().state);
  const baked = ops.filter((o) => o.type === 'setParam' && o.paramPath === 'sourceHash').length;
  if (ops.length > 0) {
    useDagStore
      .getState()
      .dispatchAtomic(ops, 'user', `cook motion: ${baked} clip${baked === 1 ? '' : 's'}`);
  }

  for (const r of resolutions) {
    if (r.outcome === 'failed' && r.reason) {
      useAssetErrorStore.getState().report('motion generation', r.reason);
    }
  }

  return {
    generated: resolutions.filter((r) => r.outcome === 'generated').length,
    failed: resolutions.filter((r) => r.outcome === 'failed').length,
    baked,
  };
}
