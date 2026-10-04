// #1453 — every object that stands in the scene joins the active collection, not only an import's.
// Blender 5.1.1 (headless, observed): with a collection active, `primitive_cube_add` lands in it and
// `object.duplicate` lands in its source's collections; with the scene collection active, an added
// object joins none. Lights and cameras join too, now their drawers honour a hidden one.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildAddPrimitiveOps } from './addPrimitives';
import { mintMotionGenerateOps } from './asset/mintMotionGenerate';
import {
  collectionMembersOf,
  hiddenByCollection,
  newCollectionOps,
  setActiveCollectionOp,
} from './collections';
import { buildDuplicateNodeOps } from './sceneNodeActions';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildAddStudioLightOps } from './addStudioLight';
import { buildAddProfileOps } from './studioProfiles';
import { buildImportProfilesOps } from './studioProfileIO';
import { collectableNodes, collectionsHolding } from './collections';
import { cameraTrajectoryMutator } from '../agent/mutators/builders/cameraTrajectory';
import { validatePlan } from '../agent/mutators/validate';
import { cameraSnapshotTool } from '../agent/tools/cameraSnapshot';
import { isCameraNode } from './cameraNode';
import { buildSceneTreeRows } from './sceneTreeWalk';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

/** The default project with one new collection; `active` makes it the active one. */
function withCollection(active: boolean): { state: DagState; col: string } {
  let s = buildDefaultDagState();
  const made = newCollectionOps(s)!;
  s = apply(s, made.ops);
  if (active) s = apply(s, [setActiveCollectionOp(s, made.collectionId)!]);
  return { state: s, col: made.collectionId };
}

const add = (s: DagState, kind: Parameters<typeof buildAddPrimitiveOps>[1]) => {
  const r = buildAddPrimitiveOps(s, kind, [0, 0, 0])!;
  return { state: apply(s, r.ops), id: r.newNodeId };
};

describe('#1453 — Add links into the active collection', () => {
  it.each(['Cube', 'Sphere', 'Curve', 'Null'] as const)(
    'a %s added with a collection active is its member, and its hide hides it',
    (kind) => {
      const { state, col } = withCollection(true);
      const { state: s, id } = add(state, kind);
      expect(collectionMembersOf(s, col)).toEqual([id]);
      const hidden = apply(s, [
        { type: 'setParam', nodeId: col, paramPath: 'viewport', value: false },
      ]);
      expect(hiddenByCollection(hidden, 'viewport').has(id)).toBe(true);
    },
  );

  it('with the scene itself active, an added cube joins no collection', () => {
    const { state, col } = withCollection(false);
    const { state: s } = add(state, 'Cube');
    expect(collectionMembersOf(s, col)).toEqual([]);
  });

  it.each(['PointLight', 'DirectionalLight', 'PerspectiveCamera', 'OrthographicCamera'] as const)(
    'a %s joins it too, and its hide hides it (#1453 — its drawer honours one now)',
    (kind) => {
      const { state, col } = withCollection(true);
      const { state: s, id } = add(state, kind);
      expect(collectionMembersOf(s, col)).toEqual([id]);
      const hidden = apply(s, [
        { type: 'setParam', nodeId: col, paramPath: 'viewport', value: false },
      ]);
      expect(hiddenByCollection(hidden, 'viewport').has(id)).toBe(true);
    },
  );

  it.each(['Material', 'Math'] as const)('a %s is not a scene object and joins nothing', (kind) => {
    const { state, col } = withCollection(true);
    const { state: s } = add(state, kind);
    expect(collectionMembersOf(s, col)).toEqual([]);
  });
});

describe('#1453 — generated motion links its rig Object into the active collection', () => {
  const ARGS = { prompt: 'a walk', seed: 1, model: 'kimodo' };
  it('active collection → the rig Object is a member; none active → it is in none', () => {
    for (const active of [true, false]) {
      const { state, col } = withCollection(active);
      const minted = mintMotionGenerateOps(state, ARGS);
      const s = apply(state, minted.ops);
      expect(minted.objectId).toBeDefined();
      expect(collectionMembersOf(s, col)).toEqual(active ? [minted.objectId] : []);
    }
  });
});

