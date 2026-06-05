// Application boot sequence — K1 (THESIS.md §38, krama K1).
//
// Order is load-bearing. Re-shuffling these steps causes flashes (mode
// loaded after first render → snap), Canvas remounts (mode-conditional
// mounting — V8/K1 step 6), or stale eval state (DAG hydrated before its
// node types are registered).

import { Box3, Vector3 } from 'three';
import { evaluate as evaluateDag } from '../core/dag/evaluator';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import * as geometryRegistry from './geometryRegistry';
import { useDagStore } from '../core/dag/store';
import type { EvalCtx, NodeId, Op } from '../core/dag/types';
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
import { ingestGltfFolder, importGltfFromOpfs, type IngestFile } from './asset/importGltf';
import { ingestSingleFile } from './asset/importCommon';
import { routeImportByExtension } from './asset/importBvhFbx';
import { useTimeStore } from './stores/timeStore';
import { type NotifyInput, useNotificationStore } from './stores/notificationStore';

/**
 * The toast to raise for a resolved storage backend, or null when storage is
 * durable (#148). `memory` means the OPFS → IndexedDB chain BOTH failed, so
 * nothing survives a reload — warn the user, sticky (durationMs 0) so it can't
 * scroll past unnoticed. opfs/indexeddb/tauri-fs persist → no warning. Pure +
 * exported so the policy is unit-testable without booting.
 */
