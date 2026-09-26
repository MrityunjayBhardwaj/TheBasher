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
import { cookMotionGenerations, motionCookOffer, placeCookedMotion } from './cookMotionGenerations';

export function MotionGenerateCookConnector({ producerId }: { producerId: NodeId }) {
  const state = useDagStore((s) => s.state);
  const [busy, setBusy] = useState(false);
  const offer = motionCookOffer(state, producerId);

  async function run() {
    setBusy(true);
    try {
      // SCOPED to this node (#964). Unscoped, one press cooked every producer the
      // graph reported as pending — which after a reload is all of them, because
      // the generated-clip cache is module state and does not survive one.
      await cookMotionGenerations(producerId);
      // A re-cook is on a clip that is already bound, so the character it walks
      // exists and placement can find it. On a first generation this is a no-op,
      // because the road that mints has already placed after its bind.
      placeCookedMotion();
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
        onClick={run}
        className="w-full rounded border border-border px-2 py-1 text-[10px] disabled:opacity-40"
      >
        {busy ? 'Generating…' : offer.label}
      </button>
      {offer.stale ? (
        <p data-testid="motion-cook-stale" className="mt-1 text-fg/40">
          The clip still plays its last result until you re-cook.
        </p>
      ) : null}
    </div>
  );
}
