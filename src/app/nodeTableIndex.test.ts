// #1757 — the per-node-table indexes answer exactly as the scans they replaced, and a new node
// table (every op makes one) gets a new answer.
import { describe, expect, it } from 'vitest';
import type { DagState } from '../core/dag/state';
import {
  directChannelNodesForTarget,
  hasSoloChannelOn,
  keyframeChannelsTargeting,
} from './nodeChannels';
import { driverNodesForTarget } from './paramDrivers';
import { posingObjectId } from './resolveDataParamOwner';
import { stripTargetsOf } from './stripTargetIndex';

type N = {
  id: string;
  type: string;
  params: Record<string, unknown>;
  inputs: Record<string, unknown>;
};
type Table = Record<string, N>;

const TARGETS = ['a', 'b', 'c', 'd', ''];

/** A mixed table: channels (empty and keyed, soloed, untargeted), bound and unbound drivers,
 *  Objects posing data nodes (two posing the same one), and unrelated nodes. */
function table(seed = 1): Table {
  let r = seed;
  const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const t: Table = {};
  for (let i = 0; i < 300; i++) {
    const id = `n${i}`;
    const kind = pick(['chan', 'chan', 'driver', 'object', 'data', 'other'] as const);
    if (kind === 'chan') {
      t[id] = {
        id,
        type: pick(['KeyframeChannelVec3', 'KeyframeChannelScalar', 'KeyframeChannelText']),
        params: {
          ...(rnd() < 0.9 ? { target: pick(TARGETS) } : {}),
          paramPath: pick(['position', 'fov', 'roll']),
          keyframes: rnd() < 0.3 ? [] : [{ time: 0, value: 1 }],
          ...(rnd() < 0.1 ? { solo: true } : {}),
        },
        inputs: {},
      };
    } else if (kind === 'driver') {
      t[id] = {
        id,
        type: 'ParamDriver',
        params: {
          ...(rnd() < 0.85 ? { target: pick(TARGETS) } : {}),
          ...(rnd() < 0.85 ? { paramPath: pick(['fov', 'position']) } : {}),
        },
        inputs: {},
      };
    } else if (kind === 'object') {
      t[id] = {
        id,
        type: 'Object',
        params: {},
        inputs: { data: { node: pick(['d1', 'd2', 'd3', 'missing']) } },
      };
    } else {
      t[id] = { id, type: kind === 'data' ? 'CameraData' : 'Group', params: {}, inputs: {} };
    }
  }
  for (const d of ['d1', 'd2', 'd3']) t[d] = { id: d, type: 'BoxData', params: {}, inputs: {} };
  return t;
}

// The scans this replaced, verbatim in effect, as the reference.
const scanDirect = (t: Table, target: string) =>
  target
    ? Object.values(t).filter(
        (n) =>
          n.type.startsWith('KeyframeChannel') &&
          n.params.target === target &&
          Array.isArray(n.params.keyframes) &&
          (n.params.keyframes as unknown[]).length > 0,
      )
    : [];
const scanAllChannels = (t: Table, target: string) =>
  Object.values(t).filter(
    (n) => n.type.startsWith('KeyframeChannel') && n.params.target === target,
  );
const scanSolo = (t: Table, scope: unknown[]) =>
  Object.values(t).some(
    (n) =>
      n.type.startsWith('KeyframeChannel') &&
      n.params.solo === true &&
      scope.includes(n.params.target),
  );
const scanDrivers = (t: Table, target: string) =>
  target
    ? Object.values(t).filter(
        (n) =>
          n.type === 'ParamDriver' &&
          typeof n.params.target === 'string' &&
          !!n.params.target &&
          typeof n.params.paramPath === 'string' &&
          !!n.params.paramPath &&
          n.params.target === target,
      )
    : [];
