// #1791 — v27 → v28: a Follow Path adds the object's own position to the point on the path.
// The gate: every followed object draws where it did, at every time sampled, for fixtures covering
// each case the step converts exactly and for the captured example. The v26 side of each is the
// recording the v26 code made (provenance inside the file): the code that replaced the own
// position is gone, so what it drew is read from the recording.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests, type DagState } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { migrateFollowPathOwnOffset } from './migrations';
import { buildExampleProject } from './examples';
import { FOLLOW_FIXTURES, FOLLOW_TIMES } from './__fixtures__/followPathOffset.fixtures';
import v26Poses from './__fixtures__/followPathOffset.v26poses.json';
import { enumerateCameraNodeIds, resolveCameraPoseAt } from '../../app/activeCamera';
import { resolveEvaluatedTransform } from '../../app/resolveEvaluatedTransform';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** A node's params, read loosely: the fixtures check fields across node types. */
const paramsOf = (n: { params?: unknown }) => n.params as Record<string, unknown>;
const RECORDED = (v26Poses as { poses: Record<string, Record<string, number[][]>> }).poses;

const migrate = (s: DagState): DagState => {
  const out = migrateFollowPathOwnOffset({ formatVersion: 27, state: s }) as {
    formatVersion: number;
    state: DagState;
  };
  expect(out.formatVersion).toBe(28);
  return out.state;
};

/** Where `id` is drawn at `t`: a camera by its pose resolver, anything else by the drawn transform
 *  (top-level, so its position is its world one). */
const drawn = (s: DagState, id: string, t: number): number[] =>
  enumerateCameraNodeIds(s).includes(id)
    ? [...resolveCameraPoseAt(s, id, t).position]
    : [
        ...resolveEvaluatedTransform(s, id, {
          time: { frame: Math.round(t * 24), seconds: t, normalized: 0 },
        })!.position,
      ];

function expectDrawnAsRecorded(name: string, s: DagState, objects: string[]) {
  const recorded = RECORDED[name];
  expect(recorded, `no recording for "${name}"`).toBeDefined();
  expect(Object.keys(recorded).sort()).toEqual([...objects].sort());
  for (const id of objects)
    FOLLOW_TIMES.forEach((t, i) => {
      const got = drawn(s, id, t);
      recorded[id][i].forEach((v, j) => expect(got[j], `${id} @ ${t}s [${j}]`).toBeCloseTo(v, 9));
    });
}

describe('#1791 — v27 → v28: each followed object draws where it did', () => {
  for (const [name, f] of Object.entries(FOLLOW_FIXTURES))
    it(`${name}: drawn the same before and after`, () => {
      expectDrawnAsRecorded(name, migrate(f.build()), f.objects);
    });

  it('the converted state is what the step says: own position zero, position keys gone', () => {
    const after = migrate(FOLLOW_FIXTURES['a top-level cube whose position is keyed'].build());
    expect(paramsOf(after.nodes.f).position).toEqual([0, 0, 0]);
    expect(after.nodes.f_pos).toBeUndefined();
    // The path's own keys are not the object's position: they stay.
    expect(after.nodes.fp_time).toBeDefined();
  });

  it('a muted Follow Path moves nothing, so its object keeps its own position', () => {
    const after = migrate(
      FOLLOW_FIXTURES['a muted Follow Path (the cube stands where it stands)'].build(),
    );
    expect(paramsOf(after.nodes.f).position).toEqual([0, 4, 0]);
  });

  it(
    'the captured example is stored converted and draws its camera where v26 did',
    { timeout: 120_000 },
    async () => {
      const s = (await buildExampleProject('example_camera_path_ai_walk')).state;
      expect(paramsOf(s.nodes.n_camera).position).toEqual([0, 0, 0]);
      expectDrawnAsRecorded('example camera-path-ai-walk', s, ['n_camera']);
    },
  );

  it('a parented or stacked follower is named, never converted silently', () => {
    const warn = vi.mocked(console.warn);
    let s = FOLLOW_FIXTURES['a top-level cube with its own position'].build();
    s = {
      ...s,
      nodes: {
        ...s.nodes,
        fp2: { ...s.nodes.fp, id: 'fp2', params: { ...paramsOf(s.nodes.fp), order: 1 } },
        grp: {
          id: 'grp',
          type: 'Group',
          version: 1,
          params: {},
          inputs: { children: [{ node: 'f', socket: 'out' }] },
        },
      },
    } as DagState;
    migrate(s);
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toMatch(/Parented[^.]*: f\./);
    expect(said).toMatch(/compose in order: f\./);
  });
});
