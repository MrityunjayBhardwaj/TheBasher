// Curated example projects (v0.6 #4 W4, D-08/D-W4-SEED).
//
// The Spline-style HOME surface shows a row of "Examples" alongside the user's
// own projects. These are NOT static JSON fixtures — each is a real Op-built
// DAG in the EXACT shape `default.ts` uses (applyOp → composeProject), so an
// opened example is an ordinary project: every object is a selectable DAG node,
// undo/agent-authoring work, and it persists like any user project (V34 — one
// substrate, no state outside the IR). The old "demo project" (SPLINE-UI-REF §2
// #7) is simply the first example here, not a special-cased seed.
//
// Seeding (boot.ts `seedExampleProjects`) is IDEMPOTENT: an example id is only
// written if absent from storage, so a user who opens + edits an example keeps
// their edits across reloads (re-seeding never clobbers them). Stable
// `example_<slug>` ids let the HOME split the gallery into "Examples" vs "Your
// projects" from the SAME `listProjectMetadata` read (no second data path).
//
// Most examples use pure primitives (the Object+BoxData split, #365 Phase 5a) with no OPFS
// asset dependency. #1282 — "Camera Path + AI Walk" is the first that has one: a rigged
// character whose GLB lives in storage. It is an APP-SHIPPED asset, so it follows that convention
// (`sceneBundle.ts`: app-shipped assets are seeded, never embedded): a catalog asset
// (`src/app/asset/catalog.ts`) that boot seeds BEFORE the examples. `exampleAssets.test.ts` reds
// if an example refers to an asset the catalog does not seed.
//
// That example is not Op-built: its motion is GENERATED (Kimodo, from a prompt and the
// waypoints of a drawn curve), so it cannot be written down as ops by hand. It is the project
// the app itself saved (File ▸ Save Scene as .basher…) after the scene was built through the
// product's own paths, committed verbatim, and loaded lazily so ~880 KB of clip keys stay out
// of the main bundle. Its AnimationClip holds the generated keys, so it opens and plays with
// no motion server (measured with every request to the server blocked, #1282).

import { applyOp, emptyDagState, type DagState } from '../dag';
import type { Op } from '../dag/types';
import { composeProject, type Project } from './index';
import { PROJECT_FORMAT_VERSION } from './schema';

/** A scene the app saved, as File ▸ Save Scene as .basher… writes it. */
interface CapturedScene {
  readonly formatVersion: number;
  readonly state: DagState;
}

type ExampleDef = {
  readonly id: string;
  readonly name: string;
} & ({ readonly ops: readonly Op[] } | { readonly captured: () => Promise<CapturedScene> });

// Shared scaffold ops (camera + light + time + scene + render + the four wiring
// edges) — every example frames a calm, lit scene the same way default.ts does.
function scaffold(): Op[] {
  return [
    // #387 Stage C (C4) — the camera is split-native (CameraData + Object), exactly like
    // default.ts, so a bundled example stays split-native + orphan-free (#436). The Object
    // keeps the id `n_camera`, so the scene.camera edge below is unchanged. Framing values
    // preserved exactly as the fused scaffold carried them.
    {
      type: 'addNode',
      nodeId: 'n_camera_data',
      nodeType: 'CameraData',
      params: { projection: 'Perspective', fov: 45, near: 0.01, far: 500, lookAt: [0, 0.4, 0] },
    },
    {
      type: 'addNode',
      nodeId: 'n_camera',
      nodeType: 'Object',
      params: { position: [4, 2.5, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      type: 'connect',
      from: { node: 'n_camera_data', socket: 'out' },
      to: { node: 'n_camera', socket: 'data' },
    },
    // #386 Stage C (C3) — the key light is split-native (LightData + Object), exactly like
    // default.ts, so a bundled example stays split-native + orphan-free (#436). The Object
    // keeps the id `n_light`, so the scene.lights edge below is unchanged.
    {
      type: 'addNode',
      nodeId: 'n_light_data',
      nodeType: 'LightData',
      params: { lightKind: 'Directional', intensity: 1.1, color: '#ffffff' },
    },
    {
      type: 'addNode',
      nodeId: 'n_light',
      nodeType: 'Object',
      params: { position: [5, 6, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      type: 'connect',
      from: { node: 'n_light_data', socket: 'out' },
      to: { node: 'n_light', socket: 'data' },
    },
    { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} },
    { type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} },
    {
      type: 'addNode',
      nodeId: 'n_render',
      nodeType: 'RenderOutput',
      params: { postFx: { tonemap: 'ACES', smaa: true } },
    },
    {
      type: 'connect',
      from: { node: 'n_camera', socket: 'out' },
      to: { node: 'n_scene', socket: 'camera' },
    },
    {
      type: 'connect',
      from: { node: 'n_light', socket: 'out' },
      to: { node: 'n_scene', socket: 'lights' },
    },
    {
      type: 'connect',
      from: { node: 'n_scene', socket: 'out' },
      to: { node: 'n_render', socket: 'scene' },
    },
  ];
}

// #365 Phase 5a (Slice 1b) — a box is the object↔data split: a BoxData (geometry + material)
// and an Object (pose) wired data→object. The Object keeps `nodeId`, so `childEdge(nodeId)`
// still wires it into scene.children unchanged. Same pair the load-migration produces (K23).
function box(nodeId: string, position: [number, number, number], color: string): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: `${nodeId}_data`,
      nodeType: 'BoxData',
      params: {
        size: [1, 1, 1],
        material: { name: 'default', base: { color } },
      },
    },
    {
      type: 'addNode',
      nodeId,
      nodeType: 'Object',
      params: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      type: 'connect',
      from: { node: `${nodeId}_data`, socket: 'out' },
      to: { node: nodeId, socket: 'data' },
    },
  ];
}

