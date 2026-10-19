// #421/#424 — the id-reference sweep, and the guard that keeps its registry honest.
//
// Every fixture below uses DISTINCT, non-default ids and values so a pass cannot come
// from a value colliding with a fallback (a trap that has bitten here before): an
// argument ref cleared to '' must be distinguishable from one that was ALREADY ''.
import { describe, it, expect } from 'vitest';
import {
  danglingIdRefs,
  findDanglingIdRef,
  idRefSweep,
  referenceCycles,
  relationsOf,
} from './idRefSweep';
import { applyOp } from './ops';
import { paramStringPaths } from './paramStringPaths';
import { emptyDagState, type DagState } from './state';
import { NodeSchema } from './types';
import { getNodeType, listNodeTypes, paramFieldsOf } from './registry';
import { registerAllNodes } from '../../nodes/registerAll';
import type { Op } from './types';
import { testNode } from '../../test-utils/testNode';

registerAllNodes();

type FakeNodes = Record<string, { id: string; type: string; params: unknown }>;

// #622 — built through `testNode`, so a type the registry does not have throws here
// instead of quietly asserting forever. These fixtures are stand-ins for "some node with
// an id"; twelve of them used to name retired kinds and stayed green because a hand-built
// literal never touches the registry.
function nodes(...defs: Array<[string, string, unknown]>): FakeNodes {
  const out: FakeNodes = {};
  for (const [id, type, params] of defs) {
    out[id] = testNode(id, type, { params }) as unknown as FakeNodes[string];
  }
  return out;
}

const clearOf = (ops: Op[], nodeId: string, paramPath: string) =>
  ops.find((o) => o.type === 'setParam' && o.nodeId === nodeId && o.paramPath === paramPath) as
    | Extract<Op, { type: 'setParam' }>
    | undefined;

describe('idRefSweep — subject refs die with their referent', () => {
  it('sweeps a keyframe channel whose target is deleted', () => {
    const s = idRefSweep(
      nodes(
        ['cube', 'Object', {}],
        ['ch', 'KeyframeChannelVec3', { target: 'cube', paramPath: 'position' }],
      ),
      ['cube'],
    );
    expect([...s.remove].sort()).toEqual(['ch', 'cube']);
  });

  it('sweeps a constraint and a driver bound to the deleted object', () => {
    const s = idRefSweep(
      nodes(
        ['cube', 'Object', {}],
        ['tt', 'TrackTo', { target: 'cube', aimNode: '' }],
        ['drv', 'ParamDriver', { target: 'cube', paramPath: 'position' }],
      ),
      ['cube'],
    );
    expect([...s.remove].sort()).toEqual(['cube', 'drv', 'tt']);
  });

  it('leaves an unrelated object and its channel completely alone', () => {
    const s = idRefSweep(
      nodes(
        ['cube', 'Object', {}],
        ['sphere', 'Object', {}],
        ['chOther', 'KeyframeChannelVec3', { target: 'sphere', paramPath: 'position' }],
      ),
      ['cube'],
    );
    expect([...s.remove]).toEqual(['cube']);
    expect(s.ops).toEqual([]);
  });
});

describe('idRefSweep — argument refs are cleared, never cascaded', () => {
  it('clears a dangling aim target but keeps the constraint', () => {
    const s = idRefSweep(
      nodes(
        ['aimNull', 'Null', { position: [7, 7, 7] }],
        ['cube', 'Object', {}],
        ['tt', 'TrackTo', { target: 'cube', aimNode: 'aimNull' }],
      ),
      ['aimNull'],
    );
    // The constraint SURVIVES — deleting what it aimed at must not delete it.
    expect([...s.remove]).toEqual(['aimNull']);
    expect(clearOf(s.ops, 'tt', 'aimNode')?.value).toBe('');
  });

  it('clears a driver source in place, preserving the sibling channel field', () => {
    const s = idRefSweep(
      nodes(
        ['ctrl', 'Null', { position: [3, 3, 3] }],
        [
          'drv',
          'ParamDriver',
          {
            target: 'cube',
            paramPath: 'intensity',
            sourceTransform: { node: 'ctrl', channel: 'ty' },
          },
        ],
        ['cube', 'Object', {}],
      ),
      ['ctrl'],
    );
    expect([...s.remove]).toEqual(['ctrl']);
    const op = clearOf(s.ops, 'drv', 'sourceTransform.node');
    // Clearing the NESTED id, not the whole object — dropping it would lose
    // `channel` and silently switch the driver back to its wired `in` road.
    expect(op?.paramPath).toBe('sourceTransform.node');
    expect(op?.value).toBe('');
    expect(clearOf(s.ops, 'drv', 'sourceTransform')).toBeUndefined();
  });

  it('does NOT cascade-delete strips when a SHARED Action is deleted', () => {
    // The corrected classification: an Action is reusable (addStrip requires a
    // pre-existing one), so deleting it must not destroy every placement of it.
    const s = idRefSweep(
      nodes(
        ['walkAction', 'Action', { name: 'walk', channels: [] }],
        ['stripA', 'Strip', { target: 'cubeA', action: 'walkAction', start: 3 }],
        ['stripB', 'Strip', { target: 'cubeB', action: 'walkAction', start: 11 }],
        ['cubeA', 'Object', {}],
        ['cubeB', 'Object', {}],
      ),
      ['walkAction'],
    );
    expect([...s.remove]).toEqual(['walkAction']);
    expect(clearOf(s.ops, 'stripA', 'action')?.value).toBe('');
    expect(clearOf(s.ops, 'stripB', 'action')?.value).toBe('');
  });
});

