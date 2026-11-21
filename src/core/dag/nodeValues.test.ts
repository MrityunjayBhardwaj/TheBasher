// #1953 — which values a node shows on itself in the Nodes view.

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from '../project/default';
import { applyOps } from './ops';
import type { DagState } from './state';
import { layoutOf, nodeHeight, viewEdgesOf, viewRowsOf } from './layout';
import {
  MAX_NODE_VALUES,
  NODE_VALUE_ROW,
  NODE_VALUE_VEC_ROW,
  nodeValueParams,
  nodeValuesHeight,
} from './nodeValues';

beforeAll(() => registerAllNodes());

function withOps(): DagState {
  return applyOps(buildDefaultDagState(), [
    { type: 'addNode', nodeId: 'arr', nodeType: 'ArrayModifier', params: {} },
    { type: 'addNode', nodeId: 'bev', nodeType: 'BevelModifier', params: {} },
    { type: 'addNode', nodeId: 'sph', nodeType: 'SphereData', params: {} },
  ]).next;
}

describe('nodeValueParams — #1953 values on nodes', () => {
  it('a box shows its size (the material stays in the panel)', () => {
    expect(nodeValueParams(buildDefaultDagState(), 'n_box_data')).toEqual(['size']);
  });

  it('a modifier shows its values, never its own on/off or a free-text scope', () => {
    const s = withOps();
    expect(nodeValueParams(s, 'arr')).toEqual(['count', 'offset']);
    expect(nodeValueParams(s, 'bev')).toEqual(['amount', 'limitMethod', 'angleLimit']);
  });

  it('a light shows its kind and levels, not its colour text', () => {
    expect(nodeValueParams(buildDefaultDagState(), 'n_light_data')).toEqual([
      'lightKind',
      'intensity',
      'distance',
    ]);
  });

  it('at most MAX_NODE_VALUES, in the declared order', () => {
    const s = withOps();
    expect(nodeValueParams(s, 'sph')).toEqual(['radius', 'widthSegments', 'heightSegments']);
    expect(nodeValueParams(s, 'sph').length).toBeLessThanOrEqual(MAX_NODE_VALUES);
  });

  it('an object end shows none: its pose is the viewport’s', () => {
    const s = buildDefaultDagState();
    for (const id of ['n_box', 'n_camera', 'n_light', 'n_light_target'])
      expect(nodeValueParams(s, id), id).toEqual([]);
  });

  it('a node with nothing homed, or an id the graph does not have, shows none', () => {
    const s = buildDefaultDagState();
    expect(nodeValueParams(s, 'n_light_aim')).toEqual([]);
    expect(nodeValueParams(s, 'nope')).toEqual([]);
  });

  it('the height an x/y/z row and a one-line row add', () => {
    const s = withOps();
    expect(nodeValuesHeight(s, 'n_box_data')).toBe(NODE_VALUE_VEC_ROW);
    expect(nodeValuesHeight(s, 'arr')).toBe(NODE_VALUE_ROW + NODE_VALUE_VEC_ROW);
    expect(nodeValuesHeight(s, 'n_box')).toBe(0);
  });

  it('the layout makes room for them: no node in a column overlaps the one below', () => {
    const s = withOps();
    const at = layoutOf(s);
    const rows = viewRowsOf(viewEdgesOf(s));
    const box = (id: string) =>
      nodeHeight(rows.inputs.get(id)?.length ?? 0, rows.outputs.get(id)?.length ?? 0) +
      nodeValuesHeight(s, id);
    const columns = new Map<number, string[]>();
    for (const [id, [x]] of at) columns.set(x, [...(columns.get(x) ?? []), id]);
    let checked = 0;
    for (const ids of columns.values()) {
      const sorted = [...ids].sort((a, b) => at.get(a)![1] - at.get(b)![1]);
      for (let i = 1; i < sorted.length; i++) {
        const above = sorted[i - 1];
        expect(at.get(sorted[i])![1], `${sorted[i]} under ${above}`).toBeGreaterThanOrEqual(
          at.get(above)![1] + box(above),
        );
        if (nodeValuesHeight(s, above) > 0) checked++;
      }
    }
    // The premise: some node with values has a node below it, so the check above is not empty.
    expect(checked).toBeGreaterThan(0);
  });
});
