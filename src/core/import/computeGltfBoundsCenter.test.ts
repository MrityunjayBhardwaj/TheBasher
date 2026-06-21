// #222 — the import Group's pivot is the model's world-space bbox CENTRE,
// computed purely from glTF accessor min/max (no buffer reads) so the import
// rotates/scales about its own centre.
import { describe, it, expect } from 'vitest';
import { computeGltfBoundsCenter } from './gltfImportChain';
import type { GltfJson } from './glb';

function json(over: Partial<GltfJson> & Record<string, unknown>): GltfJson {
  return over as unknown as GltfJson;
}

describe('computeGltfBoundsCenter (#222)', () => {
  it('centres a single off-origin mesh from its POSITION accessor min/max', () => {
    // bbox [2,0,0]..[4,2,2] → centre [3,1,1].
    const c = computeGltfBoundsCenter(
      json({
        scenes: [{ nodes: [0] }],
        scene: 0,
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ min: [2, 0, 0], max: [4, 2, 2] }],
      }),
    );
    expect(c).toEqual([3, 1, 1]);
  });

  it('applies the node world transform (translation) to the bounds', () => {
    // local bbox [-1,-1,-1]..[1,1,1] centred at origin, node translated by [10,0,0]
    // → world centre [10,0,0].
    const c = computeGltfBoundsCenter(
      json({
        scenes: [{ nodes: [0] }],
        scene: 0,
        nodes: [{ mesh: 0, translation: [10, 0, 0] }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ min: [-1, -1, -1], max: [1, 1, 1] }],
      }),
    );
    expect(c[0]).toBeCloseTo(10, 6);
    expect(c[1]).toBeCloseTo(0, 6);
    expect(c[2]).toBeCloseTo(0, 6);
  });

  it('accumulates a parent → child node transform chain', () => {
    // parent translated [5,0,0]; child translated [0,5,0] under it; unit cube at
    // child → world centre [5,5,0].
    const c = computeGltfBoundsCenter(
      json({
        scenes: [{ nodes: [0] }],
        scene: 0,
        nodes: [
          { translation: [5, 0, 0], children: [1] },
          { mesh: 0, translation: [0, 5, 0] },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }],
      }),
    );
    expect(c[0]).toBeCloseTo(5, 6);
    expect(c[1]).toBeCloseTo(5, 6);
    expect(c[2]).toBeCloseTo(0, 6);
  });

  it('unions multiple meshes', () => {
    // mesh A [0,0,0]..[2,2,2], mesh B [4,4,4]..[6,6,6] → union [0..6] → centre [3,3,3].
    const c = computeGltfBoundsCenter(
      json({
        scenes: [{ nodes: [0, 1] }],
        scene: 0,
        nodes: [{ mesh: 0 }, { mesh: 1 }],
        meshes: [
          { primitives: [{ attributes: { POSITION: 0 } }] },
          { primitives: [{ attributes: { POSITION: 1 } }] },
        ],
        accessors: [
          { min: [0, 0, 0], max: [2, 2, 2] },
          { min: [4, 4, 4], max: [6, 6, 6] },
        ],
      }),
    );
    expect(c).toEqual([3, 3, 3]);
  });

  it('returns [0,0,0] when no positioned geometry / no accessor bounds', () => {
    expect(computeGltfBoundsCenter(json({ nodes: [] }))).toEqual([0, 0, 0]);
    expect(
      computeGltfBoundsCenter(
        json({
          nodes: [{ mesh: 0 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
          accessors: [{}], // no min/max
        }),
      ),
    ).toEqual([0, 0, 0]);
  });
});
