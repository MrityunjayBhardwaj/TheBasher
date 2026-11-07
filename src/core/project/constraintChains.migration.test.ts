// #1812 — saved constraint stacks open as wired chains, every object drawing where it did.
//
// The poses are recorded from the old road into `__fixtures__/constraintChains.poses.json`, so this
// still holds once that road is gone (#1813). While it exists, the first test proves the recording
// is what it draws. Regenerate with RECORD_CHAIN_POSES=1, only from a tree where the old road draws.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { applyOp, evaluate, __resetRegistryForTests, type DagState } from '../dag';
import {
  resolveDrawnParentWorldMatrix,
  resolveDrawnWorldTransform,
} from '../../app/drawnWorldTransform';
import {
  relationalPoseStackForTarget,
  resolveConstraintPosition,
  resolveConstraintRotation,
} from '../../app/nodeConstraints';
import { registerAllNodes } from '../../nodes/registerAll';
import { withIds } from '../../test-utils/curvePoints';
import { makeSplitCube } from '../../test-utils/splitCube';
import { buildDefaultDagState } from './default';
import { EXAMPLE_PROJECT_IDS, buildExampleProject } from './examples';
import { migrateConstraintsToChains } from './migrations';

type Vec3 = [number, number, number];
const TIMES = [0, 0.5, 1.3, 3];
const at = (seconds: number) => ({
  time: { frame: Math.round(seconds * 24), seconds, normalized: 0 },
});
const POSES = join(__dirname, '__fixtures__/constraintChains.poses.json');

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const run = (s: DagState, ops: object[]) => {
  for (const o of ops) s = applyOp(s, o as never).next;
  return s;
};
const wire = (from: string, socket: string, node: string, into: string) => ({
  type: 'connect',
  from: { node: from, socket },
  to: { node, socket: into },
});
const add = (nodeId: string, nodeType: string, params: object = {}) => ({
  type: 'addNode',
  nodeId,
  nodeType,
  params,
});
const cube = (s: DagState, objectId: string, position: Vec3) =>
  makeSplitCube(s, {
    objectId,
    position,
    connectTo: { node: 'n_scene', socket: 'children' },
  }).state;
/** An object in the scene that hangs from `parent`: membership and parenting are separate wires. */
const hung = (id: string, parent: string, params: object) => [
  add(id, 'Object', params),
  wire(parent, 'world', id, 'parent'),
  wire(id, 'out', 'n_scene', 'children'),
];
const line = (params: object = {}) => [
  add('cv_d', 'CurveData', {
    points: withIds([
      [0, 0, 0],
      [10, 0, 0],
    ]),
    closed: false,
    resolution: 32,
  }),
  add('cv', 'Object', params),
  wire('cv_d', 'out', 'cv', 'data'),
  wire('cv', 'out', 'n_scene', 'children'),
];
const convert = (s: DagState) =>
  (migrateConstraintsToChains({ state: s }) as { state: DagState }).state;

const base = () => buildDefaultDagState();
const pair = () => cube(cube(base(), 'a', [1, 0, 0]), 'h', [4, 3, 0]);
const follower = () => cube(base(), 'a', [0, 4, 0]);
const underGroup = (scale: Vec3) => {
  const s = run(base(), [
    add('g', 'Group', { position: [1, 2, 3], rotation: [40, 0, 25], scale }),
    wire('g', 'out', 'n_scene', 'children'),
    add('gk', 'KeyframeChannelVec3', {
      target: 'g',
      paramPath: 'rotation',
      keyframes: [
        { time: 0, value: [40, 0, 25] },
        { time: 3, value: [40, 90, 25] },
      ],
    }),
  ]);
  return run(cube(s, 'h', [4, 0, 0]), [
    ...hung('a', 'g', { position: [0, 1, 0], scale: [2, 1, 1] }),
    add('tt', 'TrackTo', { target: 'a', aimNode: 'h' }),
    ...hung('kid', 'a', { position: [1, 0, 0] }),
  ]);
};
const evalKey = (target: string, duration = 3) =>
  add(`${target}_key`, 'KeyframeChannelNumber', {
    target,
    paramPath: 'evalTime',
    keyframes: [
      { time: 0, value: 0 },
      { time: duration, value: 1 },
    ],
  });

