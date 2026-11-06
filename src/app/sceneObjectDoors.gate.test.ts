// #1822 — every door that creates a scene object leaves it in the scene, checked from the code.
//
// When reachability was chosen as what "in the scene" means (#1519), the decision said its cost is
// paid once, by a check that every creating door lands what it makes reachable. This is that check.
//
// TWO HALVES:
//
//   THE RUNS. Each door in `DOORS` is run for real against the default project, once with the scene
//   collection active and once with a collection active, and every scene object it made must answer
//   true to `isInScene`. A collection does not hold a thing in the scene today (`drawnToday` is off
//   for its wires, #1823), so the second run is not a softer version of the first.
//
//   THE SCAN. `CREATORS` lists every non-test file under `src/` that can create a node, and says
//   either which door runs it or why it makes no scene object. A new file fails until someone says
//   which. "Can create a node" is stated as a predicate so a reader can check what this sees:
//   the code, comments removed, either builds an `addNode` op, or writes a node record of a type
//   whose output is a scene object (a file conversion writes records, not ops).
//
// WHAT IS A SCENE OBJECT: a node whose type outputs a `SceneObject` (read off the registry, so a new
// type is covered when it exists), other than the hops the wires pass through (`HOP_TYPES`) and
// other than what sits inside a sub-network, which belongs to the node that owns it.
//
// WHAT THIS DOES NOT SEE: a file that creates nodes only by calling a builder another file holds
// (`mesh.add`, `library.import`) is not in the scan, because the builder is. A door that wires what
// it made somewhere else after the builder returned would be missed; `mesh.add` is run below for
// that reason. Reading a node type off a variable (a duplicate, a template body) is why the scan
// asks about `addNode` itself rather than about the type it names.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { __resetRegistryForTests, applyOps, type DagState } from '../core/dag';
import { followableName } from '../core/dag/nodeName';
import { getNodeType, listNodeTypes } from '../core/dag/registry';
import { subnetworkOf } from '../core/dag/subnetworks';
import { templatesOf } from '../core/dag/templates';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { buildAllExampleProjects } from '../core/project/examples';
import { migrateLightAimToTurn } from '../core/project/migrations';
import { repairFloatingCameras } from '../core/project/repairFloatingCameras';
import { repairAndWarn } from '../core/project/repairRoleBindings';
import type { Project } from '../core/project/schema';
import { MemoryStorage } from '../core/storage/MemoryStorage';
import { cameraTrajectoryMutator } from '../agent/mutators/builders/cameraTrajectory';
import { addTemplateInstanceMutator } from '../agent/mutators/builders/templates';
import { validatePlan } from '../agent/mutators/validate';
import { cameraSnapshotTool } from '../agent/tools/cameraSnapshot';
import { meshAddTool } from '../agent/tools/meshAdd';
import { registerAllNodes } from '../nodes/registerAll';
import { stripComments } from '../test-utils/sourceScan';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { makeSplitLight } from '../test-utils/splitLight';
import {
  COMPUTE_KINDS,
  RESOURCE_KINDS,
  SCENE_OBJECT_KINDS,
  buildAddPrimitiveOps,
} from './addPrimitives';
import { buildAddStudioLightOps } from './addStudioLight';
import { mintMotionGenerateOps } from './asset/mintMotionGenerate';
import { buildCameraFromViewOps } from './character/cameraFromView';
import { isCameraNode } from './cameraNode';
import { newCollectionOps, setActiveCollectionOp } from './collections';
import { buildAddConstraintOps } from './constraintStack';
import { buildDuplicateNodesOps } from './sceneNodeActions';
import { HOP_TYPES, isInScene, sceneMembersOf } from './sceneMembership';
import { buildSetActiveCameraOps } from './setActiveCamera';
import { buildAddProfileOps } from './studioProfiles';
import { buildImportProfilesOps } from './studioProfileIO';
import { instanceIdFor, planAddTemplateInstance, planCollapseToTemplate } from './templates';

