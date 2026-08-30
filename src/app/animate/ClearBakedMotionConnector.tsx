// ClearBakedMotionConnector — the character-level "clear baked motion" affordance
// (#813, the way out #811 asked for).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────
// Dropping a second motion clip on a character that already carries one is
// refused, and the refusal tells the director to remove the existing baked
// channels first. Until now that instruction pointed at nothing at the character
// level: `RevertImportedClipConnector` offers the same act per BONE, so on a
// 22-bone rig the way out meant finding and clicking that button 22 times. This
// is the identical act at the granularity the refusal names.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IT OFFERS IS WHAT THE CLEAR WILL DELETE
// ─────────────────────────────────────────────────────────────────────────
// The button's visibility and the dispatch's op set BOTH come from
// `bakedChannelIdsForAssetRef` — one derivation, so the affordance cannot offer a
// clear that would do nothing, and cannot hide when there is motion to clear. The
// count is in the label for the same reason the bind toast carries one: "Clear
// baked motion" alone cannot be told from "clear 3 of 46 channels" until after
// the click.
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
//      src/app/asset/bindMotionToCharacter.ts (`selectedAssetRefs`); issues #813, #811.

import { useDagStore } from '../../core/dag/store';
import { useSelectionStore } from '../stores/selectionStore';
import { useNotificationStore } from '../stores/notificationStore';
import { bakedChannelIdsForAssetRef } from '../bakedGltfChannels';
import { labelForAssetRef, selectedAssetRefs } from '../asset/bindMotionToCharacter';
import { dispatchClearBakedMotion } from './dispatchMutator';

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
          notify({
            severity: 'success',
            message: `Cleared ${label}'s baked motion — drop a clip to animate it again.`,
          });
        }}
        className="w-full rounded border border-border px-2 py-1 text-[11px] text-fg/80 hover:bg-muted hover:text-fg"
        title="Delete this character's baked motion channels and restore the imported animation"
      >
        Clear baked motion ({bakedCount})
      </button>
    </div>
  );
}
