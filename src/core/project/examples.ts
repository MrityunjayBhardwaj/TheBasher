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
// All examples use pure primitives (BoxMesh) — no OPFS asset dependency — so
// seeding never races asset loading.

import { applyOp, emptyDagState, type DagState } from '../dag';
import type { Op } from '../dag/types';
import { composeProject, type Project } from './index';

interface ExampleDef {
  readonly id: string;
  readonly name: string;
  readonly ops: readonly Op[];
}

// Shared scaffold ops (camera + light + time + scene + render + the four wiring
// edges) — every example frames a calm, lit scene the same way default.ts does.
function scaffold(): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: 'n_camera',
      nodeType: 'PerspectiveCamera',
      params: { fov: 45, near: 0.01, far: 1000, position: [4, 2.5, 4], lookAt: [0, 0.4, 0] },
    },
    {
      type: 'addNode',
      nodeId: 'n_light',
      nodeType: 'DirectionalLight',
      params: { intensity: 1.1, position: [5, 6, 3], color: '#ffffff' },
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

function box(nodeId: string, position: [number, number, number], color: string): Op {
  return {
    type: 'addNode',
    nodeId,
    nodeType: 'BoxMesh',
    params: {
      size: [1, 1, 1],
      position,
      rotation: [0, 0, 0],
      material: { name: 'default', base: { color } },
    },
  };
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
  box('n_box', [-0.7, 0, 0], '#5af07a'),
  childEdge('n_box'),
  box('n_box_2', [0.9, 0, -0.4], '#7aaaff'),
  childEdge('n_box_2'),
];

// Example 2 — a small color study: three boxes in a row.
const TRIO_OPS: Op[] = [
  ...scaffold(),
  box('n_box_a', [-1.4, 0, 0], '#f06464'),
  childEdge('n_box_a'),
  box('n_box_b', [0, 0, 0], '#64f08c'),
  childEdge('n_box_b'),
  box('n_box_c', [1.4, 0, 0], '#6496f0'),
  childEdge('n_box_c'),
];

const EXAMPLES: readonly ExampleDef[] = [
  { id: 'example_starter', name: 'Starter Scene', ops: STARTER_OPS },
  { id: 'example_trio', name: 'Color Trio', ops: TRIO_OPS },
];

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

/** Build one example as a real Project (Op-built DAG). Throws on unknown id. */
export function buildExampleProject(id: string): Project {
  const def = EXAMPLES.find((e) => e.id === id);
  if (!def) throw new Error(`buildExampleProject: unknown example id "${id}"`);
  return composeProject({ id: def.id, name: def.name, state: buildState(def.ops) });
}

/** All curated examples — used by boot's idempotent seeding. */
export function buildAllExampleProjects(): Project[] {
  return EXAMPLES.map((e) => buildExampleProject(e.id));
}