const storage = new MemoryStorage();
vi.mock('./boot', () => ({ getStorage: async () => storage }));
const { buildGltfImportOpsFromOpfs } = await import('./asset/importGltf');
const { buildMotionImportOpsFromOpfs } = await import('./asset/importBvhFbx');

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** As `dispatchAtomic` applies a door's ops: one batch, whose rules are asked of where it ends. */
const apply = (state: DagState, ops: readonly Op[]) => applyOps(state, ops).next;

/** The types whose nodes are scene objects, off the registry. */
function sceneObjectTypes(state?: DagState): Set<string> {
  const types = new Set<string>();
  for (const type of listNodeTypes()) {
    const outputs = Object.values(getNodeType(type)?.outputs ?? {});
    if (outputs.some((o) => o.type === 'SceneObject') && !HOP_TYPES.has(type)) types.add(type);
  }
  // A template's instance has the type its definition gives it.
  if (state) {
    for (const [type, { definition }] of templatesOf(state))
      if (definition.output.type === 'SceneObject') types.add(type);
  }
  return types;
}

function ownedBySubnetwork(state: DagState): Set<string> {
  const owned = new Set<string>();
  for (const id of Object.keys(state.nodes)) for (const n of subnetworkOf(state, id)) owned.add(n);
  return owned;
}

/** What `after` holds and `before` did not that is a scene object, less what a sub-network owns. */
function newSceneObjects(before: DagState, after: DagState): string[] {
  const types = sceneObjectTypes(after);
  const owned = ownedBySubnetwork(after);
  return Object.values(after.nodes)
    .filter((n) => !before.nodes[n.id] && types.has(n.type) && !owned.has(n.id))
    .map((n) => n.id);
}

/** The default project with one collection, the active one when `active`. */
function startingState(active: boolean): DagState {
  let s = buildDefaultDagState();
  const made = newCollectionOps(s)!;
  s = apply(s, made.ops);
  return active ? apply(s, [setActiveCollectionOp(s, made.collectionId)!]) : s;
}

const add = (s: DagState, kind: (typeof SCENE_OBJECT_KINDS)[number]) =>
  apply(s, buildAddPrimitiveOps(s, kind, [1, 2, 3])!.ops);

const newId = (before: DagState, after: DagState, match: (id: string) => boolean) =>
  Object.keys(after.nodes).find((id) => !before.nodes[id] && match(id))!;

/** A camera the way Add ▸ Camera leaves it, and its id. */
function addedCamera(s: DagState): { state: DagState; id: string } {
  const after = add(s, 'PerspectiveCamera');
  return { state: after, id: newId(s, after, (id) => isCameraNode(after, id)) };
}

const defaultCameraOf = (s: DagState) =>
  s.nodes[s.outputs.scene!.node].inputs.camera as never as {
    node: string;
  };

/** A camera the way the editor's orbit view would make one. */
function viewOf(): Parameters<typeof buildCameraFromViewOps>[1] {
  const camera = new THREE.PerspectiveCamera(50);
  camera.position.set(3, 2, 3);
  return { camera, target: new THREE.Vector3(0, 0, 0), seconds: 0 };
}

const importGltf = async (s: DagState, source: string): Promise<DagState> => {
  const path = `user-imports/census/${source.split('/').pop()}`;
  await storage.write(path, new Uint8Array(readFileSync(source)));
  const road = await buildGltfImportOpsFromOpfs(path, s);
  expect(road.road, `${source} imports`).toBe('native');
  return road.road === 'native' ? apply(s, road.ops) : s;
};

const importMotion = async (s: DagState, source: string): Promise<DagState> => {
  const path = `user-imports/census/${source.split('/').pop()}`;
  await storage.write(path, new Uint8Array(readFileSync(source)));
  return apply(s, (await buildMotionImportOpsFromOpfs(path, s)).ops);
};

