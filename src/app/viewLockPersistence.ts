// viewLockPersistence — remember which character the view is locked to, per
// project, across a reload (#985).
//
// #856 reported two things and the lock answered one: "the only reliable
// framing is manual, and IT HAS TO BE REDONE ON EVERY RELOAD." A lock that
// vanishes with the session leaves the second half standing — lock onto a
// character, reload, press play, and watch it walk off screen again.
//
// Why localStorage and per project, like its two neighbours
// (`editorViewPersistence`, `viewportClipPersistence`): this is EDITOR state,
// not scene data. Blender agrees and is the reason the shape is not in doubt —
// `View3D.lock_object` / `lock_bone` live in the space data and are saved with
// the .blend, never in the rendered scene.
//
// 🔴 PER PROJECT IS NOT A CONVENIENCE. The stored value is a NODE ID, and a node
// id means nothing outside the project it was taken in. A single global key
// would restore a lock naming a node another project happens to share the id
// of, which is a wrong answer that resolves and looks right.
//
// WHAT IS NOT VALIDATED HERE, ON PURPOSE. Whether the node still exists is not
// asked at load time: the DAG is hydrated before this runs today, but a load
// that guessed wrong would clear a good lock AND persist the clearing, and the
// applier in `EditorViewCamera` already answers the same question every frame
// against the live graph. One guard, on the live state, is the whole lesson of
// this issue's first half — see `canToggleViewLock`.
//
// Defensive localStorage access mirrors the two neighbours: happy-dom and
// private-mode browsers can stub or throw from Storage, and persistence is
// best-effort — it must never crash the viewport.

import type { ViewLock } from './stores/viewportStore';

const PREFIX = 'basher.viewLock.';

function safeGetItem(key: string): string | null {
  try {
    if (typeof localStorage?.getItem !== 'function') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    if (typeof localStorage?.setItem !== 'function') return;
    localStorage.setItem(key, value);
  } catch {
    // quota / security / private-mode — persistence is best-effort.
  }
}

function safeRemoveItem(key: string): void {
  try {
    if (typeof localStorage?.removeItem !== 'function') return;
    localStorage.removeItem(key);
  } catch {
    // as above.
  }
}

/**
 * The saved lock for a project, or null when there is none, the entry is
 * malformed, or there is no project.
 *
 * `boneName` is spelled as the live three.js tree spells it. That survives a
 * reload of the same asset and does NOT survive swapping the asset underneath
 * it — which needs no handling here, because `followPoint` falls through a
 * missing bone to the rig's own centre and then to the object. A stale bone
 * name degrades to following the character, never to following nothing.
 */
export function loadViewLock(projectId: string | null | undefined): ViewLock | null {
  if (!projectId) return null;
  const raw = safeGetItem(PREFIX + projectId);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const { nodeId, boneName } = parsed as { nodeId?: unknown; boneName?: unknown };
    if (typeof nodeId !== 'string' || nodeId === '') return null;
    // An absent bone and a null bone mean the same thing — follow the rig — so
    // both are accepted. Anything else is a malformed entry, and a bad bone name
    // restored as a string would be silently unfindable rather than absent.
    if (boneName !== null && boneName !== undefined && typeof boneName !== 'string') return null;
    return { nodeId, boneName: typeof boneName === 'string' && boneName !== '' ? boneName : null };
  } catch {
    return null;
  }
}

/**
 * Save the lock for a project. `null` REMOVES the entry rather than writing a
 * null: releasing the lock and never having taken one are the same state on
 * reload, and a stored `null` would only be a second spelling of absent.
 */
export function saveViewLock(projectId: string | null | undefined, lock: ViewLock | null): void {
  if (!projectId) return;
  if (!lock) {
    safeRemoveItem(PREFIX + projectId);
    return;
  }
  safeSetItem(PREFIX + projectId, JSON.stringify({ nodeId: lock.nodeId, boneName: lock.boneName }));
}
