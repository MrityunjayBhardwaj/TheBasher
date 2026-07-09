// Unit tests for the Controllers dock aggregator (#294, Inc 3).

import { describe, it, expect } from 'vitest';
import { collectPromotedControls } from './controllersDock';
import type { SpareParam } from '../core/dag/types';

const p = (over: Partial<SpareParam> = {}): SpareParam => ({
  type: 'float',
  value: 0,
  ...over,
});

describe('collectPromotedControls', () => {
  it('returns nothing when no node has a promoted spare', () => {
    expect(
      collectPromotedControls({
        a: { id: 'a', spare: { gain: p() } },
        b: { id: 'b' },
      }),
    ).toEqual([]);
  });

  it('collects only promoted spares', () => {
    const rows = collectPromotedControls({
      a: { id: 'a', spare: { gain: p({ promoted: true, value: 3 }), hidden: p() } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nodeId: 'a', key: 'gain', param: { value: 3 } });
  });

  it('uses meta.name for the node label, falling back to id', () => {
    const rows = collectPromotedControls({
      a: { id: 'a', meta: { name: 'Throttle' }, spare: { v: p({ promoted: true }) } },
      b: { id: 'b', spare: { w: p({ promoted: true }) } },
    });
    expect(rows.map((r) => r.nodeName)).toEqual(['b', 'Throttle']);
  });

  it('is stable: sorted by node name then key', () => {
    const rows = collectPromotedControls({
      n2: {
        id: 'n2',
        meta: { name: 'Zeb' },
        spare: { b: p({ promoted: true }), a: p({ promoted: true }) },
      },
      n1: { id: 'n1', meta: { name: 'Abe' }, spare: { z: p({ promoted: true }) } },
    });
    expect(rows.map((r) => `${r.nodeName}.${r.key}`)).toEqual(['Abe.z', 'Zeb.a', 'Zeb.b']);
  });
});
