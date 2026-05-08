// Application boot sequence — K1 (THESIS.md §38, krama K1).
//
// Order is load-bearing. Re-shuffling these steps causes flashes (mode
// loaded after first render → snap), Canvas remounts (mode-conditional
// mounting — V8/K1 step 6), or stale eval state (DAG hydrated before its
// node types are registered).

import { evaluate as evaluateDag } from '../core/dag/evaluator';
import { useDagStore } from '../core/dag/store';
import type { EvalCtx, NodeId } from '../core/dag/types';
import {
  buildDefaultDagState,
  buildDefaultProject,
  composeProject,
  DEFAULT_PROJECT_ID,
  deleteProject as ioDeleteProject,
  duplicateProject as ioDuplicateProject,
  listProjectMetadata,
  loadProject,
  renameProject as ioRenameProject,
  saveProject,
  useProjectStore,
  type ProjectMetadata,
} from '../core/project';
import { pickStorage, type StorageCapability } from '../core/storage';
import { BrowserBlenderBridge, type BlenderBridgeCapability } from '../integrations/blender';
import { registerAllNodes } from '../nodes/registerAll';
import { registerAllTools } from '../agent/tools';
import { registerAllMutators } from '../agent/mutators';
import { registerAllStrategies } from '../agent/strategy';
import { seedAssetsIntoStorage } from './asset/seedOpfs';
import { useTimeStore } from './stores/timeStore';

let cachedStorage: StorageCapability | null = null;
let cachedBridge: BlenderBridgeCapability | null = null;

const LAST_PROJECT_KEY = 'basher.lastProjectId';

function persistLastProjectId(id: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    /* storage unavailable in privacy mode — non-fatal */
  }
}

export async function getStorage(): Promise<StorageCapability> {
  if (!cachedStorage) cachedStorage = await pickStorage();
  return cachedStorage;
}

export function getBlenderBridge(): BlenderBridgeCapability {
  if (!cachedBridge) cachedBridge = new BrowserBlenderBridge();
  return cachedBridge;
}

/**
 * Run the boot sequence. Returns once the DAG store and project store are
 * populated and the React shell is safe to render.
 *
 * Steps (K1 1-3): registry → load-or-default → hydrate stores. Steps 4-10
 * (mount React, Canvas, beacon) belong to the calling component tree.
 *
 * StrictMode-safe: React 18+ in dev mounts effects twice. Without the shared
 * promise guard, the second mount would re-run loadProject + saveProject
 * after the first hydrate has populated the store — wasted I/O at best, an
 * OPFS write race at worst. Cached promise: every concurrent caller awaits
 * the same in-flight boot.
 */
let bootPromise: Promise<void> | null = null;

export function boot(): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    registerAllNodes();
    registerAllTools();
    registerAllMutators();
    registerAllStrategies();
    const storage = await getStorage();

    // K1 step 2.5 — seed bundled sample assets into OPFS on first boot.
    // No-op on subsequent boots; failures are non-fatal (Library will mark
    // missing assets as unavailable rather than crash boot).
    try {
      await seedAssetsIntoStorage(storage);
    } catch (e) {
      console.warn('boot: asset seeding failed', e);
    }

    // Resolve which project to open. Priority:
    //   1. Last-open project id from localStorage (if it still exists in storage).
    //   2. Default project id (creates the seed project if absent).
    const lastId =
      typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_PROJECT_KEY) : null;
    let project;
    try {
      project = await loadProject(storage, lastId ?? DEFAULT_PROJECT_ID);
    } catch {
      project = buildDefaultProject();
      await saveProject(storage, project);
    }

    persistLastProjectId(project.id);
    useProjectStore.getState().setCurrent(project);
    useDagStore.getState().hydrate({
      nodes: project.state.nodes,
      outputs: project.state.outputs,
    });

    // Test affordance — expose the stores in dev only. Production builds
    // strip this branch (Vite tree-shakes `if (false)`). E2E tests use
    // these to drive scenarios that native HTML5 D&D would make brittle.
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__basher_dag = useDagStore;
      w.__basher_time = useTimeStore;
      // Lazy import (top-level cycle would tangle stores into boot's
      // dependency graph). The dynamic import is sync-resolved by Vite at
      // build time; only the shape is needed here.
      void import('./stores/editorStore').then((m) => {
        w.__basher_editor = m.useEditorStore;
      });
      void import('./stores/viewportStore').then((m) => {
        w.__basher_viewport = m.useViewportStore;
      });
      void import('./stores/selectionStore').then((m) => {
        w.__basher_selection = m.useSelectionStore;
      });
      // Agent session store — used by E2E to verify chat UI layout.
      void import('../agent/session/store').then((m) => {
        w.__basher_agent_session = m.useAgentSessionStore;
      });
      // Diff store — P3 Wave D e2e drives propose() to verify the DiffBar
      // surface (time-range indicator, scope, warnings) without an LLM round.
      void import('../agent/diff').then((m) => {
        w.__basher_diff = m.useDiffStore;
      });
      // Eval seam for E2E: evaluate any node at a given ctx.time without
      // round-tripping through the viewport. Returns { hash, value }.
      w.__basher_evaluate = (nodeId: NodeId, ctx?: EvalCtx) => {
        const state = useDagStore.getState().state;
        return evaluateDag(state, nodeId, { ctx });
      };
    }

    // K1 step 9 — bridge polls only in dev (impl no-ops when DEV is false).
    getBlenderBridge().start();
  })();
  return bootPromise;
}

