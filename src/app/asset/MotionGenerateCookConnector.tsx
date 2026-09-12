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
import {
  cookMotionGenerations,
  motionCookOffer,
  placeCookedMotion,
  STRANDED_ROWS_SHOWN,
} from './cookMotionGenerations';
import { useSelectionStore } from '../stores/selectionStore';
import { dispatchFollowClip } from '../animate/dispatchMutator';

export function MotionGenerateCookConnector({ producerId }: { producerId: NodeId }) {
  const state = useDagStore((s) => s.state);
  const [busy, setBusy] = useState(false);
  // #1004 — the ONLY thing this component decides: whether the bounded list is
  // currently expanded. Which bones, which channels and which objects are all
  // decided in `motionCookOffer`, where a row can reach them.
  const [showAll, setShowAll] = useState(false);
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
      {/* #1001 — the bones a cook leaves behind. WARN-coloured and named,
          because the alternative is this card reading "Up to date" over a
          character playing two motions at once. Named rather than counted: the
          director has to act on a bone, and "3 bones" does not say which.
          Absent entirely when nothing is stranded, which is every project where
          nobody has edited a bone.

          #1002 — and each name now carries the act beside it. A signal with
          nothing to press is a signal a director learns to scan past, which is
          the failure #923 had to correct from the other direction. */}
      {offer.stranded.length > 0 ? (
        <div data-testid="motion-cook-stranded" className="mt-1 text-warn">
          {/* THE SENTENCE COUNTS AND THE ROWS NAME — observed in pixels, where a
              single stranded bone had its name printed twice, once in the
              sentence and once on the row beside its button. The name belongs
              next to the thing that acts on it. */}
          <p>
            {offer.stranded.length === 1
              ? 'One bone is still on the previous motion — you edited it, so the clip no longer drives it.'
              : `${offer.stranded.length} bones are still on the previous motion — you edited them, so the clip no longer drives them.`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {(showAll ? offer.stranded : offer.stranded.slice(0, STRANDED_ROWS_SHOWN)).map(
              (bone) => (
                <li key={bone.childName} className="flex items-center justify-between gap-2">
                  {/* #1004 — THE NAME IS THE WAY TO GO AND LOOK. A row that only
                    offers to throw the keys away makes the destructive choice the
                    only choice: deciding whether an edit is worth keeping meant
                    leaving the card, finding the bone in the outliner, selecting
                    it, and coming back. For one bone that is friction; for twenty
                    it is the reason nobody looks.

                    Selects EVERY character carrying the name, not the first —
                    `objectIds` is derived in the offer for exactly that reason.

                    ⚠️ TWO LIMITS, BOTH OBSERVED IN PIXELS AND NEITHER FIXED HERE.
                    (1) Selection drives the inspector, so going to look REPLACES
                    this card with the bone's; the return trip is unassisted. That
                    is still strictly less work than hunting the bone in the
                    outliner, which is what this replaces. (2) The bone's inspector
                    header reads its content-addressed id (`n_gltfChild_bcf19259`),
                    not `mixamorig_LeftArm` — so you press a name and land on
                    something that does not say it. Pre-existing for every imported
                    child however it is selected, and filed separately rather than
                    widened into this one. */}
                  <button
                    type="button"
                    data-testid={`motion-cook-goto-${bone.childName}`}
                    onClick={() => useSelectionStore.getState().selectMany(bone.objectIds)}
                    className="truncate text-left underline decoration-dotted underline-offset-2 hover:text-fg"
                    title={`Select ${bone.childName}`}
                  >
                    {bone.childName}
                  </button>
                  <button
                    type="button"
                    data-testid={`motion-cook-follow-${bone.childName}`}
                    onClick={() =>
                      dispatchFollowClip(bone.targets, `Discard edit on ${bone.childName}`)
                    }
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-fg/80 hover:bg-muted hover:text-fg"
                  >
                    Discard edit
                  </button>
                </li>
              ),
            )}
          </ul>
          {/* THE BOUND, AND IT EXPANDS RATHER THAN TRUNCATES. Capping the rows
              without a way back would make the hidden bones unreachable — no
              per-bone discard, and nothing to press to go and look — leaving the
              bulk act as the only thing that could touch them, which is the
              destructive-choice-only failure this section just removed. */}
          {offer.stranded.length > STRANDED_ROWS_SHOWN ? (
            <button
              type="button"
              data-testid="motion-cook-stranded-more"
              onClick={() => setShowAll((v) => !v)}
              className="mt-0.5 text-[10px] text-fg/60 underline decoration-dotted hover:text-fg"
            >
              {showAll
                ? 'Show fewer'
                : `Show all ${offer.stranded.length} (${offer.stranded.length - STRANDED_ROWS_SHOWN} more)`}
            </button>
          ) : null}
          {/* #1004 — ONE ACT OVER THE SET THE CARD IS ALREADY SHOWING. Measured
              over two real cooks of a 78-bone character: 68 bones come back with
              their rotation moved, so a director who edited twenty strands close
              to twenty and gets twenty rows in a ~280px panel, each needing its
              own press.

              🔴 IT IS NOT `Clear baked motion` (#813), WHICH IS THE WRONG TOOL AND
              THE REASON THIS EXISTS. That clears the character's whole baked band
              — including the bones that are still CURRENT and still carrying edits
              the clip has not moved under. This reaches exactly the addresses under
              the names above, which `strandedBonesForClip` already filtered to the
              stale rows, so a current channel is not merely avoided here: it was
              never in the set. The label says the count so the act cannot be read
              as the bigger one.

              Only from two rows up. At one, the row's own button IS the bulk act,
              and a second button that does the same thing invites the reader to
              look for the difference. */}
          {offer.stranded.length > 1 ? (
            <button
              type="button"
              data-testid="motion-cook-follow-all"
              onClick={() =>
                dispatchFollowClip(
                  offer.stranded.flatMap((b) => b.targets),
                  `Discard edits on ${offer.stranded.length} bones`,
                )
              }
              className="mt-1 w-full rounded border border-border px-2 py-1 text-[10px] text-fg/80 hover:bg-muted hover:text-fg"
            >
              Discard all {offer.stranded.length} edits
            </button>
          ) : null}
          {/* THE LABEL SAYS WHAT IS LOST, IN THE OPEN AND NOT ON HOVER. The act
              deletes the keys the director authored on that bone; there is no
              road that keeps them (`dispatchFollowClip` records both
              measurements). A title attribute would put the only honest half of
              the sentence somewhere a touch device never shows. */}
          {/* 🔴 IT COUNTS FOR THE SAME REASON THE SENTENCE ABOVE DOES, and it did
              not until the bulk act was observed in pixels beside it: "that bone"
              had no referent once one press could drop keys on several. A line
              written for a per-row act reads as correct forever if nobody looks. */}
          <p className="mt-1 text-fg/40">
            {offer.stranded.length === 1
              ? 'Discarding drops the keys you authored on that bone and puts it back on the clip. Undo brings them back.'
              : 'Discarding drops the keys you authored on those bones and puts them back on the clip. Undo brings them back.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}
