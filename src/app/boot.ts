// Application boot sequence — K1 (THESIS.md §38, krama K1).
//
// Order is load-bearing. Re-shuffling these steps causes flashes (mode
// loaded after first render → snap), Canvas remounts (mode-conditional
// mounting — V8/K1 step 6), or stale eval state (DAG hydrated before its
// node types are registered).

import { useDagStore } from '../core/dag/store';
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
import { registerAllNodes } from '../nodes/registerAll';

let cachedStorage: StorageCapability | null = null;

export async function getStorage(): Promise<StorageCapability> {
  if (!cachedStorage) cachedStorage = await pickStorage();
  return cachedStorage;
}

/**
 * Run the boot sequence. Returns once the DAG store and project store are
 * populated and the React shell is safe to render.
 *
 * Steps (K1 1-3): registry → load-or-default → hydrate stores. Steps 4-10
 * (mount React, Canvas, beacon) belong to the calling component tree.
 */
export async function boot(): Promise<void> {
  registerAllNodes();
  const storage = await getStorage();

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
