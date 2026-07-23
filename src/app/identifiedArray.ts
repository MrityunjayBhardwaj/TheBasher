// identifiedArray — the shared core of "stable ids on array elements" (epic #453).
//
// Some things a director selects and animates are not nodes — they are ELEMENTS of an
// array param: a curve's control points, a channel's keyframes, a glTF material's slots.
// Addressed by position, a reference silently names a different element the moment the
// array is inserted-into, deleted-from, reordered, or restored by undo. The fix is to give
// each element a stable `id` that travels with it, and to reference it by `(nodeId, id)`.
//
// This module owns ONLY the two things all three clients provably share: minting a fresh
// element id, and resolving an id back to its current index. The array MANIPULATION (a
// curve's midpoint insert and two-point floor, a channel's keyframe ordering) is
// client-specific and stays with each client — extracting it before a second client exists
// would be one function pretending to be a module.
//
// REF: docs/SUB-ELEMENT-IDENTITY-DESIGN.md ("The mechanism"); src/app/sceneNodeActions.ts
//      (freshId — the deterministic derive-and-scan precedent this mirrors).

/** The current index of the element with `id`, or `null` when no element has it (a stale
 *  reference — the point was deleted, the array was replaced). `null`, not `-1`, so a caller
 *  can never accidentally treat "absent" as a valid array index. */
export function findById<T extends { id: string }>(arr: readonly T[], id: string): number | null {
  const i = arr.findIndex((e) => e.id === id);
  return i === -1 ? null : i;
}

/** A fresh element id of the form `${prefix}${n}`, guaranteed absent from `taken`. Fills the
 *  lowest free slot (`['cp0','cp2'] → 'cp1'`), so the scheme is DETERMINISTIC and collision-free
 *  by construction — no `Math.random`/`crypto.randomUUID`. That determinism is what lets a
 *  migration mint ids for legacy elements and still produce a byte-identical golden every run. */
export function mintId(taken: Iterable<string>, prefix = 'e'): string {
  const used = taken instanceof Set ? taken : new Set(taken);
  let n = 0;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}