describe('#1453 — a duplicate joins its source’s collections', () => {
  it('the copy of a member is a member of the same collection; the copy of a non-member is not', () => {
    const { state, col } = withCollection(true);
    const { state: s1, id: member } = add(state, 'Cube');
    const s2 = apply(s1, [setActiveCollectionOp(s1, null)!]);
    const { state: s3, id: loose } = add(s2, 'Cube');
    expect(collectionMembersOf(s3, col)).toEqual([member]);

    const dupMember = buildDuplicateNodeOps(s3, member)!;
    const s4 = apply(s3, dupMember.ops);
    expect(collectionMembersOf(s4, col)).toEqual([member, dupMember.newRootId]);

    const dupLoose = buildDuplicateNodeOps(s4, loose)!;
    const s5 = apply(s4, dupLoose.ops);
    expect(collectionMembersOf(s5, col)).toEqual([member, dupMember.newRootId]);
  });
});

/** Whether `id` is one of `col`'s members and its hide hides it — membership the drawers honour. */
function joined(s: DagState, col: string, id: string): boolean {
  const hidden = apply(s, [{ type: 'setParam', nodeId: col, paramPath: 'viewport', value: false }]);
  return collectionMembersOf(s, col).includes(id) && hiddenByCollection(hidden, 'viewport').has(id);
}

describe('#1477 — the agent’s camera trajectory links its path into the active collection', () => {
  const plan = (state: DagState) => {
    const camera = Object.keys(state.nodes).find((id) => isCameraNode(state, id))!;
    const spec = cameraTrajectoryMutator.spec.parse({
      cameraId: camera,
      aimPoint: [0, 0, 0],
      points: [
        [4, 2, 3],
        [0, 2, 5],
        [-4, 2, 3],
      ],
      name: 'arc',
    });
    // Through all five gates: the join is a connect onto the collection, which gate 3 refuses
    // unless the mutator's closure reaches it.
    const r = validatePlan(cameraTrajectoryMutator, spec, state, 'a camera arc');
    expect(r.ok, r.ok ? '' : `${r.label}: ${r.reason}`).toBe(true);
    return r.ok ? r.ops : [];
  };
  const curveObjectOf = (ops: readonly Op[]) =>
    ops.find(
      (o): o is Extract<Op, { type: 'addNode' }> => o.type === 'addNode' && o.nodeType === 'Object',
    )!.nodeId;

  it('active collection → the curve Object is a member; none active → it is in none', () => {
    for (const active of [true, false]) {
      const { state, col } = withCollection(active);
      const ops = plan(state);
      const s = apply(state, ops);
      const curve = curveObjectOf(ops);
      expect(active ? joined(s, col, curve) : collectionsHolding(s, curve)).toEqual(
        active ? true : [],
      );
    }
  });
});

describe('#1504 — a camera snapshot links its camera into the active collection', () => {
  it('camera.snapshot: active collection → the camera Object is a member; none active → none', async () => {
    for (const active of [true, false]) {
      const { state, col } = withCollection(active);
      const r = await cameraSnapshotTool.handler(
        { fov: 45, position: [3, 2, 3], lookAt: [0, 0, 0] },
        { dagState: state },
      );
      const s = apply(state, r.ops);
      const cam = r.ops.find(
        (o): o is Extract<Op, { type: 'addNode' }> =>
          o.type === 'addNode' && o.nodeType === 'Object',
      )!.nodeId;
      expect(active ? joined(s, col, cam) : collectionsHolding(s, cam)).toEqual(active ? true : []);
    }
  });
});

