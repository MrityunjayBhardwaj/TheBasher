// #1518 — every new object gets a name when it is made: Blender's word for it, numbered `.001` when
// the word is taken. What each door names is run through the door; `sceneObjectDoors.gate.test.ts`
// checks that every door names what it makes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { cameraSnapshotTool } from '../agent/tools/cameraSnapshot';
import { __resetRegistryForTests, applyOps, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { makeSplitCube } from '../test-utils/splitCube';
import { makeSplitLight } from '../test-utils/splitLight';
import { SCENE_OBJECT_KINDS, buildAddPrimitiveOps, type SceneObjectKind } from './addPrimitives';
import { buildAddStudioLightOps } from './addStudioLight';
import { buildCameraFromViewOps } from './character/cameraFromView';
import { buildAddConstraintOps } from './constraintStack';
import { freshAimedNames, freshObjectName, numberedName, objectBaseName } from './objectNames';
import { buildDuplicateNodesOps } from './sceneNodeActions';
import { buildImportProfilesOps } from './studioProfileIO';
import { nodeDisplayName } from './sceneTreeWalk';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (s: DagState, ops: readonly Op[]) => applyOps(s, ops).next;
const nameOf = (s: DagState, id: string) => nodeDisplayName(s.nodes, id);

/** The default project with its objects' names cleared, so a word's first use is unnumbered. */
const blank = (): DagState => {
  const s = buildDefaultDagState();
  return {
    ...s,
    nodes: Object.fromEntries(
      Object.values(s.nodes).map((n) => {
        const { name: _name, ...meta } = n.meta ?? {};
        void _name;
        return [n.id, { ...n, meta }];
      }),
    ),
  };
};

const add = (s: DagState, kind: SceneObjectKind) => {
  const r = buildAddPrimitiveOps(s, kind, [0, 1, 2])!;
  return { state: apply(s, r.ops), id: r.newNodeId, aim: r.aimNodeId };
};

const EXPECTED: Record<SceneObjectKind, string> = {
  Cube: 'Cube',
  Sphere: 'Sphere',
  DirectionalLight: 'Sun',
  PointLight: 'Point',
  SpotLight: 'Spot',
  AreaLight: 'Area',
  AmbientLight: 'Ambient',
  PerspectiveCamera: 'Camera',
  OrthographicCamera: 'Camera',
  Group: 'Empty',
  Transform: 'Transform',
  Null: 'Empty',
  Curve: 'Curve',
  Armature: 'Armature',
};

describe('#1518 — Add names what it makes', () => {
  it.each(SCENE_OBJECT_KINDS)('Add ▸ %s, then again', (kind) => {
    const one = add(blank(), kind);
    expect(nameOf(one.state, one.id)).toBe(EXPECTED[kind]);
    const two = add(one.state, kind);
    expect(nameOf(two.state, two.id)).toBe(`${EXPECTED[kind]}.001`);
    const three = add(two.state, kind);
    expect(nameOf(three.state, three.id)).toBe(`${EXPECTED[kind]}.002`);
  });

  it('a light that comes aimed has an empty named after it, and neither name is shared', () => {
    const one = add(blank(), 'SpotLight');
    const two = add(one.state, 'SpotLight');
    expect(nameOf(one.state, one.aim!)).toBe('Spot.aim');
    expect(nameOf(two.state, two.id)).toBe('Spot.001');
    expect(nameOf(two.state, two.aim!)).toBe('Spot.001.aim');
  });

  it('what is not a scene object is left unnamed', () => {
    for (const kind of ['Material', 'Math'] as const) {
      const r = buildAddPrimitiveOps(blank(), kind, [0, 0, 0])!;
      expect(r.ops.some((op) => op.type === 'setMeta')).toBe(false);
    }
  });

  it('a word already in use by a rename is not reused', () => {
    const s0 = blank();
    const made = makeSplitCube(s0, {
      objectId: 'mine',
      connectTo: { node: s0.outputs.scene!.node, socket: 'children' },
    }).state;
    const named = apply(made, [{ type: 'setMeta', nodeId: 'mine', name: 'Cube' }]);
    const next = add(named, 'Cube');
    expect(nameOf(next.state, next.id)).toBe('Cube.001');
  });
});

describe('#1518 — Shift+D and Ctrl+Shift+C name what they make', () => {
  it('Shift+D twice on a cube: Cube.001, Cube.002', () => {
    const one = add(blank(), 'Cube');
    const d1 = buildDuplicateNodesOps(one.state, [one.id])!;
    const s1 = apply(one.state, d1.ops);
    expect(nameOf(s1, d1.newRootIds[0])).toBe('Cube.001');
    const d2 = buildDuplicateNodesOps(s1, [one.id])!;
    const s2 = apply(s1, d2.ops);
    expect(nameOf(s2, d2.newRootIds[0])).toBe('Cube.002');
  });

  it('Shift+D on an object an old file left unnamed: named for its kind, not `<id>_copy`', () => {
    const s0 = blank();
    const { state } = makeSplitCube(s0, {
      objectId: 'old_box',
      connectTo: { node: s0.outputs.scene!.node, socket: 'children' },
    });
    const d = buildDuplicateNodesOps(state, ['old_box'])!;
    const after = apply(state, d.ops);
    expect(nameOf(after, 'old_box')).toBe('old_box');
    expect(nameOf(after, d.newRootIds[0])).toBe('Cube');
  });

  it('Ctrl+Shift+C: Camera, and the next is Camera.001', () => {
    const view = () => {
      const camera = new THREE.PerspectiveCamera(50);
      camera.position.set(3, 2, 3);
      return { camera, target: new THREE.Vector3(), seconds: 0 };
    };
    const s0 = blank();
    const named = (s: DagState) =>
      Object.values(s.nodes)
        .map((n) => n.meta?.name)
        .filter((n) => n?.startsWith('Camera'))
        .sort();
    // Its id is the clock's, so two presses are two moments.
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1000);
    const s1 = apply(s0, buildCameraFromViewOps(s0, view())!.ops);
    expect(named(s1)).toEqual(['Camera']);
    now.mockReturnValue(2000);
    const s2 = apply(s1, buildCameraFromViewOps(s1, view())!.ops);
    now.mockRestore();
    expect(named(s2)).toEqual(['Camera', 'Camera.001']);
  });

  it('camera.snapshot and Light Studio ▸ + Light name theirs too', async () => {
    const s0 = blank();
    const snap = await cameraSnapshotTool.handler(
      { fov: 45, position: [3, 2, 3], lookAt: [0, 0, 0] },
      { dagState: s0 },
    );
    const s1 = apply(s0, snap.ops);
    expect(Object.values(s1.nodes).some((n) => n.meta?.name === 'Camera')).toBe(true);
    const light = buildAddStudioLightOps(s1, [0, 0, 0])!;
    const s2 = apply(s1, light.ops);
    expect(nameOf(s2, light.lightId)).toBe('Area');
  });
});