const scanPoser = (t: Table, dataId: string) => {
  if (!dataId || !t[dataId]) return null;
  for (const n of Object.values(t))
    if ((n.inputs.data as { node?: string })?.node === dataId) return n.id;
  return null;
};
const asState = (t: Table) => ({ nodes: t }) as unknown as DagState;
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe('#1757 — the node-table indexes answer as the scans did', () => {
  for (const seed of [1, 7, 42]) {
    it(`same answers, in the same order (table seed ${seed})`, () => {
      const t = table(seed);
      for (const target of [...TARGETS, 'nobody']) {
        expect(ids(directChannelNodesForTarget(t, target)), `direct ${target}`).toEqual(
          ids(scanDirect(t, target)),
        );
        expect(ids(keyframeChannelsTargeting(t, target)), `all ${target}`).toEqual(
          ids(scanAllChannels(t, target)),
        );
        expect(ids(driverNodesForTarget(t, target)), `drivers ${target}`).toEqual(
          ids(scanDrivers(t, target)),
        );
        for (const scope of [[target], [target, 'b'], ['nobody']]) {
          expect(hasSoloChannelOn(t, scope), `solo ${scope}`).toBe(scanSolo(t, scope));
        }
      }
      for (const d of ['d1', 'd2', 'd3', 'missing', '']) {
        expect(posingObjectId(asState(t), d), `poser ${d}`).toBe(scanPoser(t, d));
      }
    });
  }

  it('a new node table is a new answer: the index is the table’s, not the first one read', () => {
    const t = table(3);
    expect(ids(directChannelNodesForTarget(t, 'a'))).toEqual(ids(scanDirect(t, 'a')));
    expect(posingObjectId(asState(t), 'd1')).toBe(scanPoser(t, 'd1'));
    // What an op does: a new table, one node added.
    const next: Table = {
      ...t,
      added: {
        id: 'added',
        type: 'KeyframeChannelVec3',
        params: { target: 'a', keyframes: [{ time: 0, value: 1 }], solo: true },
        inputs: {},
      },
      drv: {
        id: 'drv',
        type: 'ParamDriver',
        params: { target: 'a', paramPath: 'fov' },
        inputs: {},
      },
      pose: { id: 'pose', type: 'Object', params: {}, inputs: { data: { node: 'lonely' } } },
      lonely: { id: 'lonely', type: 'BoxData', params: {}, inputs: {} },
    };
    expect(ids(directChannelNodesForTarget(next, 'a'))).toContain('added');
    expect(ids(driverNodesForTarget(next, 'a'))).toContain('drv');
    expect(hasSoloChannelOn(next, ['a'])).toBe(true);
    expect(posingObjectId(asState(next), 'lonely')).toBe('pose');
    // ...and the old table still answers for itself.
    expect(ids(directChannelNodesForTarget(t, 'a'))).not.toContain('added');
  });

  it('a caller sorting what it got back does not reorder the next reader’s answer', () => {
    const t = table(5);
    const first = ids(driverNodesForTarget(t, 'a'));
    expect(first.length).toBeGreaterThan(1);
    driverNodesForTarget(t, 'a').reverse();
    directChannelNodesForTarget(t, 'a').reverse();
    expect(ids(driverNodesForTarget(t, 'a'))).toEqual(first);
    expect(ids(directChannelNodesForTarget(t, 'a'))).toEqual(ids(scanDirect(t, 'a')));
  });

  it('the strip-target set is the table’s, and keeps a muted strip (it gates, it never decides)', () => {
    const t: Table = {
      s1: {
        id: 's1',
        type: 'Strip',
        params: { target: 'a', action: 'act', muted: true },
        inputs: {},
      },
      s2: { id: 's2', type: 'Strip', params: { target: 'b', action: '' }, inputs: {} },
    };
    expect([...stripTargetsOf(t)]).toEqual(['a']);
    const next: Table = {
      ...t,
      s3: { id: 's3', type: 'Strip', params: { target: 'c', action: 'x' }, inputs: {} },
    };
    expect([...stripTargetsOf(next)].sort()).toEqual(['a', 'c']);
  });
});