describe('idRefSweep — a cleared id is a value the schema accepts (#1551)', () => {
  it('clears an id whose schema refuses the empty string to absent, not to ""', () => {
    // `Scene.activeCollection` is `z.string().min(1).optional()`: a `''` there fails the
    // schema, and `setParam` would throw the whole delete away.
    const s = idRefSweep(
      nodes(['scn', 'Scene', { activeCollection: 'colActive' }], ['colActive', 'Collection', {}]),
      ['colActive'],
    );
    expect([...s.remove]).toEqual(['colActive']);
    const op = clearOf(s.ops, 'scn', 'activeCollection');
    expect(op).toBeDefined();
    expect(op?.value).toBeUndefined();
  });

  it('still clears an id whose schema takes the empty string to ""', () => {
    const s = idRefSweep(
      nodes(
        ['pathCurve', 'Object', {}],
        ['cube', 'Object', {}],
        ['fp', 'FollowPath', { target: 'cube', curve: 'pathCurve' }],
      ),
      ['pathCurve'],
    );
    expect(clearOf(s.ops, 'fp', 'curve')?.value).toBe('');
  });
});

describe('idRefSweep — ownership in the downward direction', () => {
  it('takes a Track’s strips with it', () => {
    const s = idRefSweep(
      nodes(
        ['trk', 'Track', { strips: ['s1', 's2'] }],
        ['s1', 'Strip', { target: 'cube', action: 'act', start: 3 }],
        ['s2', 'Strip', { target: 'cube', action: 'act', start: 9 }],
        ['act', 'Action', { name: 'walk', channels: [] }],
        ['cube', 'Object', {}],
      ),
      ['trk'],
    );
    expect([...s.remove].sort()).toEqual(['s1', 's2', 'trk']);
    // The shared Action is NOT owned by the track — it survives untouched.
    expect(s.ops.some((o) => o.type === 'setParam' && o.nodeId === 'act')).toBe(false);
  });

  it('reaches a fixpoint: deleting the object drops its strip from the track list', () => {
    // One pass is not enough — deleting `cube` removes `s1` (subject), and only THEN
    // does the Track have a dangling member to drop.
    const s = idRefSweep(
      nodes(
        ['trk', 'Track', { strips: ['s1', 'sKeep'] }],
        ['s1', 'Strip', { target: 'cube', action: 'act', start: 3 }],
        ['sKeep', 'Strip', { target: 'other', action: 'act', start: 9 }],
        ['act', 'Action', { name: 'walk', channels: [] }],
        ['cube', 'Object', {}],
        ['other', 'Object', {}],
      ),
      ['cube'],
    );
    expect([...s.remove].sort()).toEqual(['cube', 's1']);
    // The surviving strip keeps its place; only the removed one is dropped.
    expect(clearOf(s.ops, 'trk', 'strips')?.value).toEqual(['sKeep']);
  });
});

