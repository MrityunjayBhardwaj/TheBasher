// #421/#424 — the id-reference sweep, and the guard that keeps its registry honest.
//
// Every fixture below uses DISTINCT, non-default ids and values so a pass cannot come
// from a value colliding with a fallback (a trap that has bitten here before): an
// argument ref cleared to '' must be distinguishable from one that was ALREADY ''.
import { describe, it, expect } from 'vitest';
import { idRefSweep, findDanglingIdRef } from './idRefSweep';
import { getNodeType, listNodeTypes } from './registry';
import { registerAllNodes } from '../../nodes/registerAll';
import type { Op } from './types';

registerAllNodes();

type FakeNodes = Record<string, { id: string; type: string; params: unknown }>;

function nodes(...defs: Array<[string, string, unknown]>): FakeNodes {
  const out: FakeNodes = {};
  for (const [id, type, params] of defs) out[id] = { id, type, params };
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
        ['cube', 'BoxMesh', {}],
        ['ch', 'KeyframeChannelVec3', { target: 'cube', paramPath: 'position' }],
      ),
      ['cube'],
    );
    expect([...s.remove].sort()).toEqual(['ch', 'cube']);
  });

  it('sweeps a constraint and a driver bound to the deleted object', () => {
    const s = idRefSweep(
      nodes(
        ['cube', 'BoxMesh', {}],
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
        ['cube', 'BoxMesh', {}],
        ['sphere', 'SphereMesh', {}],
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
        ['cube', 'BoxMesh', {}],
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
        ['cube', 'BoxMesh', {}],
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
        ['cubeA', 'BoxMesh', {}],
        ['cubeB', 'BoxMesh', {}],
      ),
      ['walkAction'],
    );
    expect([...s.remove]).toEqual(['walkAction']);
    expect(clearOf(s.ops, 'stripA', 'action')?.value).toBe('');
    expect(clearOf(s.ops, 'stripB', 'action')?.value).toBe('');
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
        ['cube', 'BoxMesh', {}],
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
        ['cube', 'BoxMesh', {}],
        ['other', 'BoxMesh', {}],
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
          ['cube', 'BoxMesh', {}],
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
  // The failure this prevents: someone adds a node type with a `target` (or another
  // id-shaped param) and does not declare it, so the sweep silently skips it and the
  // orphan family quietly reopens. A checklist a human must remember is not a
  // mechanism; this walks the live registry instead.
  const ID_SHAPED = ['target', 'aimNode', 'curve', 'action', 'strips'];

  // Params whose NAME looks id-shaped but which provably hold something else.
  // Each entry needs a reason, so the list cannot become a silent dumping ground.
  const NOT_A_NODE_ID: Record<string, string> = {
    'SpotLight.target': 'a vec3 aim POINT, not a node id',
    'TransformClip.target': 'a sanitised glTF scene-child key, not a DAG node id',
  };

  it('every id-shaped param on a registered node type is declared in idRefs', () => {
    const undeclared: string[] = [];
    for (const type of listNodeTypes()) {
      const def = getNodeType(type);
      if (!def) continue;
      const parsed = def.paramSchema.safeParse({});
      if (!parsed.success) continue; // no all-defaults shape to inspect
      const params = parsed.data as Record<string, unknown>;
      const declared = new Set((def.idRefs ?? []).map((r) => r.path.split('.')[0]));
      for (const key of ID_SHAPED) {
        if (!(key in params)) continue;
        if (declared.has(key)) continue;
        if (`${type}.${key}` in NOT_A_NODE_ID) continue;
        // Only a STRING (or array of strings) can hold a node id.
        const v = params[key];
        const idShaped = typeof v === 'string' || Array.isArray(v);
        if (idShaped) undeclared.push(`${type}.${key}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

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
      const shape = (def.paramSchema as unknown as { shape?: Record<string, unknown> }).shape;
      if (!shape) continue; // not a plain object schema — nothing to introspect
      for (const ref of def.idRefs) {
        const head = ref.path.split('.')[0];
        if (!(head in shape)) broken.push(`${type}.${ref.path}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
