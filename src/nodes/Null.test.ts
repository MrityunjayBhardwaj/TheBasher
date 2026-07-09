// Unit test for the Null controller node (#296).
import { describe, it, expect } from 'vitest';
import { NullNode } from './Null';

describe('NullNode', () => {
  it('evaluates to a Null value carrying its TRS', () => {
    const v = NullNode.evaluate(
      { position: [2, 1, 0], rotation: [0, 90, 0], scale: [1, 1, 1] },
      {},
      // ctx unused by a pure source
      undefined as never,
    );
    expect(v).toEqual({
      kind: 'Null',
      position: [2, 1, 0],
      rotation: [0, 90, 0],
      scale: [1, 1, 1],
    });
  });

  it('is a geometry-less source: no inputs, one SceneObject output', () => {
    expect(NullNode.inputs).toEqual({});
    expect(NullNode.outputs.out.type).toBe('SceneObject');
    expect(NullNode.pure).toBe(true);
  });

  it('paramSchema fills identity TRS defaults', () => {
    const parsed = NullNode.paramSchema.parse({});
    expect(parsed).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  });
});
