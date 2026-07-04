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
import { resolveWorldTransform } from './resolveWorldTransform';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { resolveMeshUVs } from './resolveMeshUVs';
import { resolveMeshTexture } from './resolveMeshTexture';
import { unionUVBounds } from './uvIslands';
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
  listProjects,
  loadProject,
  renameProject as ioRenameProject,
  saveProject,
  useProjectStore,
  type ProjectMetadata,
} from '../core/project';
import { buildExampleProject, EXAMPLE_PROJECT_IDS } from '../core/project/examples';
import { useRouteStore } from './stores/routeStore';
import { useSettingsStore } from './stores/settingsStore';
import { pickComfyUI, type ComfyUICapability } from '../core/comfy';
import { pickStorage, type StorageCapability } from '../core/storage';
import { BrowserBlenderBridge, type BlenderBridgeCapability } from '../integrations/blender';
import { registerAllNodes } from '../nodes/registerAll';
import { registerAllTools } from '../agent/tools';
import { registerAllMutators } from '../agent/mutators';
import { registerAllStrategies } from '../agent/strategy';
import { seedAssetsIntoStorage } from './asset/seedOpfs';
import { type IngestFile } from './asset/importGltf';
import { ingestAndImportGltf } from './asset/gltfEntryChoice';
import { ingestSingleFile } from './asset/importCommon';
import { routeImportByExtension } from './asset/importBvhFbx';
import { useTimeStore } from './stores/timeStore';
import { type NotifyInput, useNotificationStore } from './stores/notificationStore';
import {
  SCENE_BUNDLE_VERSION,
  bundleToProject,
  bytesToBase64,
  base64ToBytes,
  collectAssetRefs,
  resolveAssetFiles,
  type SceneBundle,
} from './sceneBundle';
import { PROJECT_FORMAT_VERSION } from '../core/project/schema';

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

// #255 — idle-debounce before an autosave fires (ms after the last DAG edit).
const AUTOSAVE_IDLE_MS = 10_000;

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
    // ComfyUI Inc 2 — target the configured server (settings store), not the
    // hardcoded default; an empty auth header means none. The session cache is
    // reset by resetComfyCapability() when the user changes the settings.
    const { comfyUrl, comfyAuthHeader } = useSettingsStore.getState();
    comfyUIPromise = pickComfyUI(comfyUrl, { authHeader: comfyAuthHeader || undefined }).then(
      (cap) => {
        cachedComfyUI = cap;
        return cap;
      },
    );
  }
  return comfyUIPromise;
}

/** Forget the cached ComfyUI capability so the next getComfyCapability() re-probes
 *  the (possibly changed) configured URL/auth. Called when the user saves new
 *  ComfyUI connection settings — the session cache would otherwise pin the old
 *  server for the whole session. */
