// #1282 — an example that refers to a stored asset opens only if boot seeded that asset first: an
// example ships with the app, and app-shipped assets are seeded, never embedded (`sceneBundle.ts`),
// while the renderer throws on a missing file (#1281). So every `assetRef` a bundled example holds
// must be a path the asset catalog seeds.

import { describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildAllExampleProjects } from '../../core/project/examples';
import { ASSET_CATALOG } from './catalog';

registerAllNodes();

describe('bundled examples refer only to seeded assets (#1282)', () => {
  it('every assetRef an example holds is a catalog path', async () => {
    const seeded = new Set(ASSET_CATALOG.map((e) => e.path));
    const refs: string[] = [];
    for (const project of await buildAllExampleProjects())
      for (const [id, node] of Object.entries(project.state.nodes)) {
        const ref = (node.params as { assetRef?: unknown }).assetRef;
        if (typeof ref === 'string' && ref) refs.push(`${project.id} ${id} ${ref}`);
      }
    // The denominator: the character example alone holds 25 (its GltfAsset + 24 GltfData).
    expect(refs.length).toBeGreaterThanOrEqual(25);
    expect(refs.filter((r) => !seeded.has(r.split(' ')[2]))).toEqual([]);
  });
});