function childEdge(nodeId: string): Op {
  return {
    type: 'connect',
    from: { node: nodeId, socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  };
}

// Example 1 — the inviting starter scene (the old "demo"): two boxes, framed.
const STARTER_OPS: Op[] = [
  ...scaffold(),
  ...box('n_box', [-0.7, 0, 0], '#5af07a'),
  childEdge('n_box'),
  ...box('n_box_2', [0.9, 0, -0.4], '#7aaaff'),
  childEdge('n_box_2'),
];

// Example 2 — a small color study: three boxes in a row.
const TRIO_OPS: Op[] = [
  ...scaffold(),
  ...box('n_box_a', [-1.4, 0, 0], '#f06464'),
  childEdge('n_box_a'),
  ...box('n_box_b', [0, 0, 0], '#64f08c'),
  childEdge('n_box_b'),
  ...box('n_box_c', [1.4, 0, 0], '#6496f0'),
  childEdge('n_box_c'),
];

const EXAMPLES: readonly ExampleDef[] = [
  { id: 'example_starter', name: 'Starter Scene', ops: STARTER_OPS },
  { id: 'example_trio', name: 'Color Trio', ops: TRIO_OPS },
  // #1282 — a character walking an AI motion steered by a waypoint curve, the camera on a
  // Follow-Path of its own and aimed at the character by a Track-To.
  {
    id: 'example_camera_path_ai_walk',
    name: 'Camera Path + AI Walk',
    captured: async () =>
      (await import('./exampleScenes/cameraPathAiWalk.basher.json')).default as CapturedScene,
  },
];

/** Ids of the examples the app saved rather than built from ops here (#1282). */
export const CAPTURED_EXAMPLE_IDS: readonly string[] = EXAMPLES.filter((e) => 'captured' in e).map(
  (e) => e.id,
);

/** Stable ids of the curated examples — the HOME splits the gallery on these. */
export const EXAMPLE_PROJECT_IDS: readonly string[] = EXAMPLES.map((e) => e.id);

function buildState(ops: readonly Op[]): DagState {
  let state = emptyDagState();
  for (const op of ops) state = applyOp(state, op).next;
  return {
    ...state,
    outputs: {
      scene: { node: 'n_scene', socket: 'out' },
      render: { node: 'n_render', socket: 'out' },
    },
  };
}

/** Build one example as a real Project. Rejects on an unknown id, and on a captured scene
 *  saved in another project format — it was never migrated, so it must be re-captured. */
export async function buildExampleProject(id: string): Promise<Project> {
  const def = EXAMPLES.find((e) => e.id === id);
  if (!def) throw new Error(`buildExampleProject: unknown example id "${id}"`);
  if ('ops' in def)
    return composeProject({ id: def.id, name: def.name, state: buildState(def.ops) });
  const scene = await def.captured();
  if (scene.formatVersion !== PROJECT_FORMAT_VERSION)
    throw new Error(
      `buildExampleProject: "${id}" was captured at project format ${scene.formatVersion}, ` +
        `the app writes ${PROJECT_FORMAT_VERSION} — re-capture it (#1282)`,
    );
  return composeProject({
    id: def.id,
    name: def.name,
    state: { ...emptyDagState(), ...scene.state },
  });
}

/** All curated examples — used by boot's idempotent seeding. */
export function buildAllExampleProjects(): Promise<Project[]> {
  return Promise.all(EXAMPLES.map((e) => buildExampleProject(e.id)));
}
