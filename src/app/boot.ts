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
import { pickComfyUI, type ComfyUICapability } from '../core/comfy';
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
let cachedComfyUI: ComfyUICapability | null = null;
let comfyUIPromise: Promise<ComfyUICapability> | null = null;

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
 * Resolve the ComfyUI capability for this runtime — Http if a server is
 * reachable at the configured URL, Stub otherwise. Cached: a single resolve
 * across the whole session, so dryRun + runWorkflow + agent tools share one
 * instance (their in-flight tracking lives outside the capability).
 *
 * The promise guard mirrors `boot()` — concurrent first-time callers await
 * the same in-flight pickComfyUI() instead of racing two HTTP probes.
 */
export function getComfyCapability(): Promise<ComfyUICapability> {
  if (cachedComfyUI) return Promise.resolve(cachedComfyUI);
  if (!comfyUIPromise) {
    comfyUIPromise = pickComfyUI().then((cap) => {
      cachedComfyUI = cap;
      return cap;
    });
  }
  return comfyUIPromise;
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

    // P6 W3 — dirty tracking subscription. Registered AFTER hydrate so the
    // initial state install does NOT mark the project dirty. Fires on every
    // subsequent dag-state transition (Op dispatch via K2). hydrate() in
    // switchProject/createNewProject/duplicateCurrentProject also triggers
    // this — but those paths call setCurrent() right before, which resets
    // dirty=false and lastSavedAt=updatedAt; the subscription then re-flips
    // dirty=true once if the hydrate produced an object-identity change.
    // To avoid that single false-positive, switchProject/createNewProject/
    // duplicateCurrentProject reset dirty AFTER hydrate (see those funcs).
    let prevDagState = useDagStore.getState().state;
    useDagStore.subscribe((s) => {
      if (s.state === prevDagState) return;
      prevDagState = s.state;
      useProjectStore.getState().markDirty();
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
      // P6 W2.6 — chromeStore exposed so e2e can drive panel collapse
      // state without depending on the order of click-to-toggle tests.
      // SceneTree default-collapsed (leftSidebarCollapsed=true) means
      // tests that need to interact with tree rows must explicitly
      // expand first; programmatic setLeftSidebarCollapsed(false) is
      // less brittle than clicking the chevron.
      void import('./stores/chromeStore').then((m) => {
        w.__basher_chrome = m.useChromeStore;
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
      // P5 Wave C5 — install StubComfyUICapability for e2e tests so the
      // CostPreview spec doesn't depend on a running ComfyUI server. The
      // setter swaps the boot cache; subsequent getComfyCapability() calls
      // resolve to the stub.
      void import('../core/comfy').then((m) => {
        w.__basher_useStubComfy = () => {
          __setComfyCapabilityForTests(new m.StubComfyUICapability());
        };
      });
      // P5 Wave C5 — minimal OPFS write seam so the CostPreview spec can
      // pre-populate fake raw-pass bytes (beauty/depth/normal) at the
      // D-04 paths the stylizedRealism preset reads. Production agents
      // never call this — runRenderJob produces the real bytes.
      w.__basher_writeOpfsBytes = async (path: string, bytes: Uint8Array) => {
        const storage = await getStorage();
        await storage.write(path, bytes);
      };
      // P3.1 Wave A/B — BVH + FBX import demo seams. Library UI
      // integration lands in a follow-on wave; meanwhile the agent
      // (and console) can drive imports via these seams.
      void import('../core/import/bvhImportChain').then((m) => {
        w.__basher_importBvh = (text: string, name?: string) => {
          const dag = useDagStore.getState();
          const { ops, skeletonId, clipId } = m.buildBvhImportOps(
            { text, name },
            dag.state,
          );
          dag.dispatchAtomic(ops, 'user', `import bvh: ${name ?? 'imported'}`);
          return { skeletonId, clipId };
        };
      });
      void import('../core/import/fbxImportChain').then((m) => {
        w.__basher_importFbx = (data: ArrayBuffer | string, name?: string) => {
          const dag = useDagStore.getState();
          const { ops, skeletonId, clipId } = m.buildFbxImportOps(
            { data, name },
            dag.state,
          );
          dag.dispatchAtomic(ops, 'user', `import fbx: ${name ?? 'imported'}`);
          return { skeletonId, clipId };
        };
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
  cachedComfyUI = null;
  comfyUIPromise = null;
}

/**
 * Test-only: inject a ComfyUI capability so component tests can hit a
 * deterministic stub without going through pickComfyUI's HTTP probe.
 */
export function __setComfyCapabilityForTests(cap: ComfyUICapability | null): void {
  cachedComfyUI = cap;
  comfyUIPromise = cap ? Promise.resolve(cap) : null;
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
  // P6 W3 — setCurrent resets dirty/lastSavedAt from project.updatedAt, which
  // is consistent here (just-written timestamp). markSaved() is a no-op pair
  // for clarity at this seam — the explicit name makes the intent visible
  // to future readers / dharana audits.
  useProjectStore.getState().markSaved();
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
  // P6 W3 — hydrate triggers the dirty subscription. Re-run setCurrent
  // semantics (dirty=false, lastSavedAt=project.updatedAt) so the freshly
  // loaded project doesn't appear unsaved.
  useProjectStore.getState().setCurrent(project);
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
  // P6 W3 — clear dirty caused by hydrate (see switchProject).
  useProjectStore.getState().setCurrent(project);
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
      // P6 W3 — clear dirty caused by hydrate (see switchProject).
      useProjectStore.getState().setCurrent(seed);
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
  // P6 W3 — clear dirty caused by hydrate (see switchProject).
  useProjectStore.getState().setCurrent(dup);
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
