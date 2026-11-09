import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag/ops';
import { emptyDagState, type DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { paramWiredFrom } from './wiredParam';

beforeAll(() => registerAllNodes());

const build = (ops: Op[]): DagState => ops.reduce((s, op) => applyOp(s, op).next, emptyDagState());
const add = (nodeId: string, nodeType: string, params = {}): Op => ({
  type: 'addNode',
  nodeId,
  nodeType,
  params,
});
const wire = (from: string, to: string, socket: string): Op => ({
  type: 'connect',
  from: { node: from, socket: 'out' },
  to: { node: to, socket },
});

describe('#1811 a setting a wire has taken over', () => {
  it('names the source once wired, and nothing before', () => {
    const open = build([add('q', 'Fit'), add('m', 'Mix')]);
    expect(paramWiredFrom(open, 'm', 'factor')).toBeNull();
    expect(paramWiredFrom(applyOp(open, wire('q', 'm', 'factor')).next, 'm', 'factor')).toBe('q');
  });

  it('a wire on a different socket says nothing about the setting', () => {
    const s = build([add('q', 'Fit'), add('m', 'Mix'), wire('q', 'm', 'a')]);
    expect(paramWiredFrom(s, 'm', 'factor')).toBeNull();
  });

  it('a param with no socket of its name, an unknown node: nothing', () => {
    const s = build([add('m', 'Mix')]);
    expect(paramWiredFrom(s, 'm', 'dataType')).toBeNull();
    expect(paramWiredFrom(s, 'nope', 'factor')).toBeNull();
  });
});