/** Every fixture that must draw as before, at every time and for every object. */
const SAME: Record<string, () => DagState> = {
  'one aim': () => run(pair(), [add('t', 'TrackTo', { target: 'a', aimNode: 'h' })]),
  'order by the field, a muted one on top': () =>
    run(pair(), [
      add('t1', 'TrackTo', { target: 'a', aimPoint: [0, 9, 0], order: 1 }),
      add('t0', 'TrackTo', { target: 'a', aimNode: 'h', order: 2 }),
      add('tm', 'TrackTo', { target: 'a', aimPoint: [9, 9, 9], order: 3, mute: true }),
    ]),
  'a tie keeps node-table order': () =>
    run(pair(), [
      add('t1', 'TrackTo', { target: 'a', aimPoint: [0, 9, 0] }),
      add('t2', 'TrackTo', { target: 'a', aimNode: 'h' }),
    ]),
  'a roll, keyed, with a muted aim below': () =>
    run(pair(), [
      add('tm', 'TrackTo', { target: 'a', aimPoint: [1, 9, 3], mute: true }),
      add('t', 'TrackTo', { target: 'a', aimPoint: [5, 2, 3], order: 1 }),
      add('k', 'KeyframeChannelNumber', {
        target: 't',
        paramPath: 'roll',
        keyframes: [
          { time: 0, value: 0 },
          { time: 3, value: 90 },
        ],
      }),
    ]),
  'a follower with its own position': () =>
    run(follower(), [
      ...line(),
      add('f', 'FollowPath', { target: 'a', curve: 'cv', evalTime: 0.5 }),
    ]),
  'on a turned curve': () =>
    run(follower(), [
      ...line({ rotation: [0, 0, 90] }),
      add('f', 'FollowPath', { target: 'a', curve: 'cv', evalTime: 1 }),
    ]),
  'a keyed path': () =>
    run(follower(), [
      ...line(),
      add('f', 'FollowPath', { target: 'a', curve: 'cv' }),
      evalKey('f'),
    ]),
  'keys on the own position of a follower, which moved nothing': () =>
    run(follower(), [
      ...line(),
      add('kp', 'KeyframeChannelVec3', {
        target: 'a',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [1, 2, 3] },
          { time: 3, value: [9, 9, 9] },
        ],
      }),
      add('f', 'FollowPath', { target: 'a', curve: 'cv', evalTime: 0.5 }),
    ]),
  'a muted Follow Path leaves the position alone': () =>
    run(follower(), [
      ...line(),
      add('f', 'FollowPath', { target: 'a', curve: 'cv', evalTime: 0.5, mute: true }),
    ]),
  'a Follow Path naming the curve data, not its object, places nothing': () =>
    run(follower(), [
      ...line(),
      add('f', 'FollowPath', { target: 'a', curve: 'cv_d', evalTime: 0.5 }),
    ]),
  'a Follow Path naming an object that holds no curve places nothing': () =>
    run(cube(follower(), 'box', [7, 7, 7]), [
      add('f', 'FollowPath', { target: 'a', curve: 'box', evalTime: 0.5 }),
    ]),
  'a Follow Path naming nothing': () =>
    run(follower(), [add('f', 'FollowPath', { target: 'a', curve: 'gone', evalTime: 0.5 })]),
  'aim stacked below a path aims from the path, as it was drawn': () =>
    run(follower(), [
      ...line(),
      add('tt', 'TrackTo', { target: 'a', aimPoint: [5, 9, 0], order: 0 }),
      add('f', 'FollowPath', { target: 'a', curve: 'cv', evalTime: 0.5, order: 1 }),
    ]),
  'aim stacked above a path': () =>
    run(follower(), [
      ...line(),
      add('f', 'FollowPath', { target: 'a', curve: 'cv', evalTime: 0.5, order: 0 }),
      add('tt', 'TrackTo', { target: 'a', aimPoint: [5, 9, 0], order: 1 }),
    ]),
  'an aim at a keyed follower': () =>
    run(cube(follower(), 'o', [3, 3, 3]), [
      ...line(),
      add('f', 'FollowPath', { target: 'a', curve: 'cv' }),
      evalKey('f'),
      add('tt', 'TrackTo', { target: 'o', aimNode: 'a' }),
    ]),
  'an aim under a tilted, keyed parent, and its child': () => underGroup([1, 1, 1]),
  'an aim point in the parent': () =>
    run(base(), [
      add('g', 'Group', { position: [1, 2, 3], rotation: [40, 0, 25] }),
      wire('g', 'out', 'n_scene', 'children'),
      ...hung('a', 'g', { position: [0, 1, 0] }),
      add('tt', 'TrackTo', { target: 'a', aimPoint: [3, 0, 0], aimSpace: 'parent', up: [0, 0, 1] }),
    ]),
  'two objects aiming at each other': () =>
    run(pair(), [
      add('ta', 'TrackTo', { target: 'a', aimNode: 'h' }),
      add('th', 'TrackTo', { target: 'h', aimNode: 'a' }),
    ]),
  'aiming at your own child': () =>
    run(cube(base(), 'p', [0, 0, 0]), [
      ...hung('k', 'p', { position: [2, 0, 0] }),
      add('tt', 'TrackTo', { target: 'p', aimNode: 'k' }),
    ]),
  'an aim whose target is gone': () =>
    run(pair(), [add('t', 'TrackTo', { target: 'a', aimNode: 'gone' })]),
};

