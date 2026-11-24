// The cook affordance on a MotionGenerate's inspector card (#935).
//
// 🔑 IT LIVES ON THE NODE, AND THAT PLACEMENT IS THE CLAIM. Both reference
// systems put the pin-an-expensive-result control on the thing that produced it:
// Blender bakes a simulation zone or a Bake node and shows the baked frame count
// above that node; Houdini's lock/freeze snapshot pins the operator it sits on.
// A global "cook everything" button would make a director's money a property of
// the scene rather than of the node they are looking at.
//
// It is also the shipped pattern one domain over: the inspector already renders
// `CostPreviewConnector` for a `ComfyUIWorkflow` — this repo's other expensive
// generative node — gated the same way, in the same place.
//
// The DECISION is `motionCookOffer`, a pure function, because this project has
// no React Testing Library: a decision that lives in JSX is a decision no row can
// reach. This file is the wiring and nothing else.
//
// REF: src/app/asset/cookMotionGenerations.ts (`motionCookOffer`, the decision);
//      src/app/render/CostPreviewConnector.tsx (the pattern this mirrors);
//      src/app/NPanel.tsx (where it mounts); issues #935, #902.

import { useState } from 'react';
import { useDagStore } from '../../core/dag/store';
import type { NodeId } from '../../core/dag/types';
import { motionCookOffer } from './cookMotionGenerations';
import { recookMotion, recookWithNewSeed, seedIsDriven } from './recookMotion';
import { uiEvaluatorCache } from '../uiEvaluatorCache';

export function MotionGenerateCookConnector({ producerId }: { producerId: NodeId }) {
  const state = useDagStore((s) => s.state);
  const [busy, setBusy] = useState(false);
  const offer = motionCookOffer(state, producerId, uiEvaluatorCache);
  const driven = seedIsDriven(producerId, state.nodes);

  async function run(kind: 'recook' | 'seed' = 'recook') {
    setBusy(true);
    try {
      // SCOPED to this node (#964), through the one road the strip's buttons take too (#1721).
      // Unscoped, one press cooked every producer the graph reported as pending — which after a
      // reload is all of them, because the generated-clip cache is module state.
      if (kind === 'recook') await recookMotion(producerId);
      else await recookWithNewSeed(producerId);
    } finally {
      // Always cleared, even on a refusal: the callee never throws, and a button
      // stuck on "Generating…" would be a second failure on top of the first.
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="motion-cook"
      className="border-t border-border bg-muted/30 px-3 py-2 text-[10px] text-fg/60"
    >
      <div className="mb-1 flex items-center justify-between">
        <span>Motion</span>
        {offer.status ? <span data-testid="motion-cook-status">{offer.status}</span> : null}
      </div>
      <button
        type="button"
        data-testid="motion-cook-run"
        disabled={offer.disabled || busy}
        onClick={() => void run('recook')}
        className="w-full rounded border border-border px-2 py-1 text-[10px] disabled:opacity-40"
      >
        {busy ? 'Generating…' : offer.label}
      </button>
      {/* #1721 — New seed: a different take of the same prompt on the same path. Offered only once
          a clip is wired (there is something to re-cook into) and while no driver owns the seed. */}
      {offer.status !== null ? (
        <button
          type="button"
          data-testid="motion-cook-newseed"
          disabled={driven || busy}
          title={
            driven ? 'The seed is driven — change it at its source' : 'Pick a new seed and re-cook'
          }
          onClick={() => void run('seed')}
          className="mt-1 w-full rounded border border-border px-2 py-1 text-[10px] disabled:opacity-40"
        >
          New seed
        </button>
      ) : null}
      {offer.stale ? (
        <p data-testid="motion-cook-stale" className="mt-1 text-fg/40">
          The clip still plays its last result until you re-cook.
        </p>
      ) : null}
    </div>
  );
}
