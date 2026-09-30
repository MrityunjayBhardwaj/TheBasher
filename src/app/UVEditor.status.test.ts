// The UV editor's status line (#1412). A kept clone-road import (#1053) resolves no mesh, exactly
// like an Object with no UVs, so both used to read "no UV layout". The kept import is not drawn at
// all, and Apply already says so for the same object; the pane must say the same thing.

import { describe, expect, it } from 'vitest';
import type { MeshUVSpace } from './resolveMeshUVSpace';
import { uvStatusLine } from './UVEditor';

const NONE: MeshUVSpace = {
  uvs: { uvs: null, status: 'none' },
  texture: { image: null, flipY: false, width: 0, height: 0, status: 'none' },
};

// A kept import: an `Object` whose `data` hangs off a `GltfData` carrying its address — the shape
// `isImportedChild` keys on (see importedChild.test.ts).
const nodes = {
  kept: { id: 'kept', type: 'Object', inputs: { data: { node: 'keptData', socket: 'out' } } },
  keptData: {
    id: 'keptData',
    type: 'GltfData',
    params: { assetRef: 'asset-a', childName: 'Cube', material: null },
    inputs: {},
  },
  empty: { id: 'empty', type: 'Object', inputs: {} },
};

describe('uvStatusLine', () => {
  it('names a kept import as not drawn, not as a mesh without UVs', () => {
    const line = uvStatusLine(nodes, nodes.kept, NONE);
    expect(line).toContain('not drawn');
    expect(line).not.toContain('no UV layout.');
  });

  it('keeps "no UV layout" for an ordinary Object that resolves no mesh (the control)', () => {
    expect(uvStatusLine(nodes, nodes.empty, NONE)).toBe('empty · Object — no UV layout.');
  });

  it('asks for a selection when nothing is selected', () => {
    expect(uvStatusLine(nodes, null, NONE)).toBe('Select a mesh to view UVs.');
  });

  it('reports loading before anything else', () => {
    const loading: MeshUVSpace = { ...NONE, uvs: { uvs: null, status: 'loading' } };
    expect(uvStatusLine(nodes, nodes.kept, loading)).toBe('kept · Object — loading geometry…');
  });
});
