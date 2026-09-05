// importedChild — the one answer to "is this an imported glTF child?" (#389).
//
// These pin the FUSED reading, deliberately. The seam lands before the split so that the
// flip is a change to one file; that is only true if these specs describe the ANSWER
// rather than the spelling, so they are written against the node table and the facts, and
// the flip should leave every one of them passing unchanged.

import { describe, expect, it } from 'vitest';
import {
  findImportedChild,
  importedChildOf,
  importedChildrenOf,
  isImportedChild,
  type NodeLike,
} from './importedChild';

const child = (assetRef: string, childName: string, overridden?: unknown): NodeLike => ({
  type: 'GltfChild',
  params: { assetRef, childName, position: [0, 0, 0], ...(overridden ? { overridden } : {}) },
});

const nodes: Record<string, NodeLike> = {
  c1: child('asset-a', 'Cube'),
  c2: child('asset-a', 'Bone1', { position: true, rotation: false, scale: false }),
  c3: child('asset-b', 'Cube'),
  box: { type: 'BoxData', params: { size: [1, 1, 1] } },
  obj: { type: 'Object', params: { position: [0, 0, 0] }, inputs: { data: { node: 'box' } } },
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
    const broken: Record<string, NodeLike> = {
      x: { type: 'GltfChild', params: { assetRef: 'asset-a' } },
      y: { type: 'GltfChild', params: { childName: 'Cube' } },
      z: { type: 'GltfChild', params: undefined },
    };
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