/** `id`'s world as the old road draws it, its own constraints included. */
function drawn(s: DagState, id: string, seconds: number): number[] | null {
  const ctx = at(seconds);
  const world = resolveDrawnWorldTransform(s, id, ctx);
  if (!world) return null;
  const parent = resolveDrawnParentWorldMatrix(s, id, ctx) ?? new THREE.Matrix4();
  const local = new THREE.Matrix4()
    .fromArray(world.matrix as number[])
    .premultiply(parent.clone().invert());
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  local.decompose(position, rotation, scale);
  if (relationalPoseStackForTarget(s.nodes, id).length > 0) {
    const aim = resolveConstraintRotation(s, id, ctx);
    const followed = resolveConstraintPosition(s, id, ctx);
    if (aim) {
      const r = aim.map((d: number) => THREE.MathUtils.degToRad(d)) as Vec3;
      rotation.setFromEuler(new THREE.Euler(...r, 'XYZ'));
    }
    if (followed) position.set(...(followed as Vec3));
  }
  return parent
    .clone()
    .multiply(new THREE.Matrix4().compose(position, rotation, scale))
    .toArray();
}

const objectsOf = (s: DagState) =>
  Object.values(s.nodes)
    .filter((n) => n.type === 'Object' || n.type === 'Group' || n.type === 'Null')
    .map((n) => n.id);

type Poses = Record<string, Record<string, number[]>>;
function record(s: DagState): Poses {
  const out: Poses = {};
  for (const id of objectsOf(s)) {
    for (const t of TIMES) {
      const m = drawn(s, id, t);
      if (m) (out[id] ??= {})[String(t)] = m.map((v) => +v.toFixed(6) + 0);
    }
  }
  return out;
}

function expectChainsDraw(s: DagState, poses: Poses) {
  const after = convert(s);
  const rows = Object.entries(poses);
  expect(rows.length).toBeGreaterThan(0);
  for (const [id, times] of rows) {
    for (const [t, want] of Object.entries(times)) {
      const got = evaluate(after, id, { socket: 'world', ctx: at(Number(t)) }).value as number[];
      got.forEach((v, i) => expect(v, `${id} at ${t}, [${i}]`).toBeCloseTo(want[i], 4));
    }
  }
}

const recording: Record<string, Poses> = existsSync(POSES)
  ? JSON.parse(readFileSync(POSES, 'utf8'))
  : {};

describe('recording the old road', () => {
  it.runIf(process.env.RECORD_CHAIN_POSES)(
    'writes the poses',
    async () => {
      const out: Record<string, Poses> = {};
      for (const [name, build] of Object.entries(SAME)) out[name] = record(build());
      for (const id of EXAMPLE_PROJECT_IDS) out[id] = record((await buildExampleProject(id)).state);
      writeFileSync(POSES, `${JSON.stringify(out)}\n`);
    },
    120_000,
  );

  it('the recording is what the old road draws today', async () => {
    for (const [name, build] of Object.entries(SAME))
      expect(record(build()), name).toEqual(recording[name]);
    for (const id of EXAMPLE_PROJECT_IDS) {
      expect(record((await buildExampleProject(id)).state), id).toEqual(recording[id]);
    }
  }, 120_000);
});

describe('every object draws where it did', () => {
  for (const [name, build] of Object.entries(SAME)) {
    it(name, () => expectChainsDraw(build(), recording[name]));
  }
  for (const id of EXAMPLE_PROJECT_IDS) {
    it(`example "${id}"`, async () => {
      expectChainsDraw((await buildExampleProject(id)).state, recording[id]);
    });
  }

  it('the examples include constrained objects, so the check sees a chain', async () => {
    let chains = 0;
    for (const id of EXAMPLE_PROJECT_IDS) {
      const after = convert((await buildExampleProject(id)).state);
      chains += Object.values(after.nodes).filter((n) => n.type === 'OwnWorld').length;
    }
    expect(chains).toBeGreaterThanOrEqual(EXAMPLE_PROJECT_IDS.length);
  });
});

