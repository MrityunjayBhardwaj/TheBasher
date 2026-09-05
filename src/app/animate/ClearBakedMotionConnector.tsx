// ClearBakedMotionConnector — the character-level "clear baked motion" affordance
// (#813, the way out #811 asked for).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS — AND IT IS NOT THE REASON IT WAS BUILT FOR
// ─────────────────────────────────────────────────────────────────────────
// Built for the second-clip refusal: dropping a second motion on a character
// that already carried one was refused, and the refusal told the director to
// remove the existing baked channels first — an instruction that, on a 22-bone
// rig, meant finding and clicking the per-bone revert 22 times.
//
// 🔑 THAT REFUSAL IS GONE (#889 slice 3). Binding no longer bakes, so a second
// bind has nothing to collide with and needs no way out. What survives is a
// DIFFERENT act with the same mechanism: the channels that remain are the ones
// a director authored, so this is "discard my edits on this character", not
// "clean up a bake". Same op set, same derivation, opposite meaning — which is
// why every word the button says had to change even though no logic did.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IT OFFERS IS WHAT THE CLEAR WILL DELETE
// ─────────────────────────────────────────────────────────────────────────
// The button's visibility and the dispatch's op set BOTH come from
// `bakedChannelIdsForAssetRef` — one derivation, so the affordance cannot offer a
// clear that would do nothing, and cannot hide when there is motion to clear. The
// count is in the label for the same reason the bind toast carries one: the label
// alone cannot be told from "clear 3 of 46 channels" until after the click.
//
// That single derivation is what kept this file correct through #889 without
// being touched: under copy-on-write a bound-but-unedited character has ZERO
// channels, so the "success that deleted nothing" branch in
// `dispatchClearBakedMotion` became the common case — and is unreachable here,
// because the button is not rendered at a count of zero.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IT SAYS, AND WHY THE OLD WORDING WAS THE OPPOSITE OF THE TRUTH
// ─────────────────────────────────────────────────────────────────────────
// It used to report "Cleared X's baked motion — drop a clip to animate it
// again." Under copy-on-write the character does NOT stop animating: every
// cleared bone falls back to the clip band and keeps moving, which is the whole
// point. So the director was told to go and fix something that was not broken,
// about a character they could watch still walking.
//
// It also has to say whose work is being destroyed. The old count was of a bake
// nobody authored and re-binding could regenerate; the new one is of the
// director's own edits, and nothing can bring them back but undo.
//
// The selection walk is the bind road's own (`selectedAssetRefs`), because the
// outliner selects the import GROUP, which carries no assetRef. Resolving the
// character differently here would let a director clear motion from one character
// while the drop road binds to another.
//
// V8: reads DAG state via SUBSCRIBED selectors (so the button appears on bind and
// disappears on clear) and mutates ONLY through the Op/mutator seam.
//
// REF: src/app/animate/dispatchMutator.ts (`dispatchClearBakedMotion`);
//      src/app/bakedGltfChannels.ts (`bakedChannelIdsForAssetRef` — the one
//        membership derivation, shared with the renderer's enumerator);
//      src/app/asset/bindMotionToCharacter.ts (`selectedAssetRefs`);
//      src/app/animate/dispatchMutator.ts (`dispatchRevertGltfChannel` — the same
//        act per bone, and per component since #909);
//      issues #813, #811, #889, #910.

import { useDagStore } from '../../core/dag/store';
import { useSelectionStore } from '../stores/selectionStore';
import { useNotificationStore } from '../stores/notificationStore';
import { bakedChannelIdsForAssetRef } from '../bakedGltfChannels';
import { labelForAssetRef, selectedAssetRefs } from '../asset/bindMotionToCharacter';
import { dispatchClearBakedMotion } from './dispatchMutator';

/**
 * The three strings, as pure functions of the count.
 *
 * Extracted so they can be gated. There is no component-rendering harness in
 * this suite, so a string written inline in JSX is asserted by nothing — and
 * these three are the entire user-visible meaning of the act. The wording went
 * wrong once already without a single test noticing: the message told the
 * director to drop a clip to animate the character again, on a character that
 * had never stopped animating (#910).
 */
export function discardLabel(count: number): string {
  return `Discard my edits (${count})`;
}

export function discardTitle(count: number): string {
  return (
    `Discard the ${count} channel${count === 1 ? '' : 's'} you have edited on this character. ` +
    'The character keeps animating — every bone returns to its clip.'
  );
}

export function discardedMessage(count: number, label: string): string {
  return (
    `Discarded ${count} edit${count === 1 ? '' : 's'} on ${label} — ` +
    'the character is back on its clip.'
  );
}

export function ClearBakedMotionConnector({ nodeId }: { nodeId: string }) {
  const selectedNodeId = useSelectionStore((s) => s.selectedNodeId);

  // The character this selection points at. Ambiguity (a selection reaching two
  // assets) offers nothing rather than guessing which one to strip — the same
  // stance the bind road takes when it cannot tell which character was meant.
  const assetRef = useDagStore((s) => {
    const refs = [...selectedAssetRefs(s.state, selectedNodeId ?? nodeId)];
    return refs.length === 1 ? refs[0] : null;
  });

  // Subscribed count: flips to 0 the frame the clear lands, so the button hides
  // itself exactly as the per-bone revert does.
  const bakedCount = useDagStore((s) =>
    assetRef ? (bakedChannelIdsForAssetRef(s.state.nodes, assetRef)?.length ?? 0) : 0,
  );

  if (!assetRef || bakedCount === 0) return null;
  const label = labelForAssetRef(assetRef);

  return (
    <div className="border-t border-border bg-muted/30 px-3 py-2">
      <button
        type="button"
        data-testid="clear-baked-motion"
        onClick={() => {
          const result = dispatchClearBakedMotion({ assetRef, label });
          const notify = useNotificationStore.getState().notify;
          if (!result.ok) {
            notify({ severity: 'warn', message: `Could not clear baked motion: ${result.reason}` });
            return;
          }
          notify({ severity: 'success', message: discardedMessage(bakedCount, label) });
        }}
        className="w-full rounded border border-border px-2 py-1 text-[11px] text-fg/80 hover:bg-muted hover:text-fg"
        title={discardTitle(bakedCount)}
      >
        {discardLabel(bakedCount)}
      </button>
    </div>
  );
}
