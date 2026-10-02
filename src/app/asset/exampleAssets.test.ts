// #1282 — an example that refers to a stored asset opens only if boot seeded that asset first: an
// example ships with the app, and app-shipped assets are seeded, never embedded (`sceneBundle.ts`),
// while the renderer throws on a missing file (#1281). So every `assetRef` a bundled example holds
// must be a path the asset catalog seeds.
//
// #1424 — the examples also hold no node type that only a project saved on the old imported-file
// structure has: such a project is refused on load, and a shipped example must open.

import { describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildAllExampleProjects } from '../../core/project/examples';
import { ASSET_CATALOG } from './catalog';

registerAllNodes();

/** Every string under `assetRef`, at any depth of a node's params. */
function assetRefsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) assetRefsIn(v, out);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (k === 'assetRef' && typeof v === 'string' && v) out.push(v);
      else assetRefsIn(v, out);
    }
  return out;
}

describe('bundled examples refer only to seeded assets (#1282)', () => {
  it('finds an assetRef at any depth, and names one the catalog does not seed', () => {
    // The examples hold no stored-file reference today (the character is native geometry, #1424),
    // so the rule below has nothing to bite on. This row is what shows the reader still sees one.
    expect(
      assetRefsIn({ a: [{ assetRef: 'x.glb' }], assetRef: 'y.glb', b: { assetRef: '' } }),
    ).toEqual(['x.glb', 'y.glb']);
  });

  it('every assetRef an example holds is a catalog path', async () => {
    const seeded = new Set(ASSET_CATALOG.map((e) => e.path));
    const refs: string[] = [];
    for (const project of await buildAllExampleProjects())
      for (const [id, node] of Object.entries(project.state.nodes))
        for (const ref of assetRefsIn(node.params)) refs.push(`${project.id} ${id} ${ref}`);
    expect(refs.filter((r) => !seeded.has(r.split(' ')[2]))).toEqual([]);
  });
});

describe('bundled examples are stored on the current structure (#1424)', () => {
  it('no example holds a node type only an old imported-file save has', async () => {
    const old = new Set([
      'GltfAsset',
      'GltfData',
      'GltfSkeleton',
      'PoseOverride',
      'ClipSelect',
      'TransformClip',
    ]);
    const projects = await buildAllExampleProjects();
    // The denominator: three examples, and the character one alone holds 20+ nodes.
    expect(projects.length).toBeGreaterThanOrEqual(3);
    expect(projects.reduce((n, p) => n + Object.keys(p.state.nodes).length, 0)).toBeGreaterThan(40);
    const held = projects.flatMap((p) =>
      Object.entries(p.state.nodes)
        .filter(([, node]) => old.has(node.type))
        .map(([id, node]) => `${p.id} ${id} ${node.type}`),
    );
    expect(held).toEqual([]);
  });
});