export function resetComfyCapability(): void {
  cachedComfyUI = null;
  comfyUIPromise = null;
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

    // W4-T1 (D-W4-SEED) — seed the curated example projects, idempotently.
    // Runs AFTER asset seeding (an example could reference a seeded asset; ours
    // use pure primitives so there is no dependency) and BEFORE project
    // resolution so the examples are listable on the home. Only writes an
    // example id that is ABSENT — a user who opened + edited an example keeps
    // their edits across reloads (re-seeding never clobbers them).
    try {
      const existing = new Set(await listProjects(storage));
      for (const id of EXAMPLE_PROJECT_IDS) {
        if (existing.has(id)) continue;
        await saveProject(storage, buildExampleProject(id));
      }
    } catch (e) {
      console.warn('boot: example seeding failed', e);
    }

    // P6 W3 — dirty tracking subscription. Registered ONCE per boot regardless
    // of route (a project opened from the home later must still track dirty).
    // Installed AFTER hydrate on the resume path so the initial install does
    // NOT mark dirty. On a first-run home boot the store is empty and the
    // subscription stays quiet until the user opens a project via
    // switchProject/createNewProject — both of which reset dirty AFTER their
    // hydrate (see those funcs), absorbing the one false-positive.
    // #255 — idle-debounced AUTOSAVE. Manual save alone loses a crash's worth of
    // work; the beforeunload guard catches close/reload but not a crash/kill. A
    // trailing debounce (save AUTOSAVE_IDLE_MS after the last edit settles) gives
    // crash-safety without saving mid-drag. Best-effort: saveCurrent() no-ops with
    // no current project, and a failed write is logged (the beforeunload guard +
    // the explicit Cmd+S error path remain). 10s is long enough not to race the
    // fast dirty-dot indicator specs.
    let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleAutosave = (): void => {
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => {
        autosaveTimer = null;
        if (useProjectStore.getState().dirty) {
          void saveCurrent().catch((e) => console.warn('boot: autosave failed', e));
        }
      }, AUTOSAVE_IDLE_MS);
    };

    const installDirtyTracking = (): void => {
      let prevDagState = useDagStore.getState().state;
      useDagStore.subscribe((s) => {
        if (s.state === prevDagState) return;
        prevDagState = s.state;
        useProjectStore.getState().markDirty();
        scheduleAutosave();
      });
    };

    // W4-T3 (D-W4-ROUTE) — first-run routing. The resume contract is the source
    // of truth: a returning user with a persisted lastProjectId resumes that
    // project in the EDITOR; only a genuine first run (the key ABSENT) lands on
    // the pre-editor HOME. First-run is the ABSENCE of LAST_PROJECT_KEY, NOT
    // storage emptiness (examples are always seeded, so storage is never empty).
    const lastId =
      typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_PROJECT_KEY) : null;

    if (lastId == null) {
      // FIRST RUN → home. Do NOT hydrate a project AND do NOT
      // persistLastProjectId here — "absence of lastId" must stay true until the
      // user actually opens something, else the home would show for exactly ONE
      // boot then never again (the persist-on-boot trap). switchProject /
      // createNewProject persist the key when the user opens from the home.
      useRouteStore.getState().goHome();
    } else {
      // Returning user → resume the persisted project in the editor.
      let project = null;
      try {
        project = await loadProject(storage, lastId);
      } catch {
        if (lastId === DEFAULT_PROJECT_ID) {
          // The canonical seed is always rebuildable — never strand the user on
          // home for the default id (it is also the e2e resume anchor). Preserve
          // the historical build-default-on-miss behavior for THIS id only.
          project = buildDefaultProject();
          await saveProject(storage, project);
        } else {
          // A persisted but UNLOADABLE custom id (deleted / schema-mismatch).
          // Clear the stale key and route home so the user picks again — do NOT
          // silently drop into a blank default editor (Chesterton: the resume
          // target is gone, not "open default").
          if (typeof localStorage !== 'undefined') localStorage.removeItem(LAST_PROJECT_KEY);
          useRouteStore.getState().goHome();
        }
      }
      if (project) {
        persistLastProjectId(project.id);
        useProjectStore.getState().setCurrent(project);
        useDagStore.getState().hydrate({
          nodes: project.state.nodes,
          outputs: project.state.outputs,
        });
        useRouteStore.getState().openEditor();
      }
    }

    // Install dirty tracking ONCE, after any resume hydrate (so the initial
    // install does not mark dirty) and on the home path too (it stays quiet
    // until the user opens a project). Execution FALLS THROUGH to the DEV seam
    // block below on EVERY route, so the __basher_* test seams are always
    // installed (a first-run-home early return would have stranded them).
    installDirtyTracking();

    // #255 — warn before leaving with UNSAVED changes. Saving is manual
    // (Cmd+S / menu / project-switch), so a tab close / reload / navigation with
    // a dirty DAG silently loses work since the last save. The native
    // beforeunload prompt is the only cross-browser guard; it fires ONLY when
    // `dirty` (an always-on handler would nag even with nothing to lose). Pure
    // decision extracted to `beforeUnloadIfDirty` so it is unit-testable.
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', (e) => {
        beforeUnloadIfDirty(e, useProjectStore.getState().dirty);
      });
    }

    // Test affordance — expose the stores in dev only. Production builds
    // strip this branch (Vite tree-shakes `if (false)`). E2E tests use
    // these to drive scenarios that native HTML5 D&D would make brittle.
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__basher_dag = useDagStore;
      w.__basher_time = useTimeStore;
      // v0.6 #4 W4 — route store seam so e2e can observe/drive home↔editor.
      w.__basher_route = useRouteStore;
      // #168 render seam — render the production frame to a PNG data URL (no
      // download) so the falsifiable e2e can decode pixels and assert the
      // render isn't blank (H68) / is the right size / excludes chrome.
      void import('./renderImageAction').then((m) => {
        w.__basher_render_png = m.renderActiveProjectToDataUrl;
      });
      // #189 render-animation seams — the falsifiable e2e drives the real
      // action (so the MP4/zip download + the loop run end-to-end) and watches
      // the progress store (for the cancel + playhead-restore observations).
      void import('./renderAnimationAction').then((m) => {
        w.__basher_render_animation = m.renderAnimationToFile;
      });
      void import('./stores/renderAnimationStore').then((m) => {
        w.__basher_render_animation_store = m.useRenderAnimationStore;
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
      // v0.6 #4 W5 — threeRef (editor camera + controls target) exposed so the
      // click-to-select regression e2e (p6-w5-first-run) can project a box's
      // world position to canvas pixels and dispatch a REAL viewport click —
      // observing the actual onClick raycast path, not the selection store
      // directly. Same UI-projection-store seam pattern as __basher_selection.
      void import('./character/threeRef').then((m) => {
        w.__basher_three = m.useThreeRef;
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
      // UX #11 — timelineViewStore exposed so e2e/observation can drive the
      // SHARED zoom/pan (dopesheet + curve editor read it) without synthesising
      // Ctrl-wheel gestures. K12 dev-seam pattern.
      void import('../timeline/timelineViewStore').then((m) => {
        w.__basher_timeline_view = m.useTimelineViewStore;
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
      // UX #9 — import an .hdr/.exr environment file to OPFS (content-hash
      // store) and return its assetRef. Mirrors the inspector's Import… button
      // (slice 3); the env-HDRI e2e drives it without the OS file chooser.
      void import('./asset/importEnvironmentHdri').then((m) => {
        w.__basher_importEnvHdri = (bytes: Uint8Array, filename: string) =>
          m.importEnvironmentHdri(bytes, filename);
      });
      // `.basher` scene-file seams — let the falsifiable e2e round-trip a real
      // exported scene (export → import) and assert the DAG + embedded assets
      // survive, without driving the OS file chooser. `__basher_opfs` exposes
      // read/exists/delete so the asset-rehydrate direction can be proven end to
      // end (delete the OPFS asset, import the bundle, assert it's back).
      w.__basher_export_scene_bundle = () => buildSceneBundleForCurrent();
      w.__basher_import_scene_bundle = (bundle: SceneBundle) => importSceneBundle(bundle);
      w.__basher_opfs = {
        read: async (path: string) => {
          const storage = await getStorage();
          return storage.read(path);
        },
        exists: async (path: string) => {
          const storage = await getStorage();
          return storage.exists(path);
        },
        delete: async (path: string) => {
          const storage = await getStorage();
          await storage.delete(path);
        },
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
      // P7.9 Wave D Task 8 — real-path ingestion seam (issue #110). Drives the
      // SHARED interactive chokepoint `ingestAndImportGltf`: resolve the entry
      // choice (the multi-glTF chooser, #214) → ingestGltfFolder (disk → OPFS
      // write) → importGltfFromOpfs (OPFS read → dispatchAtomic). Wave F e2e
      // uses this for the full write→ingest→dispatch→render pipeline; the #214
      // e2e drives the chooser through it. Returns '' if the chooser is
      // dismissed. The existing __basher_importGltf seam above is left intact —
      // it is the P7.5/P7.6 fixture entry (Chesterton).
      w.__basher_ingestGltfFolder = async (
        files: ReadonlyArray<IngestFile>,
        folderName: string,
      ): Promise<string> => {
        return (await ingestAndImportGltf(files, folderName)) ?? '';
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
      // #202 (epic #201) — the H40 side-B seam for the pure WORLD transform. The
      // boundary-pair e2e asserts the RESOLVER world (here) == the REAL rendered
      // object's world matrix (__basher_mesh_world_position) for a nested
      // Transform/Group hierarchy. This is THE foundational constraint gate:
      // resolveWorldTransform MIRRORS the SceneFromDAG accumulation as a pure
      // value, so a constraint can read a target's world transform off-graph.
      // Read-only (V8 clean).
      w.__basher_world_transform = (nodeId: NodeId, ctx?: EvalCtx) => {
        const state = useDagStore.getState().state;
        const evalCtx: EvalCtx = ctx ?? { time: { frame: 0, seconds: 0, normalized: 0 } };
        return resolveWorldTransform(state, nodeId, evalCtx);
      };
      w.__basher_evaluated_param = (nodeId: NodeId, paramPath: string, ctx?: EvalCtx) => {
        const state = useDagStore.getState().state;
        const evalCtx: EvalCtx = ctx ?? { time: { frame: 0, seconds: 0, normalized: 0 } };
        return resolveEvaluatedParam(state, nodeId, paramPath, evalCtx);
      };
      // v0.6 #3 (#181, W1) — the H40 side-B seam for the UVEditor. Reads THROUGH
      // the SAME resolveMeshUVs the panel draws (no drift), reports the island
      // count / triangle count / union bounds / sampled flag for the selected
      // node. The e2e asserts these == the REAL BufferGeometry uv attribute (a
      // BoxGeometry's 6 islands each span [0,0,1,1] — the synthetic cross unfold
      // could NOT pass). `status` lets the harness wait out an async clone/baked
      // load. Read-only (V8 clean).
      w.__basher_uv_islands = (
        nodeId: NodeId,
      ): {
        status: string;
        islandCount: number;
        triangleCount: number;
        bounds: [number, number, number, number] | null;
        sampled: boolean;
      } => {
        const state = useDagStore.getState().state;
        const src = resolveMeshUVs(state, nodeId);
        return {
          status: src.status,
          islandCount: src.uvs ? src.uvs.islands.length : 0,
          triangleCount: src.uvs ? src.uvs.triangleCount : 0,
          bounds: src.uvs ? unionUVBounds(src.uvs) : null,
          sampled: src.uvs ? src.uvs.sampled : false,
        };
      };
      // UX-BACKLOG #10 — the side-B seam for the UV-editor texture backdrop.
      // Reads THROUGH the SAME resolveMeshTexture the panel paints (no drift): is
      // a base-color map bound for the selected node, what are its dims, and its
      // flipY (which selects the backdrop's vertical orientation, V48). The image
      // itself isn't serializable across the seam, so we report `hasImage` + dims;
      // `status` lets the harness wait out an async clone / baked-OPFS load.
      w.__basher_uv_texture = (
        nodeId: NodeId,
      ): { status: string; hasImage: boolean; width: number; height: number; flipY: boolean } => {
        const state = useDagStore.getState().state;
        const t = resolveMeshTexture(state, nodeId);
        return {
          status: t.status,
          hasImage: t.image !== null,
          width: t.width,
          height: t.height,
          flipY: t.flipY,
        };
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
      // #209 (epic #201) — the SOP/modifier boundary-pair side-B seam. Resolve the
      // node's EvaluatedMesh, build its (registry-cached) geometry, and return the
      // position-attribute count. For an ArrayModifier this is the merged array's
      // vertex count — the SAME geometryRegistry instance ModifiedMeshR rendered
      // (side A reads it off the three scene). render-count == resolver-count proves
      // the live render consumed the resolver's geometry handle (H40 one band, V37).
      w.__basher_modified_vertex_count = (nodeId: NodeId, ctx?: EvalCtx): number | null => {
        const state = useDagStore.getState().state;
        const evalCtx: EvalCtx = ctx ?? { time: { frame: 0, seconds: 0, normalized: 0 } };
        const mesh = resolveEvaluatedMesh(state, nodeId, evalCtx);
        if (!mesh) return null;
        const geom = geometryRegistry.get(mesh.geometry);
        if (!geom) return null; // registry miss (gltf/baked source) — not buildable here
        const pos = geom.getAttribute('position');
        return pos ? pos.count : null;
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

/**
 * The pure decision behind the `beforeunload` guard (#255): when the project has
 * unsaved changes, cancel the unload (set `returnValue` — Chrome requires it) so
 * the browser shows its native "leave site?" prompt. Returns whether it blocked,
 * for the unit test. A no-op when clean, so the user is never nagged with nothing
 * to lose.
 */
export function beforeUnloadIfDirty(
  e: { preventDefault: () => void; returnValue: unknown },
  dirty: boolean,
): boolean {
  if (!dirty) return false;
  e.preventDefault();
  e.returnValue = '';
  return true;
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

// ---------------------------------------------------------------------------
// Native `.basher` scene file — export (embed assets) / open (rehydrate + new
// project). The symmetric counterpart to the DAG-only exportDag.ts. See
// sceneBundle.ts for the envelope + the deductive asset-ref walk.
// ---------------------------------------------------------------------------

export interface BuiltSceneBundle {
  readonly bundle: SceneBundle;
  /** Referenced OPFS paths that could not be read (an incomplete export — the
   *  UI surfaces a warning so the user knows the file is not fully portable). */
  readonly missingAssets: string[];
}

/**
 * Build a self-contained `.basher` bundle from the CURRENT project + DAG: the
 * DAG state plus every OPFS-backed asset it references, embedded as base64. Pure
 * read (no mutation, no download). A referenced-but-unreadable asset is recorded
 * in `missingAssets` rather than silently dropped (V38).
 */
export async function buildSceneBundleForCurrent(): Promise<BuiltSceneBundle> {
  const storage = await getStorage();
  const dag = useDagStore.getState().state;
  const meta = useProjectStore.getState().current ?? {
    id: 'untitled',
    name: 'Untitled',
    formatVersion: PROJECT_FORMAT_VERSION,
  };

  const refs = collectAssetRefs(dag);
  const files = await resolveAssetFiles(storage, refs);
  const assets: Record<string, string> = {};
  const missingAssets: string[] = [];
  for (const path of files) {
    try {
      const bytes = await storage.read(path);
      assets[path] = bytesToBase64(bytes);
    } catch {
      missingAssets.push(path);
    }
  }

  const bundle: SceneBundle = {
    formatVersion: meta.formatVersion ?? PROJECT_FORMAT_VERSION,
    bundleVersion: SCENE_BUNDLE_VERSION,
    id: meta.id,
    name: meta.name,
    exportedAt: Date.now(),
    state: { nodes: dag.nodes, outputs: dag.outputs },
    assets: Object.keys(assets).length > 0 ? assets : undefined,
  };
  return { bundle, missingAssets };
}

/**
 * Open a parsed `.basher` bundle as a NEW project (non-destructive): rehydrate
 * its embedded assets into OPFS, compose a fresh-id Project through the standard
 * load+migration ladder, then hydrate the stores (the createNewProject pattern).
 * The outgoing project is auto-saved first so its edits are not lost. Returns the
 * new project id.
 *
 * Asset rehydrate is WRITE-IF-ABSENT: the baked-* stores are content-addressed
 * (same hash ⇒ identical bytes, so skipping an existing file is correct), and
 * user-imports is left intact when a same-named folder already exists (a rare
 * same-name-different-content collision keeps the existing asset rather than
 * clobbering another project's import — a known v1 limitation).
 */
export async function importSceneBundle(bundle: SceneBundle): Promise<string> {
  const storage = await getStorage();
  // Don't lose the project we're leaving.
  await saveCurrent();

  // 1. Rehydrate embedded assets to OPFS BEFORE hydrating the DAG, so the
  //    renderer's async loaders find the bytes on first mount.
  if (bundle.assets) {
    for (const [path, b64] of Object.entries(bundle.assets)) {
      if (await storage.exists(path)) continue;
      await storage.write(path, base64ToBytes(b64));
    }
  }

  // 2. Compose a brand-new project (fresh id + timestamps) through the same
  //    ladder loadProject uses (migrate → validate → migrate-nodes).
  const newId = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const project = bundleToProject(bundle, newId, Date.now());
  await saveProject(storage, project);
  persistLastProjectId(project.id);

  // 3. Hydrate (createNewProject pattern — the double setCurrent clears the
  //    dirty flag the hydrate subscription raises).
  useProjectStore.getState().setCurrent(project);
  useDagStore.getState().hydrate({
    nodes: project.state.nodes,
    outputs: project.state.outputs,
  });
  useProjectStore.getState().setCurrent(project);
  return newId;
}
