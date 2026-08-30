// #816 — the Library row's format badge is DERIVED from the path, not asserted.
//
// The badge used to be the literal 'glb'. It was already wrong for the .gltf
// primitives, and stayed unnoticed while every bundled asset was glTF-family; the
// motion shelf (#815) made it false rather than merely imprecise, because the
// badge is the only thing on a row that says what KIND of asset it is — and mesh
// and motion do completely different things when dropped.
//
// So the real assertion is over the SHIPPED CATALOG, not over invented strings: a
// hand-written case list would still pass if a future entry carried an extension
// nobody thought about.

import { describe, it, expect } from 'vitest';
import { formatBadge } from './AssetLibrary';
import { ASSET_CATALOG } from './asset/catalog';

describe('formatBadge', () => {
  it('reads the extension, lowercased, with no dot', () => {
    expect(formatBadge('assets/motion/walk.bvh')).toBe('bvh');
    expect(formatBadge('assets/cube.gltf')).toBe('gltf');
    expect(formatBadge('assets/skinned-bar.glb')).toBe('glb');
    expect(formatBadge('assets/SHOUTING.GLTF')).toBe('gltf');
  });

  it('is empty for a path with no extension — never a slice of the filename', () => {
    expect(formatBadge('assets/noextension')).toBe('');
    expect(formatBadge('assets/.hidden')).toBe('');
  });

  it('every shipped catalog entry gets its OWN extension, and no entry says glb wrongly', () => {
    expect(ASSET_CATALOG.length).toBeGreaterThan(0);
    for (const entry of ASSET_CATALOG) {
      const ext = entry.path.slice(entry.path.lastIndexOf('.') + 1).toLowerCase();
      expect(formatBadge(entry.path)).toBe(ext);
    }
    // The regression that started this: motion must not be badged as a mesh.
    const motion = ASSET_CATALOG.filter((c) => c.path.endsWith('.bvh'));
    expect(motion.length).toBeGreaterThan(0);
    for (const clip of motion) expect(formatBadge(clip.path)).toBe('bvh');
  });
});

describe('the motion shelf (#815)', () => {
  it('ships six clips, named for the ACTION rather than the file', () => {
    const motion = ASSET_CATALOG.filter((c) => c.path.startsWith('assets/motion/'));
    expect(motion.map((c) => c.name)).toEqual(['Walk', 'Run', 'Jump', 'Crouch', 'Turn', 'Wave']);
    // A name that is just the filename back again would defeat the point.
    for (const clip of motion) {
      expect(clip.name).not.toContain('.');
      expect(clip.name).not.toContain('/');
    }
  });

  it('every clip seeds from the path it is stored under', () => {
    for (const clip of ASSET_CATALOG) expect(clip.seedUrl).toBe(`/${clip.path}`);
  });
});
