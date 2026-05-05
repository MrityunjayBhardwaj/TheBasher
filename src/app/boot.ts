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
  loadProject,
  saveProject,
  useProjectStore,
} from '../core/project';
import { pickStorage, type StorageCapability } from '../core/storage';
import { BrowserBlenderBridge, type BlenderBridgeCapability } from '../integrations/blender';
import { registerAllNodes } from '../nodes/registerAll';
import { seedAssetsIntoStorage } from './asset/seedOpfs';
import { useTimeStore } from './stores/timeStore';

let cachedStorage: StorageCapability | null = null;
let cachedBridge: BlenderBridgeCapability | null = null;

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
    const storage = await getStorage();

    // K1 step 2.5 — seed bundled sample assets into OPFS on first boot.
    // No-op on subsequent boots; failures are non-fatal (Library will mark
    // missing assets as unavailable rather than crash boot).
    try {
      await seedAssetsIntoStorage(storage);
    } catch (e) {
      console.warn('boot: asset seeding failed', e);
    }

    let project;
    try {
      project = await loadProject(storage, DEFAULT_PROJECT_ID);
    } catch {
      project = buildDefaultProject();
      // Persist immediately so subsequent reloads round-trip the same bytes
      // (acceptance #4).
      await saveProject(storage, project);
    }

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
