// gltfImportChain unit tests — what is left of the file after the clone builder went (#1424):
// the scene-node name map and an old import's footprint in a saved graph.
//
// REF: PLAN.md Wave D; issues #127, #1424.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNodeNameMap, importGroupNodeIds } from './gltfImportChain';
import type { DagState } from '../dag/state';
import type { GltfJson } from './glb';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultProject } from '../project/default';

registerAllNodes();

/** Loads the committed skinned-bar.glb fixture as an ArrayBuffer (P7.7 #91).
 *  vitest runs from the repo root, so resolve against process.cwd(). */
function skinnedBarBuffer(): ArrayBuffer {
  const node = readFileSync(resolve(process.cwd(), 'public/assets/skinned-bar.glb'));
  return node.buffer.slice(node.byteOffset, node.byteOffset + node.byteLength) as ArrayBuffer;
}

describe('buildNodeNameMap', () => {
  it('dedupes duplicate Cube names with __1 suffix in JSON order', () => {
    const json: GltfJson = { nodes: [{ name: 'Cube' }, { name: 'Cube' }] };
    const { nodeNameMap, keyByGltfNodeIndex } = buildNodeNameMap(json, 'asset/foo.glb');
    expect(Object.keys(nodeNameMap).sort()).toEqual(['Cube', 'Cube__1']);
    expect(keyByGltfNodeIndex[0]).toBe('Cube');
    expect(keyByGltfNodeIndex[1]).toBe('Cube__1');
  });

  it('sanitises THREE-reserved characters in node names', () => {
    const json: GltfJson = { nodes: [{ name: 'Spine[0]' }] };
    const { nodeNameMap } = buildNodeNameMap(json, 'asset/foo.glb');
    expect(Object.keys(nodeNameMap)[0]).not.toContain('[');
    expect(Object.keys(nodeNameMap)[0]).not.toContain(']');
  });

  it('falls back to `node_<i>` for empty names', () => {
    const json: GltfJson = { nodes: [{ name: 'Cube' }, { name: '' }, { name: 'Other' }] };
    const { keyByGltfNodeIndex } = buildNodeNameMap(json, 'asset/foo.glb');
    expect(keyByGltfNodeIndex[1]).toBe('node_1');
  });

  it('deterministic: same (json, assetRef) → same dag ids', () => {
    const json: GltfJson = { nodes: [{ name: 'Cube' }] };
    const a = buildNodeNameMap(json, 'asset/foo.glb');
    const b = buildNodeNameMap(json, 'asset/foo.glb');
    expect(a.nodeNameMap).toEqual(b.nodeNameMap);
  });

  it('different assetRef → different dag ids', () => {
    const json: GltfJson = { nodes: [{ name: 'Cube' }] };
    const a = buildNodeNameMap(json, 'asset/foo.glb');
    const b = buildNodeNameMap(json, 'asset/bar.glb');
    expect(a.nodeNameMap.Cube).not.toBe(b.nodeNameMap.Cube);
  });

  // P7.7 (#91 A3) — childHierarchy persisted by KEY for the outliner.
  it('childHierarchy maps parent KEY → child KEYs (by post-dedup key, not index)', () => {
    // Index 0 = Root with children [1, 2]; 1 = ChildA; 2 = ChildB.
    const json: GltfJson = {
      nodes: [{ name: 'Root', children: [1, 2] }, { name: 'ChildA' }, { name: 'ChildB' }],
    };
    const { childHierarchy } = buildNodeNameMap(json, 'asset/h.glb');
    expect(childHierarchy).toEqual({ Root: ['ChildA', 'ChildB'] });
  });

  it('childHierarchy stores deduped child keys (bone__1), not raw names', () => {
    // Two same-named children → second is deduped to Bone__1.
    const json: GltfJson = {
      nodes: [{ name: 'Root', children: [1, 2] }, { name: 'Bone' }, { name: 'Bone' }],
    };
    const { childHierarchy } = buildNodeNameMap(json, 'asset/h.glb');
    expect(childHierarchy.Root).toEqual(['Bone', 'Bone__1']);
  });

  it('childless glTF → empty childHierarchy (no spurious entries)', () => {
    const json: GltfJson = { nodes: [{ name: 'A' }, { name: 'B' }] };
    const { childHierarchy } = buildNodeNameMap(json, 'asset/flat.glb');
    expect(childHierarchy).toEqual({});
  });

  it('skinned-bar.glb: nests the bone chain (SkinnedBar→Bone0→Bone1)', () => {
    const buf = skinnedBarBuffer();
    // Parse the JSON chunk directly to feed buildNodeNameMap with the real json.
    const dv = new DataView(buf);
    const jsonLen = dv.getUint32(12, true);
    const jsonBytes = new Uint8Array(buf, 20, jsonLen);
    const json = JSON.parse(new TextDecoder().decode(jsonBytes)) as GltfJson;
    const { childHierarchy } = buildNodeNameMap(json, 'assets/skinned-bar.glb');
    // Fixture hierarchy: SkinnedBar→[Bone0], Bone0→[Bone1].
    expect(childHierarchy).toEqual({ SkinnedBar: ['Bone0'], Bone0: ['Bone1'] });
  });
});

describe('importGroupNodeIds (#127 — break-refs GC footprint)', () => {
  // A project SAVED with an animated, skinned clone import — the only place such a footprint
  // exists since the builder that made one was removed (#1424). The recording is the project as
  // the app wrote it: a default scene plus the import, so the import's footprint is exactly the
  // nodes the default scene does not have. importGroupNodeIds must select that — never the Scene
  // anchor, never a node of the scene around it.
  const recorded = JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'src/core/project/__fixtures__/clone-characters/placed.json'),
      'utf8',
    ),
  ) as { ref: string; project: { state: DagState } };
  const state = recorded.project.state;
  const sceneAround = new Set(Object.keys(buildDefaultProject().state.nodes));
  const imported = Object.keys(state.nodes).filter((id) => !sceneAround.has(id));

  it('selects every node of the import and nothing else', () => {
    // The recording holds both: 9 nodes of the default scene and 11 of the import.
    expect(Object.keys(state.nodes).filter((id) => sceneAround.has(id)).length).toBe(9);
    expect(imported.length).toBe(11);
    const group = importGroupNodeIds(recorded.ref, state);
    expect([...group].sort()).toEqual([...imported].sort());
    expect(new Set(group.map((id) => state.nodes[id].type))).toEqual(
      new Set([
        'GltfAsset',
        'GltfSkeleton',
        'GltfData',
        'Object',
        'Group',
        'TransformClip',
        'ClipSelect',
      ]),
    );
  });

  it('never includes the shared Scene anchor', () => {
    const scene = Object.values(state.nodes).find((n) => n.type === 'Scene')!.id;
    expect(importGroupNodeIds(recorded.ref, state)).not.toContain(scene);
  });

  it('returns [] for an assetRef with no nodes in the state', () => {
    expect(importGroupNodeIds('asset/other.glb', state)).toEqual([]);
  });
});