describe('#1518 — roads other than Add name what they aim with', () => {
  it('a Track-To on each of two unnamed spots: neither empty shares a name', () => {
    let s = blank();
    const ids = ['spot_a', 'spot_b'];
    const made: string[] = [];
    for (const id of ids) {
      s = makeSplitLight(s, {
        lightKind: 'Spot',
        objectId: id,
        connectTo: { node: s.outputs.scene!.node, socket: 'lights' },
      }).state;
      const before = new Set(Object.keys(s.nodes));
      s = apply(s, buildAddConstraintOps(s, id, 'TrackTo')!.ops);
      const empty = Object.values(s.nodes).find((n) => !before.has(n.id) && n.type === 'Null')!;
      made.push(nameOf(s, empty.id));
    }
    expect(made).toEqual(['Spot.aim', 'Spot.aim.001']);
  });

  it('a light that comes aimed skips a number whose `.aim` is taken, so the pair still reads', () => {
    expect(freshAimedNames('Sun', new Set(['Sun.aim']))).toEqual({
      name: 'Sun.001',
      aim: 'Sun.001.aim',
    });
  });

  it('a profiles file with two lights names both, and their empties, apart', () => {
    const light = {
      position: [0, 3, 4] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      intensity: 5,
      color: '#ffffff',
      width: 1,
      height: 1,
    };
    const s0 = blank();
    const r = buildImportProfilesOps(s0, {
      version: 1,
      profiles: [{ name: 'Key', center: [0, 0, 0], radius: 6, lights: [light, light] }],
    } as Parameters<typeof buildImportProfilesOps>[1]);
    const names = r.ops.flatMap((o) => (o.type === 'setMeta' && o.name ? [o.name] : [])).sort();
    expect(names).toEqual(['Area', 'Area.001', 'Area.001.aim', 'Area.aim']);
  });
});

describe('#1518 — the numbering', () => {
  it('a free name is kept, a taken one numbered from the first gap', () => {
    const taken = new Set(['Cube', 'Cube.001', 'Cube.003']);
    expect(freshObjectName('Sphere', taken)).toBe('Sphere');
    expect(freshObjectName('Cube', taken)).toBe('Cube.002');
    expect(freshObjectName('Cube', taken)).toBe('Cube.004');
  });
  it('a numbered name starts again from its base', () => {
    expect(numberedName('Cube.007', new Set(['Cube']))).toBe('Cube.001');
    // Not every dot is a number Blender wrote.
    expect(numberedName('Spot.aim', new Set())).toBe('Spot.aim.001');
    expect(numberedName('v1.2', new Set())).toBe('v1.2.001');
  });
  it('an object of no known word reads Object; a data block is no object', () => {
    expect(objectBaseName({ type: 'Object', params: {} })).toBe('Object');
    expect(objectBaseName({ type: 'BoxData', params: {} })).toBeUndefined();
  });
});
