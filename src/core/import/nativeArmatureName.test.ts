// #1238 — a native glTF armature Object is named after its armature node, as Blender names it.
//
// Oracle: Blender 5.1.1's glTF importer on the same fixtures (`q1238_names.py`, run 2026-09-25):
// `skinned-bar.glb` → armature Object `SkinnedBar`; `two-skinned-bars.glb` → `SkinnedBar` and
// `SkinnedBarB`; `skinned-bar-bone-prop.glb` → `SkinnedBar`. The rule is `vnode.name or
// armature.name` (`io_scene_gltf2/blender/imp/node.py`, `create_object`). The name was the file's
// first animation's (`bend`, `Animation`), so two characters in one file shared one name.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../dag';
import type { DagState } from '../dag/state';
import { buildDefaultDagState } from '../project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildNativeGltfImportOps } from './nativeGltfImport';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

async function importNative(file: string): Promise<DagState> {
  let state = buildDefaultDagState();
  const bytes = readFileSync(`public/assets/${file}`);
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: `user-imports/native/${file}`,
    sceneNodeId: state.outputs.scene!.node,
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  for (const op of result.ops) state = applyOp(state, op).next;
  return state;
}

/** The armature Objects: an Object whose data is a Skeleton. */
function armatures(state: DagState) {
  return Object.values(state.nodes)
    .filter(
      (n) =>
        n.type === 'Object' &&
        state.nodes[(n.inputs.data as { node?: string } | undefined)?.node ?? '']?.type ===
          'Skeleton',
    )
    .sort((a, b) => (a.meta?.name ?? '').localeCompare(b.meta?.name ?? ''));
}

describe('#1238 — a native armature Object takes its armature node’s name', () => {
  it.each([
    ['skinned-bar.glb', ['SkinnedBar']],
    ['two-skinned-bars.glb', ['SkinnedBar', 'SkinnedBarB']],
    ['skinned-bar-bone-prop.glb', ['SkinnedBar']],
  ])('%s → Blender’s names %j', async (file, names) => {
    const state = await importNative(file);
    expect(armatures(state).map((n) => n.meta?.name)).toEqual(names);
  });

  it('renaming the clip leaves the character’s name alone', async () => {
    const state = await importNative('skinned-bar.glb');
    const [armature] = armatures(state);
    expect(armature.meta?.nameFrom).toBeUndefined();
    const clipId = (armature.inputs.pose as { node: string }).node;
    const renamed = applyOp(state, { type: 'setMeta', nodeId: clipId, name: 'swing' }).next;
    expect(renamed.nodes[clipId].meta?.name).toBe('swing');
    expect(renamed.nodes[armature.id].meta?.name).toBe('SkinnedBar');
  });
});