/** A cube collapsed into a template, as Collapse to Template leaves it. */
function withCubeTemplate(s0: DagState): { state: DagState; type: string } {
  const added = buildAddPrimitiveOps(s0, 'Cube', [0, 0, 0])!;
  const s = apply(s0, added.ops);
  const plan = planCollapseToTemplate(s, [added.newNodeId, added.dataNodeId!], 'Box', 'n_box_1');
  if (!plan.ok) throw new Error(plan.reason);
  return { state: apply(s, plan.ops), type: plan.definition.type };
}

interface Door {
  readonly name: string;
  /** The creating files this run goes through (`CREATORS` asks that each has a run). */
  readonly files: readonly string[];
  /** Run the door. `before` is what scene objects are counted as new against. */
  readonly run: (s: DagState) => Promise<DagState> | DagState;
  /** The state to count from, when the door needs something in place first. */
  readonly arrange?: (s: DagState) => DagState;
}

const ADD = 'src/app/addPrimitives.ts';
const DUPLICATE = 'src/app/sceneNodeActions.ts';
const AIM = 'src/app/lightAim.ts';

const DOORS: readonly Door[] = [
  // Add: every kind the menu offers, the ones that make no scene object included, so a kind moving
  // from one list to another is caught either way.
  ...[...SCENE_OBJECT_KINDS, ...COMPUTE_KINDS, ...RESOURCE_KINDS].map(
    (kind): Door => ({
      name: `Add ▸ ${kind}`,
      files: [
        ADD,
        ...(kind === 'Armature' ? ['src/core/import/skeletonObject.ts'] : []),
        ...(kind === 'DirectionalLight' || kind === 'SpotLight' || kind === 'AreaLight'
          ? [AIM]
          : []),
        ...(kind === 'Lag' ? ['src/app/builtinTemplates.ts', 'src/app/templates.ts'] : []),
      ],
      run: (s) => apply(s, buildAddPrimitiveOps(s, kind, [1, 2, 3])!.ops),
    }),
  ),
  {
    name: 'mesh.add (agent) ▸ camera',
    files: [ADD],
    run: async (s) =>
      apply(
        s,
        (
          await meshAddTool.handler(
            meshAddTool.paramSchema.parse({ kind: 'PerspectiveCamera', position: [1, 2, 3] }),
            { dagState: s },
          )
        ).ops,
      ),
  },
  // The light-aim empty, by the road that is not Add ▸ Light.
  {
    name: 'constraint stack ▸ Track-To on a light',
    files: ['src/app/constraintStack.ts', AIM],
    arrange: (s) =>
      makeSplitLight(s, {
        lightKind: 'Spot',
        objectId: 'census_spot',
        connectTo: { node: s.outputs.scene!.node, socket: 'lights' },
      }).state,
    run: (s) => apply(s, buildAddConstraintOps(s, 'census_spot', 'TrackTo')!.ops),
  },
  // Duplicate: each place an original can stand.
  {
    name: 'Shift+D on a cube',
    files: [DUPLICATE],
    arrange: (s) => add(s, 'Cube'),
    run: (s) => {
      const id = Object.keys(s.nodes).find((n) => s.nodes[n].type === 'Object' && /^obj_/.test(n))!;
      return apply(s, buildDuplicateNodesOps(s, [id])!.ops);
    },
  },
  {
    name: 'Shift+D on the active camera, wired to the single Scene.camera',
    files: [DUPLICATE],
    run: (s) => apply(s, buildDuplicateNodesOps(s, [defaultCameraOf(s).node])!.ops),
  },
  {
    name: 'Shift+D on an added camera',
    files: [DUPLICATE],
    arrange: (s) => addedCamera(s).state,
    run: (s) => {
      const id = Object.keys(s.nodes).find((n) => /^cam_/.test(n))!;
      const dup = buildDuplicateNodesOps(s, [id]);
      expect(dup, 'an added camera can be duplicated').not.toBeNull();
      return apply(s, dup!.ops);
    },
  },
  {
    name: 'Alt+D on a light',
    files: [DUPLICATE],
    arrange: (s) => add(s, 'PointLight'),
    run: (s) => {
      const id = Object.keys(s.nodes).find((n) => /^light_/.test(n))!;
      return apply(s, buildDuplicateNodesOps(s, [id], { linked: true })!.ops);
    },
  },
  // Ctrl+Shift+C and its agent twin: each takes over Scene.camera, so each is also checked below
  // for what it leaves of the camera it replaced.
  {
    name: 'Ctrl+Shift+C (camera from view)',
    files: ['src/app/character/cameraFromView.ts'],
    run: (s) => apply(s, buildCameraFromViewOps(s, viewOf())!.ops),
  },
  {
    name: 'camera.snapshot (agent)',
    files: ['src/agent/tools/cameraSnapshot.ts'],
    run: async (s) =>
      apply(
        s,
        (
          await cameraSnapshotTool.handler(
            { fov: 45, position: [3, 2, 3], lookAt: [0, 0, 0] },
            { dagState: s },
          )
        ).ops,
      ),
  },
  {
    name: 'Set Active on a second camera (gathers a CameraSelect)',
    files: ['src/app/setActiveCamera.ts'],
    arrange: (s) => addedCamera(s).state,
    run: (s) => {
      const id = Object.keys(s.nodes).find((n) => /^cam_/.test(n))!;
      return apply(s, buildSetActiveCameraOps(s, id)!);
    },
  },
  {
    name: 'camera trajectory (agent), its path curve',
    files: ['src/agent/mutators/builders/cameraTrajectory.ts'],
    run: (s) => {
      const spec = cameraTrajectoryMutator.spec.parse({
        cameraId: defaultCameraOf(s).node,
        aimPoint: [0, 0, 0],
        points: [
          [4, 2, 3],
          [0, 2, 5],
          [-4, 2, 3],
        ],
        name: 'arc',
      });
      const plan = validatePlan(cameraTrajectoryMutator, spec, s, 'a camera arc');
      if (!plan.ok) throw new Error(`${plan.label}: ${plan.reason}`);
      return apply(s, plan.ops);
    },
  },
  // Studio lights and profiles.
  {
    name: 'Light Studio ▸ + Light',
    files: ['src/app/addStudioLight.ts', AIM],
    run: (s) => apply(s, buildAddStudioLightOps(s, [0, 0, 0])!.ops),
  },
  {
    name: 'Light Studio ▸ new profile, adopting a free light',
    files: ['src/app/studioProfiles.ts'],
    arrange: (s) => apply(s, buildAddStudioLightOps(s, [0, 0, 0])!.ops),
    run: (s) => apply(s, buildAddProfileOps(s, 'Key', [0, 0, 0])!.ops),
  },
  {
    name: 'Light Studio ▸ load a profiles file',
    files: ['src/app/studioProfileIO.ts', AIM],
    run: (s) => {
      const light = {
        position: [0, 3, 4] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
        intensity: 5,
        color: '#ffffff',
        width: 1,
        height: 1,
      };
      return apply(
        s,
        buildImportProfilesOps(s, {
          version: 1,
          profiles: [{ name: 'Key', center: [0, 0, 0], radius: 6, lights: [light] }],
        } as Parameters<typeof buildImportProfilesOps>[1]).ops,
      );
    },
  },
  // Templates: one with a scene object as its output.
  {
    name: 'Collapse to Template on a cube',
    files: ['src/app/templates.ts'],
    run: (s) => withCubeTemplate(s).state,
  },
  {
    name: 'Add ▸ template instance whose output is a scene object',
    files: ['src/app/templates.ts'],
    arrange: (s) => withCubeTemplate(s).state,
    run: (s) => {
      const type = [...templatesOf(s).keys()][0];
      const def = templatesOf(s).get(type)!.definition;
      return apply(s, planAddTemplateInstance(s, def, instanceIdFor(s, type)));
    },
  },
  {
    name: 'mutator.graph.addTemplateInstance (agent), no outputTo',
    files: ['src/agent/mutators/builders/templates.ts'],
    arrange: (s) => withCubeTemplate(s).state,
    run: (s) => {
      const spec = addTemplateInstanceMutator.spec.parse({ template: 'Box' });
      const plan = validatePlan(addTemplateInstanceMutator, spec, s, 'another box');
      if (!plan.ok) throw new Error(`${plan.label}: ${plan.reason}`);
      return apply(s, plan.ops);
    },
  },
  // Generated motion.
  {
    name: 'generate motion (its rig Object)',
    files: ['src/app/asset/mintMotionGenerate.ts', 'src/core/import/skeletonObject.ts'],
    run: (s) =>
      apply(s, mintMotionGenerateOps(s, { prompt: 'a walk', seed: 1, model: 'kimodo' }).ops),
  },
  // Imports, through the entry each picker and drop calls.
  {
    name: 'import glTF, skinned',
    files: [
      'src/core/import/nativeGltfImport.ts',
      'src/core/import/skeletonObject.ts',
      'src/core/import/modelImport.ts',
    ],
    run: (s) => importGltf(s, 'public/assets/skinned-bar.glb'),
  },
  {
    name: 'import glTF, a hierarchy with no rig',
    files: ['src/core/import/nativeGltfImport.ts', 'src/core/import/modelImport.ts'],
    run: (s) => importGltf(s, 'src/core/import/__fixtures__/rigless-hierarchy-blender-default.glb'),
  },
  {
    name: 'import FBX, rig',
    files: ['src/core/import/fbxImportChain.ts', 'src/core/import/skeletonObject.ts'],
    run: (s) => importMotion(s, 'public/fixtures/anim/rig.fbx'),
  },
  {
    name: 'import FBX, a character',
    files: ['src/core/import/fbxImportChain.ts'],
    run: (s) => importMotion(s, 'src/core/import/__fixtures__/rigged-scene-blender-default.fbx'),
  },
  {
    name: 'import FBX, a model with no rig',
    files: ['src/core/import/fbxImportChain.ts', 'src/core/import/modelImport.ts'],
    run: (s) =>
      importMotion(s, 'src/core/import/__fixtures__/rigless-hierarchy-blender-default.fbx'),
  },
  {
    name: 'import BVH',
    files: ['src/core/import/bvhImportChain.ts', 'src/core/import/skeletonObject.ts'],
    run: (s) => importMotion(s, 'public/assets/motion/walk.bvh'),
  },
  // A file conversion that makes a scene object: the empty an old aim point becomes.
  {
    name: 'load a file saved before v27: a spot light aimed at a point',
    files: ['src/core/project/migrations.ts'],
    arrange: (s) => {
      const made = makeSplitLight(s, {
        lightKind: 'Spot',
        objectId: 'old_spot',
        connectTo: { node: s.outputs.scene!.node, socket: 'lights' },
      });
      return apply(made.state, [
        { type: 'setParam', nodeId: made.dataId, paramPath: 'target', value: [0, 0, 0] },
      ]);
    },
    run: (s) =>
      (migrateLightAimToTurn({ formatVersion: 26, state: s }) as { state: DagState }).state,
  },
];