export function storageFallbackWarning(kind: StorageCapability['kind']): NotifyInput | null {
  if (kind === 'memory') {
    return {
      severity: 'warn',
      message: "Storage unavailable — your work won't be saved this session. Export to keep it.",
      durationMs: 0,
    };
  }
  return null;
}

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

    // #148 — if storage degraded all the way to Memory (OPFS + IndexedDB both
    // unavailable), nothing persists across reload. Tell the user instead of
    // silently losing their work on refresh.
    const fallbackWarning = storageFallbackWarning(storage.kind);
    if (fallbackWarning) useNotificationStore.getState().notify(fallbackWarning);

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
      // #168 render seam — render the production frame to a PNG data URL (no
      // download) so the falsifiable e2e can decode pixels and assert the
      // render isn't blank (H68) / is the right size / excludes chrome.
      void import('./renderImageAction').then((m) => {
        w.__basher_render_png = m.renderActiveProjectToDataUrl;
      });
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
      // P6 W3 — leftSidebarStore exposed so e2e can drive tab activation
      // without depending on visible chrome (the tab strip lands in C3;
      // until then this seam lets the C2 dev-loop verify persistence
      // round-trips programmatically — same pattern as __basher_chrome).
      void import('./stores/leftSidebarStore').then((m) => {
        w.__basher_left_sidebar = m.useLeftSidebarStore;
      });
      // P6 W4 — inspectorSectionsStore exposed so e2e can verify
      // per-node-type collapsed-state persistence without depending
      // on chrome visibility (NPanel's section chevrons live behind
      // chromeStore.inspectorCollapsed). K12 dev-seam pattern.
      void import('./stores/inspectorSectionsStore').then((m) => {
        w.__basher_inspector_sections = m.useInspectorSectionsStore;
      });
      // P6 W5 — timelineDockStore exposed so e2e can verify active-tab
      // persistence across reload (D-W5-2) and the no-auto-switch
      // invariant (D-W5-3) without depending on click coordinates.
      // K12 dev-seam pattern.
      void import('./stores/timelineDockStore').then((m) => {
        w.__basher_timeline_dock = m.useTimelineDockStore;
      });
      // P6 W9 — timelineSelection exposed so e2e can drive channel /
      // keyframe selection programmatically. The old SVG Dopesheet
      // exposed per-row `channel-row-{id}` + `keyframe-diamond-{id}-{i}`
      // testids that specs clicked to select; TimelineCanvas paints
      // those onto a 2D <canvas> (no per-row DOM, D-W9-4 forbids
      // pixel-diffing), so selection MUST route through this store
      // seam instead of click coordinates. H29 migration target —
      // same K12 dev-seam pattern as __basher_timeline_dock.
      void import('../timeline/timelineSelection').then((m) => {
        w.__basher_timeline_selection = m.useTimelineSelection;
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
          const { ops, skeletonId, clipId } = m.buildBvhImportOps({ text, name }, dag.state);
          dag.dispatchAtomic(ops, 'user', `import bvh: ${name ?? 'imported'}`);
          return { skeletonId, clipId };
        };
      });
      void import('../core/import/fbxImportChain').then((m) => {
        w.__basher_importFbx = (data: ArrayBuffer | string, name?: string) => {
          const dag = useDagStore.getState();
          const { ops, skeletonId, clipId } = m.buildFbxImportOps({ data, name }, dag.state);
          dag.dispatchAtomic(ops, 'user', `import fbx: ${name ?? 'imported'}`);
          return { skeletonId, clipId };
        };
      });
      // P7.5 — glTF TRS animation import seam (issue #81). Mirrors the
      // BVH/FBX seam shape; takes an ArrayBuffer + the assetRef the
      // GltfAsset should reference. The e2e fixture stages clips via
      // this entry point (H41 — fixtures via the NEW path from day one).
      void import('../core/import/gltfImportChain').then((m) => {
        w.__basher_importGltf = async (
          buffer: ArrayBuffer,
          assetRef: string,
          resolveBuffer?: (uri: string) => Promise<Uint8Array>,
        ) => {
          const dag = useDagStore.getState();
          const sceneRef = dag.state.outputs.scene;
          if (!sceneRef) throw new Error('__basher_importGltf: project has no `scene` output');
          // #90 — async: the importer resolves external/data-URI buffers.
          // `resolveBuffer` is optional (embedded GLB / data-URI need none).
          const result = await m.buildGltfImportOps(
            { buffer, assetRef, sceneNodeId: sceneRef.node, resolveBuffer },
            dag.state,
          );
          dag.dispatchAtomic(result.ops, 'user', `import gltf: ${assetRef}`);
          return {
            gltfAssetId: result.gltfAssetId,
            clipSelectId: result.clipSelectId,
            transformClipIds: result.transformClipIds,
          };
        };
      });
      // P7.9 Wave D Task 8 — real-path ingestion seam (issue #110). Drives
      // the SHARED core: ingestGltfFolder (disk → OPFS write) → then
      // importGltfFromOpfs (OPFS read → dispatchAtomic). Wave F e2e uses
      // this to exercise the full write→ingest→dispatch→render pipeline
      // (H41 — fixtures via the new path from day one, not a synthetic
      // shortcut). The existing __basher_importGltf seam above is left
      // intact — it is the P7.5/P7.6 fixture entry (Chesterton).
      w.__basher_ingestGltfFolder = async (
        files: ReadonlyArray<IngestFile>,
        folderName: string,
      ): Promise<string> => {
        const entryPath = await ingestGltfFolder(files, folderName);
        await importGltfFromOpfs(entryPath);
        return entryPath;
      };
      // Phase 7.14 (#111) — single-file BVH/FBX ingestion seams mirroring the
      // glTF one above. Drive the SHARED single-file core: ingestSingleFile
      // (bytes → user-imports/<name>/<name>.<ext>) → routeImportByExtension
      // (OPFS read → buildBvh/FbxImportOps → dispatchAtomic). The p7.14 e2e
      // uses these to exercise the full write→ingest→dispatch pipeline; the
      // existing text/data __basher_importBvh/Fbx seams above are left intact
      // (Chesterton — P3.1 fixtures use them, no OPFS round-trip).
      w.__basher_ingestBvhFile = async (bytes: Uint8Array, name: string): Promise<string> => {
        const entryPath = await ingestSingleFile({ relativePath: `${name}.bvh`, bytes }, name);
        await routeImportByExtension(entryPath);
        return entryPath;
      };
      w.__basher_ingestFbxFile = async (bytes: Uint8Array, name: string): Promise<string> => {
        const entryPath = await ingestSingleFile({ relativePath: `${name}.fbx`, bytes }, name);
        await routeImportByExtension(entryPath);
        return entryPath;
      };
      // P7.3 D-06 — autoKeyStore exposed so the gizmo-grab boundary spec
      // can drive Auto-Key ON/OFF without depending on the indicator
      // chrome (the spec asserts the grab re-route, not the toggle UI).
      // Same K12 dev-seam pattern as the other store exposures.
      void import('./stores/autoKeyStore').then((m) => {
        w.__basher_autokey = m.useAutoKeyStore;
      });
      // #149 — the transient-edit store exposed so the boundary-pair / 4-color
      // / clear-on-scrub specs can observe the held edit (the orange dirty
      // state) without depending on the inspector chrome. Same K12 dev-seam
      // pattern as __basher_autokey.
      void import('./stores/transientEditStore').then((m) => {
        w.__basher_transient = m.useTransientEditStore;
      });
      // Eval seam for E2E: evaluate any node at a given ctx.time without
      // round-tripping through the viewport. Returns { hash, value }.
      w.__basher_evaluate = (nodeId: NodeId, ctx?: EvalCtx) => {
        const state = useDagStore.getState().state;
        return evaluateDag(state, nodeId, { ctx });
      };
      // v0.6 #1 (Wave 3) — the H40 side-B seam: the EvaluatedMesh the read-side
      // surfaces consume (`resolveEvaluatedMesh`), so the boundary-pair e2e can
      // assert rendered scale (side A, __basher_mesh_world_scale) ==
      // resolver scale (side B, here) at the same ctx.time. Lazy import keeps
      // boot's static graph lean.
      w.__basher_evaluated_mesh = (nodeId: NodeId, ctx?: EvalCtx) => {
        const state = useDagStore.getState().state;
        const evalCtx: EvalCtx = ctx ?? { time: { frame: 0, seconds: 0, normalized: 0 } };
        return resolveEvaluatedMesh(state, nodeId, evalCtx);
      };
      // #149 (Wave C3/C4) — the H40 side-B seams for the transient overlay. The
      // boundary-pair e2e asserts the RESOLVER value (here) == the REAL rendered
      // object (__basher_mesh_world_position / scene-walk) == the typed transient,
      // PAUSED. Both delegate to the SAME overlayTransients the renderer uses, so
      // equality proves the read overlay == the render overlay (one band, two
      // callers). Read-only (V8 clean).
      w.__basher_evaluated_transform = (nodeId: NodeId, ctx?: EvalCtx) => {
        const state = useDagStore.getState().state;
        const evalCtx: EvalCtx = ctx ?? { time: { frame: 0, seconds: 0, normalized: 0 } };
        return resolveEvaluatedTransform(state, nodeId, evalCtx);
      };
      w.__basher_evaluated_param = (nodeId: NodeId, paramPath: string, ctx?: EvalCtx) => {
        const state = useDagStore.getState().state;
        const evalCtx: EvalCtx = ctx ?? { time: { frame: 0, seconds: 0, normalized: 0 } };
        return resolveEvaluatedParam(state, nodeId, paramPath, evalCtx);
      };
      // Phase 151 (Wave 2, SC-1/SC-2) — the H40 side-B seam for BakedMesh. Reads
      // the RESOLVER's geometry bounds: resolve the node → take its baked
      // GeometryRef → read the primed BufferGeometry from geometryRegistry (the
      // SAME instance BakedMeshR rendered) → return its local bbox dims. The
      // boundary-pair e2e asserts this == the rendered world bounds (side A,
      // __basher_mesh_world_bounds). Returns null on a registry miss (not yet
      // loaded) so the harness can wait for the suspense load to prime the cache.
      w.__basher_baked_geometry_bounds = (
        nodeId: NodeId,
        ctx?: EvalCtx,
      ): [number, number, number] | null => {
        const state = useDagStore.getState().state;
        const evalCtx: EvalCtx = ctx ?? { time: { frame: 0, seconds: 0, normalized: 0 } };
        const mesh = resolveEvaluatedMesh(state, nodeId, evalCtx);
        if (!mesh || mesh.geometry.kind !== 'baked') return null;
        const geom = geometryRegistry.get(mesh.geometry);
        if (!geom) return null; // registry miss — geometry not yet primed
        geom.computeBoundingBox();
        const box = geom.boundingBox;
        if (!box) return null;
        const size = new Vector3();
        new Box3(box.min, box.max).getSize(size);
        return [size.x, size.y, size.z];
      };
      // Perf scene-scale stress seam (issue #114). Dispatches `meshes`
      // SphereMesh nodes at `segments` tessellation in a compact grid (kept
      // near origin so they stay inside the default camera frustum — culled
      // meshes would under-report GPU load), all wired to the Scene's
      // `children` socket in ONE dispatchAtomic. Returns the seeded ids so the
      // harness can drive an edit-churn setParam + clear between levels.
      // Triangle count is read off renderer.info via the frame profiler, not
      // estimated here. Pure additive scene seeding — no production caller.
      w.__basher_perf_stress = (opts: { meshes: number; segments?: number }) => {
        const dag = useDagStore.getState();
        const sceneRef = dag.state.outputs.scene;
        if (!sceneRef) throw new Error('__basher_perf_stress: project has no `scene` output');
        const sceneId = sceneRef.node;
        const segments = Math.max(3, opts.segments ?? 24);
        const n = Math.max(0, Math.floor(opts.meshes));
        const side = Math.max(1, Math.ceil(Math.cbrt(n)));
        const spacing = 0.9;
        const offset = ((side - 1) * spacing) / 2;
        const ids: string[] = [];
        const ops: Op[] = [];
        for (let i = 0; i < n; i++) {
          const id = `perfstress_${i}`;
          ids.push(id);
          const gx = i % side;
          const gy = Math.floor(i / side) % side;
          const gz = Math.floor(i / (side * side));
          ops.push({
            type: 'addNode',
            nodeId: id,
            nodeType: 'SphereMesh',
            params: {
              radius: 0.3,
              widthSegments: segments,
              heightSegments: segments,
              position: [gx * spacing - offset, gy * spacing - offset, gz * spacing - offset],
              rotation: [0, 0, 0],
              material: { name: 'default', color: '#88aaff' },
            },
          });
          ops.push({
            type: 'connect',
            from: { node: id, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          });
        }
        dag.dispatchAtomic(ops, 'user', `perf-stress: ${n} spheres @ ${segments}seg`);
        w.__basher_perf_stress_ids = ids;
        return { meshCount: n, segments, sceneId, firstMeshId: ids[0] ?? null };
      };
      // Remove the seeded stress meshes, restoring a clean scene between
      // harness levels. removeNode throws while a node is still consumed
      // (ops.ts applyRemoveNode), so each mesh is DISCONNECTED from the Scene
      // `children` socket before removal — disconnects first, then removes, all
      // in ONE dispatchAtomic (= one undo).
      w.__basher_perf_clear = () => {
        const dag = useDagStore.getState();
        const ids = (w.__basher_perf_stress_ids as string[] | undefined) ?? [];
        if (ids.length === 0) return 0;
        const sceneRef = dag.state.outputs.scene;
        const sceneId = sceneRef?.node;
        const ops: Op[] = [];
        if (sceneId) {
          for (const id of ids) {
            ops.push({
              type: 'disconnect',
              from: { node: id, socket: 'out' },
              to: { node: sceneId, socket: 'children' },
            });
          }
        }
        for (const id of ids) ops.push({ type: 'removeNode', nodeId: id });
        dag.dispatchAtomic(ops, 'user', `perf-stress clear: ${ids.length}`);
        w.__basher_perf_stress_ids = [];
        return ids.length;
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
