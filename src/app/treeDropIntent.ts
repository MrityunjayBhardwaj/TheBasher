// treeDropIntent — what a drop on an outliner row MEANS, from where on the row it lands.
//
// WHY ZONES (#1152). A row used to be either a parent or a leaf, and the gesture followed: a drop
// onto a Group parented into it, a drop onto a leaf sibling reordered. An Object can parent now, so
// most rows are both a possible parent and a possible sibling, and one gesture cannot mean both.
// Blender's outliner splits a drop the same way — into the row, or before/after it — and the row
// shows which one the pointer is over. (User decision, 2026-09-22.)
//
// THE RULE:
//   - the MIDDLE of a row that can hold the dragged node parents into it;
//   - the TOP or BOTTOM edge reorders before/after it when the two are siblings;
//   - an edge of a row the node cannot sit beside (a different parent) still parents, as any drop
//     on a parent row did before — there is no sibling order to change there;
//   - a row that cannot hold anything (a leaf) reorders from anywhere on it, as it always did; its
//     bottom edge places AFTER it, which the old single-meaning drop could not do.
//
// Pure, so the rule is unit-tested without a DOM; SceneTree asks it on dragover (to draw the
// indicator) and on drop (to act), so what is shown is what happens.

/** Where on the row the pointer is. */
export type DropZone = 'before' | 'into' | 'after';

/** What the drop will do. `null` — nothing here accepts it. */
export type DropIntent =
  | { readonly kind: 'parent' }
  | { readonly kind: 'reorder'; readonly place: 'before' | 'after' }
  | null;

/** The top and bottom quarter of a row are its edges; the middle half is "into". */
export const EDGE_FRACTION = 0.25;

/** The zone a pointer at `clientY` is in, over a row spanning `top`..`top + height`. */
export function dropZoneAt(clientY: number, top: number, height: number): DropZone {
  if (!(height > 0)) return 'into';
  const f = (clientY - top) / height;
  if (f < EDGE_FRACTION) return 'before';
  if (f > 1 - EDGE_FRACTION) return 'after';
  return 'into';
}

/**
 * The intent of a drop in `zone`, given what the target row allows: `canParent` — the dragged node
 * may be moved INTO this row; `canReorder` — the two are siblings on one list.
 */
export function dropIntent(
  zone: DropZone,
  allows: { readonly canParent: boolean; readonly canReorder: boolean },
): DropIntent {
  const { canParent, canReorder } = allows;
  if (canParent && (zone === 'into' || !canReorder)) return { kind: 'parent' };
  if (canReorder) return { kind: 'reorder', place: zone === 'after' ? 'after' : 'before' };
  return null;
}

/**
 * The index the dragged node is connected at, for a reorder on one list: `from` is its index now,
 * `at` the target's. The disconnect shifts everything after `from` left by one, so an insertion
 * point past it is one lower. `null` when the node would land where it already is.
 */
export function reorderIndex(from: number, at: number, place: 'before' | 'after'): number | null {
  const insertAt = place === 'after' ? at + 1 : at;
  const index = insertAt > from ? insertAt - 1 : insertAt;
  return index === from ? null : index;
}
