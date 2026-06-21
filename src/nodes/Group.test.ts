// #222 — a Group is transformable as a unit (Blender's parent/Empty): it carries
// its own position/rotation/scale + a pivot. Defaults are identity, so a pre-#222
// Group (empty params) evaluates to a bare in-place group (V10/H14 additive).
import { describe, it, expect } from 'vitest';
import { GroupNode, GroupParams } from './Group';

describe('Group — transformable as a unit (#222)', () => {
  it('defaults to identity transform (back-compat: empty params)', () => {
    const params = GroupParams.parse({});
    const v = GroupNode.evaluate(params, { children: [] });
    expect(v.kind).toBe('Group');
    expect(v.position).toEqual([0, 0, 0]);
    expect(v.rotation).toEqual([0, 0, 0]);
    expect(v.scale).toEqual([1, 1, 1]);
    expect(v.pivot).toEqual([0, 0, 0]);
    expect(v.children).toEqual([]);
  });

  it('surfaces an authored transform + pivot into the value', () => {
    const params = GroupParams.parse({
      position: [1, 2, 3],
      rotation: [0, 90, 0],
      scale: [2, 2, 2],
      pivot: [1, 2, 3],
    });
    const v = GroupNode.evaluate(params, { children: [] });
    expect(v.position).toEqual([1, 2, 3]);
    expect(v.rotation).toEqual([0, 90, 0]);
    expect(v.scale).toEqual([2, 2, 2]);
    expect(v.pivot).toEqual([1, 2, 3]);
  });

  it('passes children through unchanged', () => {
    const child = { kind: 'BoxMesh', position: [0, 0, 0] } as never;
    const v = GroupNode.evaluate(GroupParams.parse({}), { children: [child] });
    expect(v.children).toEqual([child]);
  });

  it('exposes a transform inspector section', () => {
    expect(GroupNode.inspectorSections).toContain('transform');
  });
});