/**
 * Every non-test file that can create a node, and why it needs no run of its own. A file with no
 * entry here must be named by a door above, and one named by a door must not be here.
 */
const CREATES_NO_SCENE_OBJECT: Record<string, string> = {
  'src/agent/mutators/builders/addAIPass.ts': 'a ComfyUI workflow and its prompt; no scene node',
  'src/agent/mutators/builders/addChannel.ts': 'a keyframe channel, a sidecar',
  'src/agent/mutators/builders/addPass.ts': 'a render pass, an Image',
  'src/agent/mutators/builders/addStitch.ts': 'a VideoStitch, an Image',
  'src/agent/mutators/builders/addStrip.ts': 'an NLA strip and its track',
  'src/agent/mutators/builders/createAction.ts': 'an Action, keys only',
  'src/agent/mutators/builders/poseBone.ts': 'a pose layer',
  'src/agent/mutators/builders/retarget.ts': 'a retarget clip and its bone map',
  'src/app/animate/addIk.ts': 'a pose layer',
  'src/app/animate/bakePose.ts': 'a pose layer',
  'src/app/animate/dispatchApplyTransform.ts': 'a BakedData an existing Object reads',
  'src/app/animate/dispatchMutator.ts': 'keyframe channels and a declared sidecar',
  'src/app/animate/wrapInRig.ts': 'a Rig sub-network on an existing pose',
  'src/app/asset/importMediaClip.ts': 'a MediaClip, an Image',
  'src/app/CameraLookAtTarget.tsx': 'a Track-To on an existing camera',
  'src/app/character/walkTo.ts': 'a clock and a WalkPath, not scene nodes',
  'src/app/driverBind.ts': 'a ParamDriver',
  'src/app/materialLink.ts': 'a Material, a resource',
  'src/app/operatorStack.ts': 'an operator on a data, material or effect lane; none is SceneObject',
  'src/app/shotOps.ts': 'a keyframe channel',
  'src/app/shotSpeed.ts': 'a keyframe channel',
  'src/app/solverBind.ts': 'a ParamDriver',
  'src/app/springBody.ts': 'a Solver and its body, numbers and vectors',
  'src/app/video/addLayer.ts': 'a Composition layer',
  'src/app/video/newComposition.ts': 'a Composition',
  // `ops.ts` builds an `addNode` as the inverse of a `removeNode`: undo puts back a node that was.
  'src/core/dag/ops.ts': 'the inverse of removeNode, restoring what was there',
};

