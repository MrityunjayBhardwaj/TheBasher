// #1205 — which road the product's import takes for a file. A skinned file is a character, and a
// character is native or it is not imported: when the native reader refuses one, nothing is
// written, and the refusal is said by name. A file with no skin still takes the clone road when
// the native reader refuses it (the rest of the road retires with #1053).
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import { __resetRegistryForTests } from '../../core/dag/registry';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from '../../core/project/default';

const storage = new MemoryStorage();
vi.mock('../boot', () => ({ getStorage: async () => storage }));

const { buildGltfImportOpsFromOpfs } = await import('./importGltf');

type Json = {
  nodes: { name?: string; mesh?: number; skin?: number; children?: number[] }[];
  scenes: { nodes: number[] }[];
  skins?: unknown[];
};

/** skinned-bar.glb with its JSON chunk rewritten; the binary chunk is carried over untouched. */
function skinnedBarWith(mutate: (json: Json) => void): Uint8Array {
  const src = readFileSync('public/assets/skinned-bar.glb');
  const jsonLength = src.readUInt32LE(12);
  const json = JSON.parse(src.subarray(20, 20 + jsonLength).toString());
  mutate(json);
  let text = JSON.stringify(json);
  text += ' '.repeat((4 - (text.length % 4)) % 4);
  const jsonBytes = Buffer.from(text);
  const rest = src.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonBytes.length + rest.length, 8);
  header.writeUInt32LE(jsonBytes.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return new Uint8Array(Buffer.concat([header, jsonBytes, rest]));
}

/** A second node drawing the bar's mesh: the native reader refuses a shared mesh (#1061). */
const shareTheMesh = (json: Json) => {
  json.nodes.push({ name: 'Twin', mesh: 0 });
  json.scenes[0].nodes.push(json.nodes.length - 1);
};

async function road(path: string, bytes: Uint8Array) {
  await storage.write(path, bytes);
  return buildGltfImportOpsFromOpfs(path, 'n_scene', buildDefaultDagState());
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('the road a file takes into the project', () => {
  it('a skinned file comes in native: a skeleton, and a mesh an Armature modifier deforms', async () => {
    const result = await road(
      'user-imports/a/skinned-bar.glb',
      skinnedBarWith(() => {}),
    );
    expect(result.road).toBe('native');
    if (result.road !== 'native') return;
    const types = result.ops.flatMap((op) => (op.type === 'addNode' ? [op.nodeType] : []));
    expect(types).toContain('Skeleton');
    expect(types).toContain('ArmatureModifier');
  });

  it('a skinned file the native reader refuses: not imported at all, and the refusal named', async () => {
    const result = await road('user-imports/b/skinned-bar.glb', skinnedBarWith(shareTheMesh));
    expect(result).toEqual({
      road: 'refused',
      nativeRefusal: {
        refused: expect.stringContaining('share mesh 0'),
        issue: '#1061',
      },
    });
  });

  it('the same refusal on a file with no skin: the clone road, as before', async () => {
    const result = await road(
      'user-imports/c/skinned-bar.glb',
      skinnedBarWith((json) => {
        shareTheMesh(json);
        delete json.skins;
        for (const node of json.nodes) delete node.skin;
      }),
    );
    expect(result.road).toBe('clone');
  });
});
