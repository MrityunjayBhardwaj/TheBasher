// #1424 — which projects are refused for holding an old-structure import, and what the refusal says.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultProject } from './default';
import { MemoryStorage } from '../storage';
import { getNodeType } from '../dag';
import { loadProject, projectPath } from './io';
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

describe('#1243 — PoseOverride is retired, and a project holding one is still refused by name', () => {
  /** A saved project as stored, with a `PoseOverride` added the way the clone road's `poseBone`
   *  minted one: a hand-pose on a bone, beside the import it posed. */
  async function loadWith(project: {
    id: string;
    name: string;
    state: { nodes: Record<string, unknown> };
  }) {
    const storage = new MemoryStorage();
    const withPose = {
      ...project,
      state: {
        ...project.state,
        nodes: {
          ...project.state.nodes,
          n_pose: {
            id: 'n_pose',
            type: 'PoseOverride',
            version: 1,
            params: {
              bone: 'mixamorig:Hips',
              rotation: [0, 30, 0],
              overridden: { rotation: true },
            },
            inputs: {},
          },
        },
      },
    };
    await storage.write(
      projectPath(project.id),
      new TextEncoder().encode(JSON.stringify(withPose)),
    );
    return loadProject(storage, project.id);
  }

  it('the type is no longer registered', () => {
    expect(getNodeType('PoseOverride')).toBeUndefined();
  });

  it('a recorded character save holding one loads as far as the door, which names its file', async () => {
    const { project } = recorded('clone-characters/placed');
    const loaded = await loadWith(project as never);
    // Passed through as saved: the load does not fail on a type nothing registers.
    expect(loaded.state.nodes.n_pose.type).toBe('PoseOverride');
    expect(() => refuseOldImports(loaded)).toThrow(
      /saved on the old imported-file structure \("skinned-bar\.glb"/,
    );
  });

  it('one holding a PoseOverride alone is refused too, and says so', async () => {
    const project = buildDefaultProject();
    const loaded = await loadWith({ ...project, id: 'p-alone', name: 'Alone' } as never);
    let thrown: unknown;
    try {
      refuseOldImports(loaded);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OldImportRefusal);
    expect((thrown as OldImportRefusal).retired).toEqual(['PoseOverride']);
    expect((thrown as Error).message).toBe(
      '"Alone" cannot be opened: it holds a PoseOverride node from the old imported-file structure, which this version no longer reads.',
    );
  });

  it('any other unknown type still fails the load: only the retired list passes through', async () => {
    const project = buildDefaultProject();
    const storage = new MemoryStorage();
    const bad = {
      ...project,
      id: 'p-unknown',
      state: {
        ...project.state,
        nodes: {
          ...project.state.nodes,
          n_x: { id: 'n_x', type: 'NoSuchType', version: 1, params: {}, inputs: {} },
        },
      },
    };
    await storage.write(projectPath('p-unknown'), new TextEncoder().encode(JSON.stringify(bad)));
    await expect(loadProject(storage, 'p-unknown')).rejects.toThrow(/unknown type "NoSuchType"/);
  });
});