describe('where the chain differs on purpose', () => {
  const position = (m: number[]) => [m[12], m[13], m[14]];

  it('under an uneven parent the aim keeps axis lengths, as Blender: no shear on the object', () => {
    const s = underGroup([1, 3, 1]);
    const old = drawn(s, 'a', 0)!;
    const chain = evaluate(convert(s), 'a', { socket: 'world', ctx: at(0) }).value as number[];
    // Same place, different matrix: the old road carried the parent's stretch through the aim.
    position(chain).forEach((v, i) => expect(v).toBeCloseTo(position(old)[i], 5));
    expect(Math.max(...chain.map((v, i) => Math.abs(v - old[i])))).toBeGreaterThan(0.5);
  });

  it("a parented follower: the parent's position now adds to the path, and it is logged by name", () => {
    const s = run(base(), [
      add('g', 'Group', { position: [1, 2, 3] }),
      wire('g', 'out', 'n_scene', 'children'),
      ...line(),
      ...hung('a', 'g', { position: [0, 1, 0] }),
      add('f', 'FollowPath', { target: 'a', curve: 'cv', evalTime: 0.5 }),
    ]);
    const chain = evaluate(convert(s), 'a', { socket: 'world', ctx: at(0) }).value as number[];
    position(chain).forEach((v, i) => expect(v).toBeCloseTo([6, 2, 3][i], 4));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Parented'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(': a.'));
  });

  it('two live Follow Paths now compose in order, and that is logged by name', () => {
    const s = run(follower(), [
      ...line(),
      add('f1', 'FollowPath', { target: 'a', curve: 'cv', evalTime: 0.2 }),
      add('f2', 'FollowPath', { target: 'a', curve: 'cv', evalTime: 0.5, order: 1 }),
    ]);
    const chain = evaluate(convert(s), 'a', { socket: 'world', ctx: at(0) }).value as number[];
    position(chain).forEach((v, i) => expect(v).toBeCloseTo([7, 0, 0][i], 4));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('compose in order: a.'));
  });
});

describe('what the conversion writes', () => {
  const stacked = () =>
    run(pair(), [
      add('top', 'TrackTo', { target: 'a', aimPoint: [0, 9, 0], order: 5 }),
      add('low', 'TrackTo', { target: 'a', aimNode: 'h', order: 1, mute: true }),
      add('k', 'KeyframeChannelNumber', {
        target: 'low',
        paramPath: 'roll',
        keyframes: [{ time: 0, value: 10 }],
      }),
    ]);

  it('wires bottom to top by order, a muted step in its place, adding only wires to a step', () => {
    const before = stacked();
    const after = convert(before);
    expect(after.nodes.low.inputs.in).toEqual({ node: 'a_own_world', socket: 'world' });
    expect(after.nodes.top.inputs.in).toEqual({ node: 'low', socket: 'world' });
    expect(after.nodes.a.inputs.constraints).toEqual({ node: 'top', socket: 'world' });
    expect(after.nodes.low.params).toEqual(before.nodes.low.params);
    expect(after.nodes.k).toEqual(before.nodes.k);
    expect(after.nodes.a_own_world.params).toEqual({ object: 'a' });
  });

  it('an aim target stays a reference, so a loop survives the conversion', () => {
    const after = convert(
      run(pair(), [
        add('ta', 'TrackTo', { target: 'a', aimNode: 'h' }),
        add('th', 'TrackTo', { target: 'h', aimNode: 'a' }),
      ]),
    );
    expect(after.nodes.ta.inputs.aim).toBeUndefined();
    expect((after.nodes.ta.params as { aimNode: string }).aimNode).toBe('h');
  });

  it("doesn't take an id another node holds", () => {
    const s = run(pair(), [
      add('a_own_world', 'Null'),
      add('t', 'TrackTo', { target: 'a', aimNode: 'h' }),
    ]);
    const after = convert(s);
    expect(after.nodes.a_own_world.type).toBe('Null');
    expect(after.nodes.a_own_world_.type).toBe('OwnWorld');
  });

  it('a step with no object, or one that cannot end a chain, is left as it was', () => {
    const s = run(pair(), [
      add('none', 'TrackTo', { aimNode: 'h' }),
      add('data', 'TrackTo', { target: 'a_data', aimNode: 'h' }),
    ]);
    const after = convert(s);
    expect(after.nodes.none).toEqual(s.nodes.none);
    expect(after.nodes.data).toEqual(s.nodes.data);
  });

  it('a file with no constraints comes back unchanged', () => {
    const s = cube(base(), 'b', [0, 0, 0]);
    const bare = {
      ...s,
      nodes: Object.fromEntries(Object.entries(s.nodes).filter(([, n]) => n.type !== 'TrackTo')),
    };
    const after = convert(bare);
    expect(Object.keys(after.nodes).filter((id) => after.nodes[id].type === 'OwnWorld')).toEqual(
      [],
    );
  });

  it('a project with no state passes through', () => {
    expect(migrateConstraintsToChains({ formatVersion: 28 })).toEqual({ formatVersion: 28 });
  });
});