/** Test-only: forget the cached boot so the next boot() runs fresh. */
export function __resetBootForTests(): void {
  bootPromise = null;
}

export async function saveCurrent(): Promise<void> {
  const storage = await getStorage();
  const dag = useDagStore.getState().state;
  const meta = useProjectStore.getState().current;
  if (!meta) return;
  const project = composeProject({
    id: meta.id,
    name: meta.name,
    state: dag,
    createdAt: meta.createdAt,
    updatedAt: Date.now(),
  });
  await saveProject(storage, project);
  useProjectStore.getState().setCurrent(project);
}

/** Tests / dev only — replaces the persisted project with a fresh default. */
export async function resetProjectForDev(): Promise<void> {
  const storage = await getStorage();
  await saveProject(storage, buildDefaultProject());
  useDagStore.getState().hydrate(buildDefaultDagState());
}

// ---------------------------------------------------------------------------
// Multi-project API — list / switch / new / delete / duplicate / rename.
//
// All ops touch the StorageCapability (V6) and re-hydrate `useDagStore` +
// `useProjectStore` on switch. The "current project id" is persisted in
// localStorage so a reload reopens the user's working project.
// ---------------------------------------------------------------------------

export async function listAllProjectMetadata(): Promise<ProjectMetadata[]> {
  const storage = await getStorage();
  return listProjectMetadata(storage);
}

/** Save current DAG to its project, then load + hydrate the target project. */
export async function switchProject(projectId: string): Promise<void> {
  const storage = await getStorage();
  // Auto-save the project we're leaving so unsaved DAG edits aren't lost.
  await saveCurrent();
  const project = await loadProject(storage, projectId);
  persistLastProjectId(project.id);
  useProjectStore.getState().setCurrent(project);
  useDagStore.getState().hydrate({
    nodes: project.state.nodes,
    outputs: project.state.outputs,
  });
}

/** Create a fresh default project under a new id and switch to it. */
export async function createNewProject(name: string, id?: string): Promise<string> {
  const storage = await getStorage();
  // Auto-save the outgoing project before swapping.
  await saveCurrent();
  const newId = id ?? `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const seed = buildDefaultProject();
  const now = Date.now();
  const project = { ...seed, id: newId, name, createdAt: now, updatedAt: now };
  await saveProject(storage, project);
  persistLastProjectId(project.id);
  useProjectStore.getState().setCurrent(project);
  useDagStore.getState().hydrate({
    nodes: project.state.nodes,
    outputs: project.state.outputs,
  });
  return newId;
}

export async function deleteProject(projectId: string): Promise<void> {
  const storage = await getStorage();
  await ioDeleteProject(storage, projectId);
  // If we just deleted the open project, fall back to the next available
  // project — or seed a fresh default if storage is now empty.
  const current = useProjectStore.getState().current;
  if (current?.id === projectId) {
    const remaining = await listProjectMetadata(storage);
    if (remaining.length > 0) {
      await switchProject(remaining[0].id);
    } else {
      const seed = buildDefaultProject();
      await saveProject(storage, seed);
      persistLastProjectId(seed.id);
      useProjectStore.getState().setCurrent(seed);
      useDagStore.getState().hydrate({
        nodes: seed.state.nodes,
        outputs: seed.state.outputs,
      });
    }
  }
}

export async function duplicateCurrentProject(newName?: string): Promise<string> {
  const storage = await getStorage();
  const current = useProjectStore.getState().current;
  if (!current) throw new Error('duplicateCurrentProject: no project open');
  // Save first so the duplicate captures the latest in-memory edits.
  await saveCurrent();
  const newId = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const dup = await ioDuplicateProject(storage, current.id, newId, newName);
  // Switch to the duplicate.
  persistLastProjectId(dup.id);
  useProjectStore.getState().setCurrent(dup);
  useDagStore.getState().hydrate({
    nodes: dup.state.nodes,
    outputs: dup.state.outputs,
  });
  return newId;
}

export async function renameCurrentProject(newName: string): Promise<void> {
  const storage = await getStorage();
  const current = useProjectStore.getState().current;
  if (!current) return;
  // Persist current edits first, then rename — keeps name change atomic with
  // the latest DAG content.
  await saveCurrent();
  const renamed = await ioRenameProject(storage, current.id, newName);
  useProjectStore.getState().setCurrent(renamed);
}
