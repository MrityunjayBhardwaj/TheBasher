// importedChild — the one answer to "is this an imported glTF child?" (#389).
//
// These were written against the FUSED reading, deliberately, so that the flip would be a
// change to one production file. That held: #389 rewrote `importedChildOf`'s body and not
// one ASSERTION below moved — only the fixture did, from one node to the pair it became.
// That is the split the seam exists to make: the specs describe the ANSWER, the fixture
// describes the spelling, and only the spelling changed.

import { describe, expect, it } from 'vitest';
import {
  findImportedChild,
  importedChildOf,
  importedChildrenOf,
  isImportedChild,
  type NodeLike,
} from './importedChild';

/**
 * One imported child, as the two nodes it now is.
 *
 * `overridden` goes on the OBJECT and the address on the DATA half — which is the whole
 * reason the reader takes a hop AND reads back, and why a fixture that put both on one
 * node would let a broken reader pass.
 */
const child = (
  id: string,
  assetRef: string,
  childName: string,
  overridden?: unknown,
): Record<string, NodeLike> => ({
  [`${id}__data`]: { type: 'GltfData', params: { assetRef, childName, material: null } },
  [id]: {
    type: 'Object',
    params: { position: [0, 0, 0], ...(overridden ? { overridden } : {}) },
    inputs: { data: { node: `${id}__data`, socket: 'out' } },
  },
});

const nodes: Record<string, NodeLike> = {
  ...child('c1', 'asset-a', 'Cube'),
  ...child('c2', 'asset-a', 'Bone1', { position: true, rotation: false, scale: false }),
  ...child('c3', 'asset-b', 'Cube'),
  box: { type: 'BoxData', params: { size: [1, 1, 1] } },
  // An Object over a NON-glTF data node — the impostor that differs in the tested
  // property alone, and the reason the reader checks the data half's TYPE rather than
  // merely that a `data` edge exists.
  obj: {
    type: 'Object',
    params: { position: [0, 0, 0] },
    inputs: { data: { node: 'box', socket: 'out' } },
  },
};

describe('importedChildOf', () => {
  it('reads the asset and name off an imported child', () => {
    expect(importedChildOf(nodes, 'c1')).toEqual({
      assetRef: 'asset-a',
      childName: 'Cube',
      overridden: { position: false, rotation: false, scale: false },
    });
  });

  it('carries the override flags through', () => {
    expect(importedChildOf(nodes, 'c2')?.overridden).toEqual({
      position: true,
      rotation: false,
      scale: false,
    });
  });

  it('defaults absent flags to all-false rather than undefined', () => {
    // A caller branching on `overridden[field]` must never see `undefined` — that is
    // falsy today and would go on being falsy after a spelling change, which is exactly
    // the kind of accidental correctness that stops being correct silently.
    expect(importedChildOf(nodes, 'c1')?.overridden).toEqual({
      position: false,
      rotation: false,
      scale: false,
    });
  });

  it('is null for a node that is not an imported child, and for one that does not exist', () => {
    expect(importedChildOf(nodes, 'box')).toBeNull();
    expect(importedChildOf(nodes, 'obj')).toBeNull();
    expect(importedChildOf(nodes, 'nope')).toBeNull();
    expect(importedChildOf(nodes, null)).toBeNull();
    expect(importedChildOf(nodes, undefined)).toBeNull();
  });

  it('is null — not partial — when either string is missing', () => {
    // A half answer is worse than none: `assetRef` without `childName` addresses the
    // whole asset, so a caller that took it would act on the wrong subject.
    const half = (id: string, params: unknown): Record<string, NodeLike> => ({
      [`${id}__data`]: { type: 'GltfData', params },
      [id]: {
        type: 'Object',
        params: { position: [0, 0, 0] },
        inputs: { data: { node: `${id}__data`, socket: 'out' } },
      },
    });
    const broken: Record<string, NodeLike> = {
      ...half('x', { assetRef: 'asset-a' }),
      ...half('y', { childName: 'Cube' }),
      ...half('z', undefined),
      // And the shape only the split can produce: an Object whose `data` edge points at
      // nothing at all. The fused kind had no way to be half-present.
      dangling: {
        type: 'Object',
        params: { position: [0, 0, 0] },
        inputs: { data: { node: 'gone', socket: 'out' } },
      },
    };
    expect(importedChildOf(broken, 'dangling')).toBeNull();
    expect(importedChildOf(broken, 'x')).toBeNull();
    expect(importedChildOf(broken, 'y')).toBeNull();
    expect(importedChildOf(broken, 'z')).toBeNull();
  });
});

describe('isImportedChild', () => {
  it('agrees with importedChildOf in both directions', () => {
    expect(isImportedChild(nodes, 'c1')).toBe(true);
    expect(isImportedChild(nodes, 'box')).toBe(false);
    expect(isImportedChild(nodes, 'nope')).toBe(false);
  });
});

describe('findImportedChild', () => {
  it('finds by name alone', () => {
    expect(findImportedChild(nodes, 'Bone1')?.[0]).toBe('c2');
  });

  it('narrows by asset when the name is ambiguous', () => {
    // `Cube` exists in both assets. This is the case the optional parameter exists for,
    // and the reason callers that know their asset must pass it.
    expect(findImportedChild(nodes, 'Cube', 'asset-b')?.[0]).toBe('c3');
    expect(findImportedChild(nodes, 'Cube', 'asset-a')?.[0]).toBe('c1');
  });

  it('is null for a name nothing carries, and for the right name in the wrong asset', () => {
    expect(findImportedChild(nodes, 'Nothing')).toBeNull();
    expect(findImportedChild(nodes, 'Bone1', 'asset-b')).toBeNull();
  });
});

describe('importedChildrenOf', () => {
  it('returns every child of one asset, and nothing from another', () => {
    const found = importedChildrenOf(nodes, 'asset-a');
    expect(found.map(([id]) => id).sort()).toEqual(['c1', 'c2']);
  });

  it('is empty for an asset with no children rather than null', () => {
    // The caller iterates; an empty array iterates correctly and a null does not.
    expect(importedChildrenOf(nodes, 'asset-none')).toEqual([]);
  });
});