describe('#1480 — studio lights join the active collection, and a rig’s lights are reachable', () => {
  it('“+ Light” with no profile: the light is a member', () => {
    const { state, col } = withCollection(true);
    const r = buildAddStudioLightOps(state, [0, 0, 0])!;
    const s = apply(state, r.ops);
    expect(joined(s, col, r.lightId)).toBe(true);
  });

  it('“+ Light” into a profile: the light is a member, collectable, and Move to Collection reaches it', () => {
    const { state, col } = withCollection(true);
    const prof = buildAddProfileOps(state, 'Key', [0, 0, 0])!;
    const s1 = apply(state, prof.ops);
    const r = buildAddStudioLightOps(s1, [0, 0, 0], prof.rigId)!;
    const s = apply(s1, r.ops);
    expect(joined(s, col, r.lightId)).toBe(true);
    expect(collectableNodes(s).has(r.lightId)).toBe(true);
    // The outliner lists it, so its eye is there to click — under the rig's own `lights` list,
    // the socket a drag reorders, as a scene light's row carries the scene's.
    const row = buildSceneTreeRows(s).find((r2) => r2.nodeId === r.lightId);
    expect(row?.parent).toEqual({ nodeId: prof.rigId, socket: 'lights', index: 0 });
  });

  it('a free studio light the first profile adopts stays collectable, and keeps its collection', () => {
    const { state, col } = withCollection(true);
    const add = buildAddStudioLightOps(state, [0, 0, 0])!;
    const s1 = apply(state, add.ops);
    const s = apply(s1, buildAddProfileOps(s1, 'Key', [0, 0, 0])!.ops);
    expect(collectableNodes(s).has(add.lightId)).toBe(true);
    expect(joined(s, col, add.lightId)).toBe(true);
  });

  it('loading a profiles file links every light it makes, as an importer links what it makes', () => {
    const { state, col } = withCollection(true);
    const light = {
      position: [0, 3, 4] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      intensity: 5,
      color: '#ffffff',
      width: 1,
      height: 1,
    };
    const r = buildImportProfilesOps(state, {
      version: 1,
      profiles: [{ name: 'Key', center: [0, 0, 0], radius: 6, lights: [light, light] }],
    } as Parameters<typeof buildImportProfilesOps>[1]);
    const s = apply(state, r.ops);
    const lights = r.ops.flatMap((o) =>
      o.type === 'addNode' && o.nodeType === 'Object' ? [o.nodeId] : [],
    );
    expect(lights.length, 'the premise: the file made lights').toBe(2);
    expect(collectionMembersOf(s, col)).toEqual(lights);
  });
});

describe('#1480 / #1504 — every door that adds an object joins the active collection', () => {
  // A census by what a file CREATES, not by the socket it wires to: a camera is wired to
  // `scene.camera` and a rig light to its rig, so a census of `children`/`lights` wiring missed
  // both. Every non-test source file that adds an Object or a Group goes through the join, or is
  // listed here with the reason it does not need to — and a listed helper names the caller
  // that joins for it, which must itself join.
  const NOT_A_DOOR: Record<string, string> = {
    'src/app/sceneTreeWalk.ts': 'an outliner row naming a node type; adds nothing',
    'src/core/project/default.ts': 'the new project; no collection exists to be active',
    'src/core/project/examples.ts': 'example projects, built whole; no collection is active',
  };
  const JOINED_BY_CALLER: Record<string, string> = {
    'src/core/import/modelImport.ts': 'src/app/asset/importGltf.ts',
    'src/core/import/nativeGltfImport.ts': 'src/app/asset/importGltf.ts',
    'src/core/import/fbxImportChain.ts': 'src/app/asset/importBvhFbx.ts',
    'src/core/import/skeletonObject.ts': 'src/app/asset/importBvhFbx.ts',
  };
  const JOIN = /\b(linkIntoActiveCollection|intoActiveCollection)\(/;
  const ADDS = /nodeType: '(Object|Group)'/;
  const root = join(__dirname, '..', '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'test-utils' ? [] : files(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.startsWith('tmp-')
        ? [relative(root, path)]
        : [];
    });
  const doors = files(join(root, 'src')).filter((f) =>
    ADDS.test(readFileSync(join(root, f), 'utf8')),
  );

  it('the premise: the census sees the doors it is about', () => {
    expect(doors).toEqual(
      expect.arrayContaining(['src/app/addPrimitives.ts', 'src/app/addStudioLight.ts']),
    );
  });

  it('each one joins, or says why it need not', () => {
    const unjoined = doors.filter(
      (f) =>
        !(f in NOT_A_DOOR) &&
        !JOIN.test(readFileSync(join(root, f), 'utf8')) &&
        !(
          f in JOINED_BY_CALLER && JOIN.test(readFileSync(join(root, JOINED_BY_CALLER[f]), 'utf8'))
        ),
    );
    expect(unjoined).toEqual([]);
  });

  it('every listed exemption is still a door, so a stale entry cannot hide a new one', () => {
    expect(
      [...Object.keys(NOT_A_DOOR), ...Object.keys(JOINED_BY_CALLER)].filter(
        (f) => !doors.includes(f),
      ),
    ).toEqual([]);
  });
});
