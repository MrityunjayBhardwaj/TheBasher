import { describe, expect, it } from 'vitest';
import {
  isCameraRootDrop,
  dropIntent,
  dropZoneAt,
  landsOnItself,
  reorderIndex,
} from './treeDropIntent';

describe('dropZoneAt — the edges are the top and bottom quarter', () => {
  it.each([
    [100, 'before'],
    [104, 'before'],
    [106, 'into'],
    [110, 'into'],
    [114, 'into'],
    [116, 'after'],
    [120, 'after'],
  ] as const)('y=%d over a 20px row at 100 → %s', (y, zone) => {
    expect(dropZoneAt(y, 100, 20)).toBe(zone);
  });

  it('a row with no height is all "into"', () => {
    expect(dropZoneAt(5, 0, 0)).toBe('into');
  });
});

describe('dropIntent', () => {
  const both = { canParent: true, canReorder: true };
  it('a sibling that can parent: the middle parents, the edges reorder', () => {
    expect(dropIntent('into', both)).toEqual({ kind: 'parent' });
    expect(dropIntent('before', both)).toEqual({ kind: 'reorder', place: 'before' });
    expect(dropIntent('after', both)).toEqual({ kind: 'reorder', place: 'after' });
  });

  it('a parent row under a different parent: every zone parents (nothing to reorder there)', () => {
    const allows = { canParent: true, canReorder: false };
    for (const zone of ['before', 'into', 'after'] as const)
      expect(dropIntent(zone, allows)).toEqual({ kind: 'parent' });
  });

  it('a leaf sibling: reorders from anywhere, after only from its bottom edge', () => {
    const allows = { canParent: false, canReorder: true };
    expect(dropIntent('before', allows)).toEqual({ kind: 'reorder', place: 'before' });
    expect(dropIntent('into', allows)).toEqual({ kind: 'reorder', place: 'before' });
    expect(dropIntent('after', allows)).toEqual({ kind: 'reorder', place: 'after' });
  });

  it('a row that allows neither refuses', () => {
    expect(dropIntent('into', { canParent: false, canReorder: false })).toBeNull();
  });
});

describe('reorderIndex — the index after the disconnect shifts the list', () => {
  // [a, b, c, d]
  it.each([
    [0, 2, 'before', 1], // a before c → [b, a, c, d]
    [0, 2, 'after', 2], // a after c → [b, c, a, d]
    [3, 1, 'before', 1], // d before b → [a, d, b, c]
    [3, 1, 'after', 2], // d after b → [a, b, d, c]
    [1, 0, 'before', 0], // b before a → [b, a, c, d]
  ] as const)('from %d, %s… at %d', (from, at, place, expected) => {
    expect(reorderIndex(from, at, place)).toBe(expected);
  });

  it('a drop that lands the node where it is does nothing', () => {
    expect(reorderIndex(1, 2, 'before')).toBeNull(); // b before c: already there
    expect(reorderIndex(2, 1, 'after')).toBeNull(); // c after b: already there
  });
});

describe('#1518 — a camera dropped on the Scene root stays in the scene', () => {
  const root = { nodeId: 'scene', depth: 0 };
  const group = { nodeId: 'g', depth: 1 };
  const row = (nodeId: string, socket: string) => ({
    nodeId: 'cam',
    depth: 2,
    parent: { nodeId, socket },
  });
  it('out of its group and into Scene.children', () => {
    expect(isCameraRootDrop(row('g', 'children'), root)).toBe(true);
  });
  it('no move for a camera already at the top, the active one, or a drop elsewhere', () => {
    expect(isCameraRootDrop(row('scene', 'children'), root)).toBe(false);
    expect(isCameraRootDrop(row('scene', 'camera'), root)).toBe(false);
    expect(isCameraRootDrop(row('g', 'children'), group)).toBe(false);
  });
});

describe('landsOnItself — by node, since a node has a row per collection holding it (#1505)', () => {
  const src = { nodeId: 'O' };
  it.each([
    ['its own row', 'O', 'S/collection/A/O', true],
    ['its copy under another collection', 'O', 'S/collection/B/O', true],
    ['a child under its own row', 'K', 'S/collection/A/O/K', true],
    ['a child under its other copy', 'K', 'S/collection/B/O/K', true],
    ['a sibling', 'P', 'S/collection/A/P', false],
    ['a node whose id starts with its id', 'O2', 'S/collection/A/O2', false],
    ['a child of a node whose id starts with its id', 'K', 'S/collection/A/O2/K', false],
  ])('%s', (_name, nodeId, key, expected) => {
    expect(landsOnItself(src, { nodeId, key })).toBe(expected);
  });
});
