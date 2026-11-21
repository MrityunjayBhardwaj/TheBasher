// #1707 — the Library tab's kind, source and search narrowing, checked over the shipped catalog
// plus an import of each family, so a new catalog entry whose extension the importer does not know
// reds here instead of silently falling out of every kind filter.

import { describe, expect, it } from 'vitest';
import { ASSET_CATALOG } from '../asset/catalog';
import { countBySource, filterEntries, kindOf, type LibraryEntry } from './libraryEntries';

const samples: LibraryEntry[] = ASSET_CATALOG.map((c) => ({
  path: c.path,
  name: c.name,
  source: 'sample',
  kind: kindOf(c.path),
  swatch: c.swatch,
  available: true,
}));
const imports: LibraryEntry[] = [
  {
    path: 'user-imports/robot/scene.gltf',
    name: 'robot',
    source: 'import',
    kind: 'model',
    swatch: '#000',
    available: true,
  },
  {
    path: 'user-imports/my-walk/walk.bvh',
    name: 'my-walk',
    source: 'import',
    kind: 'motion',
    swatch: '#000',
    available: true,
  },
];
const all = [...samples, ...imports];

describe('kindOf', () => {
  it('reads the family the importer gives the extension', () => {
    expect(kindOf('assets/cube.gltf')).toBe('model');
    expect(kindOf('a/b.GLB')).toBe('model');
    expect(kindOf('assets/motion/walk.bvh')).toBe('motion');
    expect(kindOf('x/clip.fbx')).toBe('motion');
    expect(kindOf('x/notes.txt')).toBeNull();
  });

  it('knows every shipped catalog entry', () => {
    for (const s of samples) expect(s.kind, s.path).not.toBeNull();
  });
});

describe('filterEntries', () => {
  const base = { source: 'all', kind: 'all', query: '' } as const;

  it('shows everything unfiltered', () => {
    expect(filterEntries(all, base)).toHaveLength(all.length);
  });

  it('narrows by kind', () => {
    const motions = filterEntries(all, { ...base, kind: 'motion' });
    expect(motions.map((e) => e.name)).toEqual([
      'Walk',
      'Run',
      'Jump',
      'Crouch',
      'Turn',
      'Wave',
      'my-walk',
    ]);
    expect(filterEntries(all, { ...base, kind: 'model' }).every((e) => e.kind === 'model')).toBe(
      true,
    );
  });

  it('narrows by source', () => {
    expect(filterEntries(all, { ...base, source: 'import' }).map((e) => e.name)).toEqual([
      'robot',
      'my-walk',
    ]);
    expect(filterEntries(all, { ...base, source: 'sample' })).toHaveLength(samples.length);
  });

  it('searches by name, case-insensitively, ignoring surrounding spaces', () => {
    expect(filterEntries(all, { ...base, query: '  WALK ' }).map((e) => e.name)).toEqual([
      'Walk',
      'my-walk',
    ]);
    expect(filterEntries(all, { ...base, query: 'zzz' })).toEqual([]);
  });

  it('combines all three', () => {
    expect(
      filterEntries(all, { source: 'sample', kind: 'motion', query: 'walk' }).map((e) => e.name),
    ).toEqual(['Walk']);
  });
});

describe('countBySource', () => {
  it('counts what each source would show under the kind and search', () => {
    expect(countBySource(all, { kind: 'all', query: '' })).toEqual({
      all: all.length,
      sample: samples.length,
      import: 2,
    });
    expect(countBySource(all, { kind: 'motion', query: 'walk' })).toEqual({
      all: 2,
      sample: 1,
      import: 1,
    });
  });
});
