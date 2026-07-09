// Unit tests for the pure spare-param authoring helpers (#294, Inc 3). The React
// surface (rows, add form, promote toggle) is exercised by e2e; the disjointness
// guard + default-value logic are pure and unit-tested here.

import { describe, it, expect } from 'vitest';
import { defaultSpareValue, spareNameRejection } from './SpareParamControls';

describe('defaultSpareValue', () => {
  it('zeroes each type', () => {
    expect(defaultSpareValue('float')).toBe(0);
    expect(defaultSpareValue('int')).toBe(0);
    expect(defaultSpareValue('bool')).toBe(false);
    expect(defaultSpareValue('string')).toBe('');
    expect(defaultSpareValue('vec2')).toEqual([0, 0]);
    expect(defaultSpareValue('vec3')).toEqual([0, 0, 0]);
  });
});

describe('spareNameRejection', () => {
  it('accepts a free name', () => {
    expect(spareNameRejection('throttle', ['intensity', 'color'], [])).toBeNull();
  });

  it('trims and accepts', () => {
    expect(spareNameRejection('  throttle  ', [], [])).toBeNull();
  });

  it('rejects an empty / whitespace name', () => {
    expect(spareNameRejection('', [], [])).toBe('name required');
    expect(spareNameRejection('   ', [], [])).toBe('name required');
  });

  it('rejects a duplicate spare name', () => {
    expect(spareNameRejection('gain', [], ['gain'])).toMatch(/already exists/);
  });

  it('rejects a name colliding with a fixed param (Q1 — a real param wins the read)', () => {
    expect(spareNameRejection('intensity', ['intensity'], [])).toMatch(/built-in param/);
  });

  it('checks the trimmed name against collisions', () => {
    expect(spareNameRejection('  intensity ', ['intensity'], [])).toMatch(/built-in param/);
    expect(spareNameRejection('  gain ', [], ['gain'])).toMatch(/already exists/);
  });
});
