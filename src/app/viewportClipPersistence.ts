// viewportClipPersistence — persist the editor's manual VIEWPORT clip override
// per project to localStorage (#192).
//
// Why localStorage and not the project file: like the editor orbit-view pose
// (editorViewPersistence) this is EDITOR state, not scene data — Blender keeps
// View ▸ Clip Start/End with the viewport/workspace, never in the rendered
// scene. It is viewport-only and must NOT touch the scene camera node's
// near/far (that drives the render + look-through). Keyed per project so each
// project remembers its own override; absence means AUTO (bounds-fit, #186/#191).
//
// Saved by the View-menu Clipping handler (MenuBar), hydrated on project change
// by EditorViewCamera into `viewportStore.viewportClipOverride`.
//
// Defensive localStorage access mirrors editorViewPersistence (happy-dom/test
// envs can stub Storage oddly; a quota/security error must never crash boot).

import { normalizeViewportClip } from './stores/viewportStore';

const PREFIX = 'basher.viewportClip.';

export interface ViewportClip {
  near: number;
  far: number;
}

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
    // best-effort.
  }
}

/** Load the saved clip override for a project, or null when none / malformed /
 *  no id (null = AUTO). Validated through `normalizeViewportClip` so a corrupt
 *  or degenerate stored pair degrades to AUTO rather than a broken frustum. */
export function loadViewportClip(projectId: string | null | undefined): ViewportClip | null {
  if (!projectId) return null;
  const raw = safeGetItem(PREFIX + projectId);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      return normalizeViewportClip(parsed as { near: number; far: number });
    }
  } catch {
    // corrupt entry — treat as absent (AUTO).
  }
  return null;
}

/** Save (or, with `null`, CLEAR back to AUTO) the clip override for a project.
 *  No-op when projectId is missing. An invalid clip clears the entry. */
export function saveViewportClip(
  projectId: string | null | undefined,
  clip: ViewportClip | null,
): void {
  if (!projectId) return;
  const valid = normalizeViewportClip(clip);
  if (!valid) {
    safeRemoveItem(PREFIX + projectId);
    return;
  }
  safeSetItem(PREFIX + projectId, JSON.stringify(valid));
}
