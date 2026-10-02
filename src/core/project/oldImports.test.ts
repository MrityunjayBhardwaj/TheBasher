// #1424 — which projects are refused for holding an old-structure import, and what the refusal says.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultProject } from './default';
import { OldImportRefusal, oldImportFiles, refuseOldImports } from './oldImports';

registerAllNodes();

type Recorded = { project: { name: string; state: { nodes: Record<string, { type: string }> } } };
const recorded = (name: string): Recorded =>
  JSON.parse(readFileSync(`src/core/project/__fixtures__/${name}.json`, 'utf8')) as Recorded;

describe('a project holding an old-structure import is refused (#1424)', () => {
  it('a recorded model save is refused, naming its file once', () => {
    const { project } = recorded('clone-models/refused-iridescence');
    // The recording holds the import as several nodes that all point at the one file.
    expect(
      Object.values(project.state.nodes).filter((n) => n.type.startsWith('Gltf')).length,
    ).toBeGreaterThan(1);
    expect(oldImportFiles(project.state.nodes)).toEqual(['iridescence-quad.gltf']);
    let thrown: unknown;
    try {
      refuseOldImports(project);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OldImportRefusal);
    expect((thrown as Error).message).toBe(
      `"${project.name}" cannot be opened: it holds an import saved on the old imported-file structure ("iridescence-quad.gltf"), which this version no longer reads. Import the file again in a new project; the edits made on it in this project are not carried over.`,
    );
  });

  it('a recorded character save is refused', () => {
    const { project } = recorded('clone-characters/placed');
    expect(() => refuseOldImports(project)).toThrow(OldImportRefusal);
  });

  it('two files are both named', () => {
    const nodes = {
      a: { type: 'GltfAsset', params: { assetRef: 'user-imports/a/a.glb' } },
      b: { type: 'GltfData', params: { assetRef: 'user-imports/b/b.glb' } },
      c: { type: 'GltfData', params: { assetRef: 'user-imports/a/a.glb' } },
      d: { type: 'GltfSkeleton', params: {} },
    };
    expect(oldImportFiles(nodes)).toEqual(['a.glb', 'b.glb', 'an unnamed file']);
    expect(() => refuseOldImports({ name: 'P', state: { nodes } })).toThrow(
      /3 imports .*the files/,
    );
  });

  it('a project with no such import opens', () => {
    const project = buildDefaultProject();
    expect(Object.keys(project.state.nodes).length).toBeGreaterThan(3);
    expect(() => refuseOldImports(project)).not.toThrow();
  });
});
