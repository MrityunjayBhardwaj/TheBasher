// editorViewPersistence — persist the editor's free orbit-view pose per
// project to localStorage (#165 Wave E).
//
// Why localStorage and not the project file: the editor view is EDITOR state,
// not scene data — exactly how Blender treats the user viewport (stored with
// the screen/workspace, never part of the rendered scene). Persisting it as a
// UI projection keeps the DAG clean (V8/V1) while giving "reload → exactly the
// view I left." Keyed per project id so each project remembers its own view.
//
// Saved on orbit-end (Viewport.tsx), loaded at boot by EditorViewCamera which
// falls back to the active camera's pose when no view is stored (a fresh
// project, or a cleared cache) — byte-identical to the pre-Wave-E behavior.
//
// Defensive localStorage access mirrors chromeStore (happy-dom/test envs can
// stub Storage oddly; a quota/security error must never crash the viewport).

const PREFIX = 'basher.editorView.';

export interface EditorViewPose {
  position: [number, number, number];
  target: [number, number, number];
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

function isVec3(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** Load the saved view for a project, or null when none / malformed / no id. */
export function loadEditorView(projectId: string | null | undefined): EditorViewPose | null {
  if (!projectId) return null;
  const raw = safeGetItem(PREFIX + projectId);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      isVec3((parsed as EditorViewPose).position) &&
      isVec3((parsed as EditorViewPose).target)
    ) {
      return {
        position: (parsed as EditorViewPose).position,
        target: (parsed as EditorViewPose).target,
      };
    }
  } catch {
    // corrupt entry — treat as absent.
  }
  return null;
}

/** Save the view for a project. No-op when projectId is missing. */
export function saveEditorView(projectId: string | null | undefined, view: EditorViewPose): void {
  if (!projectId) return;
  if (!isVec3(view.position) || !isVec3(view.target)) return;
  safeSetItem(PREFIX + projectId, JSON.stringify(view));
}
