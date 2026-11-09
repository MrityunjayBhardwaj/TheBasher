// #1812 — saved constraint stacks open as wired chains, every object drawing where it did.
//
// The poses in `__fixtures__/constraintChains.poses.json` were recorded from the old road before it
// was removed (#1813, recorded at commit be6d28a7), so they can't be regenerated, only added to. A
// change that reddens this has moved something that was drawn.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOp, emptyDagState, evaluate, __resetRegistryForTests, type DagState } from '../dag';
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
/** An object's own position as stored. */
const ownPositionOf = (s: DagState, id: string) =>
  (s.nodes[id].params as { position?: unknown }).position;
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

type Poses = Record<string, Record<string, number[]>>;

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

const recording: Record<string, Poses> = JSON.parse(readFileSync(POSES, 'utf8'));

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
    const after = convert(underGroup([1, 3, 1]));
    const m = evaluate(after, 'a', { socket: 'world', ctx: at(0) }).value as number[];
    // Where the old road drew it, recorded at 0 s.
    position(m).forEach((v, i) => expect(v).toBeCloseTo([-0.268, 4.083, 4.748][i], 3));
    // Its axes stay square, where the old road carried the parent's stretch through the aim.
    expect(m[0] * m[4] + m[1] * m[5] + m[2] * m[6]).toBeCloseTo(0, 6);
    // So its child sits elsewhere: (1.092, 4.292, 6.26) on the old road.
    const kid = evaluate(after, 'kid', { socket: 'world', ctx: at(0) }).value as number[];
    position(kid).forEach((v, i) => expect(v).toBeCloseTo([1.22, 4.083, 6.085][i], 3));
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

  // #1853 — a curve with no points places nothing (`curveSamplerFor` has nothing to sample), so
  // its follower stood at its own position and must keep it: not zeroed as an offset.
  it('a Follow Path on a curve with no points placed nothing, so its object keeps its position', () => {
    // The app cannot make one (a curve keeps at least two points), but loading takes a saved file's
    // params as they are, so an older file can hold one. It is emptied here the same way.
    const built = run(follower(), [
      ...line(),
      add('f', 'FollowPath', { target: 'a', curve: 'cv', evalTime: 0.5 }),
    ]);
    const cvData = built.nodes.cv_d;
    const s: DagState = {
      ...built,
      nodes: {
        ...built.nodes,
        cv_d: { ...cvData, params: { ...(cvData.params as object), points: [] } },
      },
    };
    const after = convert(s);
    expect(ownPositionOf(after, 'a')).toEqual([0, 4, 0]);
    for (const t of TIMES) {
      const m = evaluate(after, 'a', { socket: 'world', ctx: at(t) }).value as number[];
      position(m).forEach((v, i) => expect(v, `at ${t}`).toBeCloseTo([0, 4, 0][i], 4));
    }
  });
});

// #1791 — before the chain a Follow Path drew its object AT the path point, its own position
// unused, so each case below is where the old road drew it: the point, through the curve object.
describe('a follower converted: its own position becomes a zero offset', () => {
  const position = (m: number[]) => [m[12], m[13], m[14]];
  const drawnAt = (s: DagState, id: string, t = 0) =>
    position(evaluate(s, id, { socket: 'world', ctx: at(t) }).value as number[]);

  it('the converted state is what the step says: own position zero, position keys gone', () => {
    const s = run(follower(), [
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
    ]);
    const after = convert(s);
    expect(ownPositionOf(after, 'a')).toEqual([0, 0, 0]);
    expect(after.nodes.kp).toBeUndefined();
  });

  it('a cube on a curve object moved, turned and scaled is drawn at the point through it', () => {
    // The point halfway along (5, 0, 0), through a curve object at (5, 0, 3), turned 90° about Z
    // and scaled 2: (5, 10, 3).
    const s = run(follower(), [
      ...line({ position: [5, 0, 3], rotation: [0, 0, 90], scale: [2, 2, 2] }),
      add('f', 'FollowPath', { target: 'a', curve: 'cv', evalTime: 0.5 }),
    ]);
    const after = convert(s);
    expect(ownPositionOf(after, 'a')).toEqual([0, 0, 0]);
    drawnAt(after, 'a').forEach((v, i) => expect(v).toBeCloseTo([5, 10, 3][i], 4));
  });

  it('the default camera, standing at its own position, is drawn on the path', () => {
    const s0 = run(base(), [
      ...line(),
      add('f', 'FollowPath', { target: 'n_camera', curve: 'cv', evalTime: 0.5 }),
    ]);
    // The premise: the default camera stands away from the origin.
    expect(ownPositionOf(s0, 'n_camera')).not.toEqual([0, 0, 0]);
    const after = convert(s0);
    expect(ownPositionOf(after, 'n_camera')).toEqual([0, 0, 0]);
    drawnAt(after, 'n_camera').forEach((v, i) => expect(v).toBeCloseTo([5, 0, 0][i], 4));
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

  it('a file with no constraints comes back with the same nodes', () => {
    const s = makeSplitCube(emptyDagState(), { objectId: 'b', position: [0, 0, 0] }).state;
    expect(convert(s).nodes).toEqual(s.nodes);
  });

  it('a state already on chains passes through the step unchanged', () => {
    const s = convert(run(pair(), [add('t', 'TrackTo', { target: 'a', aimNode: 'h' })]));
    expect(convert(s).nodes).toEqual(s.nodes);
  });

  it('a project with no state passes through', () => {
    expect(migrateConstraintsToChains({ formatVersion: 28 })).toEqual({ formatVersion: 29 });
  });
});