describe('findDanglingIdRef — the #435 final-state detector', () => {
  it('is null when every id-reference resolves', () => {
    expect(
      findDanglingIdRef(
        nodes(
          ['cube', 'Object', {}],
          ['ch', 'KeyframeChannelVec3', { target: 'cube', paramPath: 'position' }],
        ),
      ),
    ).toBeNull();
  });

  it('names the referrer and the missing id when a target is absent', () => {
    // The state a raw removeNode leaves behind: the channel survives, its target is gone.
    const d = findDanglingIdRef(
      nodes(['ch', 'KeyframeChannelVec3', { target: 'cube', paramPath: 'position' }]),
    );
    expect(d).toEqual({ node: 'ch', missing: 'cube' });
  });

  it('ignores an empty ref (an unbound constraint is not dangling)', () => {
    expect(findDanglingIdRef(nodes(['tt', 'TrackTo', { target: '', aimNode: '' }]))).toBeNull();
  });
});

describe('idRefs registry — drift guard', () => {
  // "Is every id-holding param declared?" is answered by `src/nodes/idRefCensus.gate.test.ts`
  // (#1551), which walks every string a schema can store. It replaced a check here that looked
  // for five param NAMES at the top level of the parsed defaults, and so could not see a nested
  // id, an optional one, or one under any other name (`Scene.activeCollection` was all three).

  it('every declared idRef path names a param that actually exists on the schema', () => {
    // Catches a typo'd or renamed path, which would otherwise make the sweep a silent
    // no-op for that ref while looking perfectly declared.
    //
    // Read the SCHEMA SHAPE, not parsed defaults: every source ref is `.optional()`,
    // so it is legitimately absent from `parse({})` and a defaults-based check would
    // flag all eight as broken. (It did, on the first run — the assertion was right
    // and the instrument was wrong.)
    const broken: string[] = [];
    for (const type of listNodeTypes()) {
      const def = getNodeType(type);
      if (!def?.idRefs) continue;
      // #683 — REPORTED, not skipped. This type declares `idRefs`, so its paths are meant to
      // be checkable; a schema this cannot read makes every one of them silently unchecked
      // while the row stays green. `continue` here used to hide exactly that.
      const shape = paramFieldsOf(def);
      if (shape === null) {
        broken.push(`${type}: paramSchema is not an object schema, so its idRefs are unchecked`);
        continue;
      }
      for (const ref of def.idRefs) {
        const head = ref.path.split('.')[0];
        if (!(head in shape)) broken.push(`${type}.${ref.path}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

// ── #1553 — every relationship of a node, from one query ─────────────────────────────

const build = (ops: readonly Op[], from: DagState = emptyDagState()) =>
  ops.reduce((state, op) => applyOp(state, op).next, from);
const add = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string): Op => ({
  type: 'connect',
  from: { node: from, socket: 'out' },
  to: { node: to, socket },
});
const follow = (nodeId: string, nameFrom: string): Op => ({
  type: 'setMeta',
  nodeId,
  name: 'follower',
  nameFrom,
});

/** `hub` with one of each relationship: a wire each way, a sidecar, a reader, a follower. */
function hubScene(): DagState {
  return build([
    add('feed', 'Math'),
    add('hub', 'Math'),
    wire('feed', 'hub', 'a'),
    add('reader', 'Math'),
    wire('hub', 'reader', 'b'),
    add('driver', 'ParamDriver', { target: 'hub', paramPath: 'b' }),
    add('lag', 'Lag', { sourceTransform: { node: 'hub', channel: 'tx' } }),
    add('named', 'Math'),
    follow('named', 'hub'),
    add('bystander', 'Math'),
  ]);
}

describe('relationsOf — one query for every relationship of a node (#1553)', () => {
  it('lists wires, references and name followers, each in both directions', () => {
    const s = hubScene();
    expect(relationsOf(s, 'hub')).toEqual({
      wiresIn: [{ node: 'feed', socket: 'a' }],
      wiresOut: [{ node: 'reader', socket: 'b' }],
      refsOut: [],
      refsIn: [
        { node: 'driver', path: 'target', role: 'subject', owns: false },
        { node: 'lag', path: 'sourceTransform.node', role: 'argument', owns: false },
      ],
      follows: null,
      followers: ['named'],
      insideSubnetworkOf: [],
      subnetwork: [],
      cycles: [],
    });
    // The other end of each says the same thing from its side.
    expect(relationsOf(s, 'driver').refsOut).toEqual([
      { node: 'hub', path: 'target', role: 'subject', owns: false },
    ]);
    expect(relationsOf(s, 'named').follows).toBe('hub');
    expect(relationsOf(s, 'reader').wiresIn).toEqual([{ node: 'hub', socket: 'b' }]);
  });

  it('CONTROL: a node nothing touches has no relationships', () => {
    expect(relationsOf(hubScene(), 'bystander')).toEqual({
      wiresIn: [],
      wiresOut: [],
      refsOut: [],
      refsIn: [],
      follows: null,
      followers: [],
      insideSubnetworkOf: [],
      subnetwork: [],
      cycles: [],
    });
  });

  it('reports a sub-network from the owner and from inside it', () => {
    const s = build([
      add('prev', 'BodyInput', { input: 'prev' }),
      add('step', 'Math', { op: 'add' }),
      wire('prev', 'step', 'a'),
      add('solver', 'Solver'),
      wire('step', 'solver', 'body'),
      add('outside', 'Math'),
    ]);
    expect([...relationsOf(s, 'solver').subnetwork].sort()).toEqual(['prev', 'step']);
    expect(relationsOf(s, 'prev').insideSubnetworkOf).toEqual(['solver']);
    expect(relationsOf(s, 'outside').insideSubnetworkOf).toEqual([]);
  });

  it('answers for the graph it is given, not the one it answered for before', () => {
    const before = hubScene();
    expect(relationsOf(before, 'hub').followers).toEqual(['named']);
    const after = build([{ type: 'setMeta', nodeId: 'named', name: 'my own' }], before);
    expect(relationsOf(after, 'hub').followers).toEqual([]);
    expect(relationsOf(before, 'hub').followers).toEqual(['named']);
  });

  // The door set, derived: every reference any registered type declares is one `relationsOf`
  // reports, in both directions, so a new `idRefs` row cannot be one it misses.
  it('reports every reference the registry declares', () => {
    const declared = listNodeTypes().flatMap((type) =>
      (getNodeType(type)?.idRefs ?? []).map((ref) => ({ type, ref })),
    );
    expect(declared.length).toBeGreaterThan(20);
    for (const { type, ref } of declared) {
      const held =
        ref.shape === 'idList' ? ['seen'] : ref.shape === 'ref' ? { node: 'seen' } : 'seen';
      const params: Record<string, unknown> = {};
      const segs = ref.path.split('.');
      let at = params;
      for (const seg of segs.slice(0, -1)) at = at[seg] = {} as Record<string, unknown>;
      at[segs[segs.length - 1]] = held;
      // Raw nodes: this asks what the walker reads, not what each schema accepts.
      const state = {
        ...emptyDagState(),
        nodes: {
          seen: { id: 'seen', type: 'Math', version: 1, params: {}, inputs: {} },
          holder: { id: 'holder', type, version: 1, params, inputs: {} },
        },
      } as unknown as DagState;
      const expected = { path: ref.path, role: ref.role, owns: ref.owns === true };
      expect(relationsOf(state, 'seen').refsIn, `${type}.${ref.path}`).toEqual([
        { node: 'holder', ...expected },
      ]);
      expect(relationsOf(state, 'holder').refsOut, `${type}.${ref.path}`).toEqual([
        { node: 'seen', ...expected },
      ]);
    }
  });

  // A node can hold another node's id in exactly three places. A fourth is a relationship
  // kind `relationsOf` does not know about, and this is where it has to be answered.
  it('a node has no place to hold an id that the query does not read', () => {
    const HOW_EACH_IS_READ: Record<string, string> = {
      id: 'the node itself',
      type: 'not an id',
      version: 'not an id',
      params: 'refsOut / refsIn, through the declared idRefs (idRefCensus.gate.test.ts)',
      spare: 'not an id: spare parameters hold values',
      inputs: 'wiresIn / wiresOut',
      meta: 'follows / followers, through meta.nameFrom',
    };
    expect(Object.keys(NodeSchema.shape).sort()).toEqual(Object.keys(HOW_EACH_IS_READ).sort());
    const metaStrings = paramStringPaths(NodeSchema.shape.meta)
      .filter((row) => row.kind !== 'string' || row.path !== 'name')
      .map((row) => `${row.path} [${row.kind}]`);
    expect(metaStrings).toEqual(['nameFrom [string]']);
    // A spare parameter is a key, a value and where its control sits: none names a node.
    expect(
      paramStringPaths(NodeSchema.shape.spare).map((row) => `${row.path} [${row.kind}]`),
    ).toEqual([
      '{key} [string]',
      '{}.value [opaque]',
      '{}.home.section [string]',
      '{}.home.label [string]',
    ]);
  });
});

describe('name followers are swept like any other reference (#1553)', () => {
  it('a follower of a removed node keeps its name and stops following', () => {
    const s = hubScene();
    const sweep = idRefSweep(s.nodes, ['hub']);
    expect(sweep.ops).toContainEqual({ type: 'setMeta', nodeId: 'named', name: 'follower' });
    expect(sweep.remove.has('named')).toBe(false);
  });

  it('CONTROL: a follower of a node that stays is left alone', () => {
    const sweep = idRefSweep(hubScene().nodes, ['bystander']);
    expect(sweep.ops.filter((op) => op.type === 'setMeta')).toEqual([]);
  });

  it('a follower removed with its source needs no clearing', () => {
    const sweep = idRefSweep(hubScene().nodes, ['hub', 'named']);
    expect(sweep.ops.filter((op) => op.type === 'setMeta')).toEqual([]);
  });

  it('a follower whose source is gone is a dangling reference', () => {
    const s = hubScene();
    const { hub: _hub, ...rest } = s.nodes;
    void _hub;
    expect(danglingIdRefs(rest)).toContainEqual({ node: 'named', missing: 'hub' });
    expect(danglingIdRefs(s.nodes)).toEqual([]);
  });
});

describe('referenceCycles — a cycle through a reference is reported by name (#1553)', () => {
  it('two drivers, each fed by the node the other drives', () => {
    const s = build([
      add('x', 'Math'),
      add('y', 'Math'),
      add('dx', 'ParamDriver', { target: 'x', paramPath: 'b' }),
      wire('y', 'dx', 'in'),
      add('dy', 'ParamDriver', { target: 'y', paramPath: 'b' }),
      wire('x', 'dy', 'in'),
    ]);
    const cycles = referenceCycles(s);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0]].sort()).toEqual(['dx', 'dy', 'x', 'y']);
    // Each node on it is told, and a node off it is not.
    expect(relationsOf(s, 'dx').cycles).toEqual(cycles);
    const off = build([add('off', 'Math')], s);
    expect(relationsOf(off, 'off').cycles).toEqual([]);
  });

  it('a driver fed by the node it drives', () => {
    const s = build([
      add('x', 'Math'),
      add('d', 'ParamDriver', { target: 'x', paramPath: 'b' }),
      wire('x', 'd', 'in'),
    ]);
    expect(referenceCycles(s).map((cycle) => [...cycle].sort())).toEqual([['d', 'x']]);
  });

  it('two objects each aimed at the other', () => {
    const s = build([
      add('a', 'Object'),
      add('b', 'Object'),
      add('aimA', 'TrackTo', { target: 'a', aimNode: 'b' }),
      add('aimB', 'TrackTo', { target: 'b', aimNode: 'a' }),
    ]);
    expect(referenceCycles(s).map((cycle) => [...cycle].sort())).toEqual([
      ['a', 'aimA', 'aimB', 'b'],
    ]);
  });

  it('two nodes following each other’s name, and one following its own', () => {
    const pair = build([add('p', 'Math'), add('q', 'Math'), follow('p', 'q'), follow('q', 'p')]);
    expect(referenceCycles(pair).map((cycle) => [...cycle].sort())).toEqual([['p', 'q']]);
    // `setMeta` drops a link to oneself, so this one is built as a saved project could hold it.
    const base = build([add('p', 'Math')]);
    const own = {
      ...base,
      nodes: { p: { ...base.nodes.p, meta: { name: 'p', nameFrom: 'p' } } },
    } as DagState;
    expect(referenceCycles(own)).toEqual([['p']]);
  });

  it('CONTROL: a chain of references with no way back is not a cycle', () => {
    expect(referenceCycles(hubScene())).toEqual([]);
  });

  it('CONTROL: an object in a group that aims at the group is not a cycle', () => {
    // The group is wired to the object, and the object's aim names the group. The aim reads
    // the group's own transform, which does not need the object.
    const s = build([
      add('cam', 'Object'),
      add('rig', 'Group'),
      wire('cam', 'rig', 'children'),
      add('aim', 'TrackTo', { target: 'cam', aimNode: 'rig' }),
    ]);
    expect(referenceCycles(s)).toEqual([]);
  });

  it('CONTROL: a wire cycle is still refused, so none is stored to report', () => {
    const s = build([add('a', 'Math'), add('b', 'Math'), wire('a', 'b', 'a')]);
    expect(() => applyOp(s, wire('b', 'a', 'a'))).toThrow(/cycle/);
  });
});
