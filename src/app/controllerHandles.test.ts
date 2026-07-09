// Unit tests for the viewport-handle resolver (#295, Inc 4).

import { describe, it, expect } from 'vitest';
import {
  collectHandleSpecs,
  defaultHandleKind,
  kindValidForType,
  resolveHandleKind,
} from './controllerHandles';
import type { SpareParam } from '../core/dag/types';

const p = (over: Partial<SpareParam> = {}): SpareParam => ({
  type: 'float',
  value: 0,
  ...over,
});

describe('defaultHandleKind', () => {
  it('maps vectors to point and scalars to slider; non-spatial types to null', () => {
    expect(defaultHandleKind('vec2')).toBe('point');
    expect(defaultHandleKind('vec3')).toBe('point');
    expect(defaultHandleKind('float')).toBe('slider');
    expect(defaultHandleKind('int')).toBe('slider');
    expect(defaultHandleKind('bool')).toBeNull();
    expect(defaultHandleKind('string')).toBeNull();
  });
});

describe('kindValidForType', () => {
  it('point drives vectors; slider/dial drive scalars', () => {
    expect(kindValidForType('point', 'vec3')).toBe(true);
    expect(kindValidForType('point', 'float')).toBe(false);
    expect(kindValidForType('slider', 'float')).toBe(true);
    expect(kindValidForType('dial', 'int')).toBe(true);
    expect(kindValidForType('dial', 'vec3')).toBe(false);
  });
});

describe('resolveHandleKind', () => {
  it('uses the type default when there is no override', () => {
    expect(resolveHandleKind(p({ type: 'vec3' }))).toBe('point');
    expect(resolveHandleKind(p({ type: 'float' }))).toBe('slider');
  });

  it('honours a valid override (float as a dial)', () => {
    expect(resolveHandleKind(p({ type: 'float', handle: { kind: 'dial' } }))).toBe('dial');
  });

  it('ignores an invalid override and falls back to the type default', () => {
    // point on a float is nonsensical → the slider default wins (never renders a
    // handle whose drag math cannot write the scalar).
    expect(resolveHandleKind(p({ type: 'float', handle: { kind: 'point' } }))).toBe('slider');
  });

  it('returns null for a non-spatial type even with an override', () => {
    expect(resolveHandleKind(p({ type: 'bool', handle: { kind: 'slider' } }))).toBeNull();
  });
});

describe('collectHandleSpecs', () => {
  it('returns nothing when no promoted spare resolves to a handle', () => {
    expect(
      collectHandleSpecs({
        a: { id: 'a', spare: { gain: p({ promoted: true, type: 'bool' }) } }, // non-spatial
        b: { id: 'b', spare: { size: p({ type: 'vec3' }) } }, // not promoted
        c: { id: 'c' }, // no spare
      }),
    ).toEqual([]);
  });

  it('resolves a promoted scalar to a slider with default axis/range', () => {
    const specs = collectHandleSpecs({
      n: { id: 'n', meta: { name: 'Knob' }, spare: { gain: p({ promoted: true, value: 5 }) } },
    });
    expect(specs).toEqual([
      {
        nodeId: 'n',
        nodeName: 'Knob',
        key: 'gain',
        type: 'float',
        kind: 'slider',
        value: 5,
        axis: 'x',
        min: 0,
        max: 1,
      },
    ]);
  });

  it('applies a dial override with a custom axis + range', () => {
    const specs = collectHandleSpecs({
      n: {
        id: 'n',
        spare: {
          angle: p({
            promoted: true,
            value: 45,
            handle: { kind: 'dial', axis: 'z', min: 0, max: 90 },
          }),
        },
      },
    });
    expect(specs[0]).toMatchObject({ kind: 'dial', axis: 'z', min: 0, max: 90, value: 45 });
  });

  it('resolves a promoted vec3 to a point handle', () => {
    const specs = collectHandleSpecs({
      n: { id: 'n', spare: { off: p({ promoted: true, type: 'vec3', value: [1, 2, 3] }) } },
    });
    expect(specs[0]).toMatchObject({ kind: 'point', type: 'vec3', value: [1, 2, 3] });
  });

  it('orders specs by node name then key for scene stability', () => {
    const specs = collectHandleSpecs({
      z: { id: 'z', meta: { name: 'Zeta' }, spare: { a: p({ promoted: true }) } },
      a: {
        id: 'a',
        meta: { name: 'Alpha' },
        spare: { b: p({ promoted: true }), a: p({ promoted: true }) },
      },
    });
    expect(specs.map((s) => `${s.nodeName}.${s.key}`)).toEqual(['Alpha.a', 'Alpha.b', 'Zeta.a']);
  });
});