/** A file that creates scene objects and is deliberately not run, with why. */
const NOT_RUN: Record<string, string> = {
  'src/app/boot.ts':
    'the perf harness seam `__basher_perf_stress` (no product caller), inside the boot module this ' +
    'test mocks. By reading only: it wires each sphere it makes to Scene.children.',
};

/** Whole projects: every scene object they hold, rather than what a door added. */
const WHOLE_PROJECTS = ['src/core/project/default.ts', 'src/core/project/examples.ts'];

/** Does this code create a node? See the header. */
function createsNodes(code: string, recordTypes: readonly string[]): boolean {
  if (/type:\s*['"]addNode['"]/.test(code)) return true;
  return new RegExp(`\\btype:\\s*['"](${recordTypes.join('|')})['"]`).test(code);
}

describe('#1822 — every door that creates a scene object leaves it in the scene', () => {
  describe.each([
    ['the scene collection active', false],
    ['a collection active', true],
  ])('with %s', (_label, active) => {
    it.each(DOORS.map((d) => [d.name, d] as const))('%s', async (_name, door) => {
      const start = startingState(active);
      const before = door.arrange ? door.arrange(start) : start;
      const after = await door.run(before);
      const made = newSceneObjects(before, after);
      expect(made.filter((id) => !isInScene(after, id))).toEqual([]);
      // #1518 — and it has a name of its own, so the outliner never shows it by its id.
      expect(made.filter((id) => !followableName(after.nodes[id]))).toEqual([]);
      // A door that makes one object must not cost the scene another: Ctrl+Shift+C replaces the
      // active camera, which stays one of the scene's cameras.
      const gone = (id: string) =>
        after.nodes[id] && !isInScene(after, id) && !ownedBySubnetwork(after).has(id);
      expect(
        [...sceneMembersOf(before)].filter(
          (id) => !HOP_TYPES.has(before.nodes[id].type) && gone(id),
        ),
      ).toEqual([]);
    });
  });

  it('a project an old Add left a floating camera in stands it in the scene on load', () => {
    const s0 = startingState(false);
    const { state: s } = makeSplitCamera(s0, { objectId: 'floating' });
    expect(isInScene(s, 'floating')).toBe(false);
    const repaired = repairFloatingCameras(s);
    expect(repaired.repaired).toEqual(['floating']);
    expect(isInScene(repaired.state, 'floating')).toBe(true);
    // Idempotent, and hands back the same state when there is nothing to do.
    expect(repairFloatingCameras(repaired.state).state).toBe(repaired.state);
    // And both load doors go through it (`loadProject`, `sceneBundle`).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = { id: 'old', state: s } as unknown as Project;
    expect(isInScene(repairAndWarn(project).state, 'floating')).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toContain('floating');
    warn.mockRestore();
  });

  it('the census can fail: a scene object nothing wires is caught', () => {
    const before = startingState(false);
    const after = apply(before, [
      { type: 'addNode', nodeId: 'stray', nodeType: 'Null', params: {} },
    ]);
    expect(newSceneObjects(before, after)).toEqual(['stray']);
    expect(isInScene(after, 'stray')).toBe(false);
  });

  it('it sees what the doors make: Add ▸ Cube makes one scene object, and its data is not one', () => {
    const before = startingState(false);
    const after = add(before, 'Cube');
    expect(newSceneObjects(before, after)).toHaveLength(1);
  });

  it('the bundled projects hold every scene object they carry', async () => {
    const strays: string[] = [];
    const projects = [
      { id: 'default', state: buildDefaultDagState() },
      ...(await buildAllExampleProjects()),
    ];
    for (const project of projects) {
      const nothing = { ...project.state, nodes: {} };
      for (const id of newSceneObjects(nothing, project.state))
        if (!isInScene(project.state, id)) strays.push(`${project.id}: ${id}`);
    }
    expect(strays).toEqual([]);
  }, 60_000);
});

describe('#1822 — the scan: a new creating file has to say what it is', () => {
  const recordTypes = () => [...sceneObjectTypes()];
  const creators = () =>
    sourceFiles()
      .filter(([path]) => !path.startsWith('src/nodes/') && !/\/tmp-/.test(path))
      .filter(([path]) => !path.startsWith('src/test-utils/'))
      .filter(([, src]) => createsNodes(stripComments(src), recordTypes()))
      .map(([path]) => path)
      .sort();

  it('every file that can create a node has a door, or says why it needs none', () => {
    const accounted = new Set([
      ...DOORS.flatMap((d) => d.files),
      ...Object.keys(CREATES_NO_SCENE_OBJECT),
      ...Object.keys(NOT_RUN),
      ...WHOLE_PROJECTS,
    ]);
    expect(creators().filter((path) => !accounted.has(path))).toEqual([]);
  });

  it('nothing listed has stopped creating nodes, so a stale entry cannot hide a new door', () => {
    const found = new Set(creators());
    const listed = [
      ...DOORS.flatMap((d) => d.files),
      ...Object.keys(CREATES_NO_SCENE_OBJECT),
      ...Object.keys(NOT_RUN),
      ...WHOLE_PROJECTS,
    ];
    expect([...new Set(listed)].filter((path) => !found.has(path))).toEqual([]);
  });

  it('the predicate sees an op, a record, and neither (positive and negative control)', () => {
    const types = recordTypes();
    expect(createsNodes("ops.push({ type: 'addNode', nodeId: id })", types)).toBe(true);
    expect(createsNodes("nodes[id] = { id, type: 'Null', inputs: {} };", types)).toBe(true);
    expect(createsNodes("if (node.type === 'Null') return;", types)).toBe(false);
    expect(createsNodes("{ type: 'connect', from, to }", types)).toBe(false);
  });

  it('a creating file that is new turns the scan red (control)', () => {
    const accounted = new Set(creators());
    expect(accounted.has('src/app/aNewDoor.ts')).toBe(false);
    const withNew = [...accounted, 'src/app/aNewDoor.ts'];
    expect(withNew.filter((path) => !accounted.has(path))).toEqual(['src/app/aNewDoor.ts']);
  });
});
