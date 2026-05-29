// glTF skin-metadata capture unit tests — Phase 7.11 Wave A (issue #100).
//
// Pins the D-04 capture contract:
//   - Import determinism (V22): same file → byte-identical `skins` metadata.
//   - Parallel-length discipline: jointKeys == bindTRS == parentJointIndex ==
//     inverseBindMatrices (when present) == skin.joints.length. This is the
//     #1 bug-site guard (joint-index vs node-index conflation — RESEARCH #3).
//   - Matrix-form bind transform (FLAG 1): a node whose local transform is a
//     single 4×4 `matrix` decomposes to the SAME TRS the equivalent T/R/S-form
//     node would. The committed fixtures are TRS-only, so without this synthetic
//     assertion the matrix-decompose path is untested and silently false-passes.
//
// REF: PLAN.md Wave A (A2/A4); RESEARCH.md §B1 (three.js skin parsing);
// CONTEXT D-04.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { buildGltfImportOps, buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { parseGltfContainer, resolveBuffers, type GltfJson } from './glb';
import type { Op } from '../dag/types';
import type { DagState } from '../dag/state';
import { GltfAssetParams } from '../../nodes/GltfAsset';
import { SkeletonNode, SkeletonParams } from '../../nodes/Skeleton';

const MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Loads a committed fixture as an ArrayBuffer (vitest runs from repo root). */
function fixtureBuffer(name: string): ArrayBuffer {
  const node = readFileSync(resolve(process.cwd(), `public/assets/${name}`));
  return node.buffer.slice(node.byteOffset, node.byteOffset + node.byteLength) as ArrayBuffer;
}

function pad4(bytes: Uint8Array, padByte = 0): Uint8Array {
  if (bytes.length % 4 === 0) return bytes;
  const out = new Uint8Array(bytes.length + (4 - (bytes.length % 4)));
  out.set(bytes);
  if (padByte !== 0) out.fill(padByte, bytes.length);
  return out;
}

function makeGlb(json: GltfJson, binBytes?: Uint8Array): ArrayBuffer {
  const jsonBytes = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const bin = binBytes ? pad4(binBytes) : null;
  const totalLength = 12 + 8 + jsonBytes.length + (bin ? 8 + bin.length : 0);
  const buf = new ArrayBuffer(totalLength);
  const v = new DataView(buf);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, totalLength, true);
  let cursor = 12;
  v.setUint32(cursor, jsonBytes.length, true);
  v.setUint32(cursor + 4, CHUNK_JSON, true);
  new Uint8Array(buf, cursor + 8, jsonBytes.length).set(jsonBytes);
  cursor += 8 + jsonBytes.length;
  if (bin) {
    v.setUint32(cursor, bin.length, true);
    v.setUint32(cursor + 4, CHUNK_BIN, true);
    new Uint8Array(buf, cursor + 8, bin.length).set(bin);
  }
  return buf;
}

/** Minimal DagState shape — buildGltfImportOps only reads `_state` for
 *  signature stability post-P7.10 (no TimeSource discovery anymore). */
function emptyState(): DagState {
  return {
    nodes: { n_scene: { id: 'n_scene', type: 'Scene', version: 1, params: {}, inputs: {} } },
    outputs: {},
  } as unknown as DagState;
}

/** Parse a committed fixture and resolve its buffers (sync — embedded BIN). */
async function parsed(name: string): Promise<{ json: GltfJson; buffers: Uint8Array[] }> {
  const { json, bin } = parseGltfContainer(fixtureBuffer(name));
  const buffers = await resolveBuffers(json, bin);
  return { json, buffers };
}

describe('buildSkinMetadata — capture (P7.11 A2)', () => {
  it('skinned-bar.glb: jointKeys follow skin.joints[] order, not node order', async () => {
    const { json, buffers } = await parsed('skinned-bar.glb');
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'assets/skinned-bar.glb');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    // skins[0].joints = [1, 0] → node1 ("Bone0"), node0 ("Bone1").
    expect(skins).toHaveLength(1);
    expect(skins[0].jointKeys).toEqual(['Bone0', 'Bone1']);
  });

  it('skinned-bar.glb: parentJointIndex resolves in joints space', async () => {
    const { json, buffers } = await parsed('skinned-bar.glb');
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'assets/skinned-bar.glb');
    const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    // Bone0 (node1) is the root joint → -1. Bone1 (node0) is Bone0's child →
    // Bone0's joints-list position 0.
    expect(skin.parentJointIndex).toEqual([-1, 0]);
  });

  it('skinned-bar.glb: IBM sliced by joint-list position; non-identity 2nd joint', async () => {
    const { json, buffers } = await parsed('skinned-bar.glb');
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'assets/skinned-bar.glb');
    const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    expect(skin.inverseBindMatrices).toHaveLength(2);
    // Each entry is a full MAT4 (16 floats), column-major.
    expect(skin.inverseBindMatrices[0]).toHaveLength(16);
    // The 2nd joint's IBM carries a -1 translation row (fixture anchor value,
    // RESEARCH B2) — element 13 is the column-major translation Y.
    expect(skin.inverseBindMatrices[1][13]).toBeCloseTo(-1, 5);
  });

  it('many-bone-rig.glb: 64 joints, fully reversed node order, parallel arrays', async () => {
    const { json, buffers } = await parsed('many-bone-rig.glb');
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(
      json,
      'assets/many-bone-rig.glb',
    );
    const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    // joints = [63, 62, ..., 0] → jointKeys[i] is keyByGltfNodeIndex[63 - i].
    expect(skin.jointKeys).toHaveLength(64);
    expect(skin.jointKeys[0]).toBe(keyByGltfNodeIndex[63]);
    expect(skin.jointKeys[63]).toBe(keyByGltfNodeIndex[0]);
  });

  it('parallel-length invariant holds on both fixtures (the #1 bug-site guard)', async () => {
    for (const name of ['skinned-bar.glb', 'many-bone-rig.glb']) {
      const { json, buffers } = await parsed(name);
      const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, `assets/${name}`);
      const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
      const n = json.skins![0].joints.length;
      expect(skin.jointKeys).toHaveLength(n);
      expect(skin.bindTRS).toHaveLength(n);
      expect(skin.parentJointIndex).toHaveLength(n);
      // IBMs present on both fixtures → parallel-length too.
      expect(skin.inverseBindMatrices).toHaveLength(n);
    }
  });

  it('skin without inverseBindMatrices → inverseBindMatrices is []', async () => {
    // Synthetic: a 2-joint skin that declares no IBM accessor.
    const json: GltfJson = {
      nodes: [
        { name: 'Root', children: [1] },
        { name: 'Tip', translation: [0, 1, 0] },
      ],
      skins: [{ joints: [0, 1] }], // no inverseBindMatrices field
    };
    const buf = makeGlb(json);
    const { json: pj, buffers } = (() => {
      const { json: j, bin } = parseGltfContainer(buf);
      return { json: j, buffers: bin.byteLength > 0 ? [bin] : [] };
    })();
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(pj, 'assets/no-ibm.glb');
    const [skin] = buildSkinMetadata(pj, buffers, keyByGltfNodeIndex, childHierarchy);
    expect(skin.inverseBindMatrices).toEqual([]);
    // Other per-joint arrays remain parallel even when IBMs are absent.
    expect(skin.jointKeys).toHaveLength(2);
    expect(skin.bindTRS).toHaveLength(2);
    expect(skin.parentJointIndex).toEqual([-1, 0]);
  });
});

describe('defaultTRS — matrix-form decomposition (P7.11 FLAG 1)', () => {
  it('a matrix-form node decomposes to the same TRS as the equivalent T/R/S node', async () => {
    // Author a known TRS, bake it into a column-major Matrix4, and emit two
    // sibling joints in one skin: one in T/R/S form, one in matrix form.
    const position = new Vector3(1, 2, 3);
    const euler = new Euler(0.3, -0.5, 0.7, 'XYZ');
    const quat = new Quaternion().setFromEuler(euler);
    const scale = new Vector3(2, 0.5, 1.5);
    const m = new Matrix4().compose(position, quat, scale);
    const matrixColumnMajor = m.toArray(); // column-major (matches glTF)

    const json: GltfJson = {
      nodes: [
        // joint 0 — T/R/S form
        {
          name: 'TrsForm',
          translation: [position.x, position.y, position.z],
          rotation: [quat.x, quat.y, quat.z, quat.w],
          scale: [scale.x, scale.y, scale.z],
        },
        // joint 1 — matrix form (same transform)
        { name: 'MatrixForm', matrix: matrixColumnMajor },
      ],
      skins: [{ joints: [0, 1] }],
    };
    const buf = makeGlb(json);
    const { json: pj } = parseGltfContainer(buf);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(pj, 'assets/matrix-form.glb');
    const [skin] = buildSkinMetadata(pj, [], keyByGltfNodeIndex, childHierarchy);

    const trs = skin.bindTRS[0];
    const mat = skin.bindTRS[1];
    for (let i = 0; i < 3; i++) {
      expect(mat.position[i]).toBeCloseTo(trs.position[i], 4);
      expect(mat.rotation[i]).toBeCloseTo(trs.rotation[i], 3);
      expect(mat.scale[i]).toBeCloseTo(trs.scale[i], 4);
    }
  });
});

describe('buildGltfImportOps — skins emitted on the GltfAsset op (P7.11 A3/A4)', () => {
  function gltfAssetOp(ops: Op[]) {
    const op = ops.find((o) => o.type === 'addNode' && o.nodeType === 'GltfAsset');
    if (!op || op.type !== 'addNode') throw new Error('no GltfAsset addNode op');
    return op.params as {
      skins: Array<{
        jointKeys: string[];
        bindTRS: unknown[];
        parentJointIndex: number[];
        inverseBindMatrices: number[][];
      }>;
    };
  }

  it('V22 determinism: skins metadata deep-equal across two import runs', async () => {
    const a = await buildGltfImportOps(
      {
        buffer: fixtureBuffer('skinned-bar.glb'),
        assetRef: 'assets/skinned-bar.glb',
        sceneNodeId: 'n_scene',
      },
      emptyState(),
    );
    const b = await buildGltfImportOps(
      {
        buffer: fixtureBuffer('skinned-bar.glb'),
        assetRef: 'assets/skinned-bar.glb',
        sceneNodeId: 'n_scene',
      },
      emptyState(),
    );
    const skinsA = gltfAssetOp(a.ops).skins;
    const skinsB = gltfAssetOp(b.ops).skins;
    expect(JSON.stringify(skinsA)).toBe(JSON.stringify(skinsB));
  });

  it('parallel-length on the emitted op: jointKeys == bindTRS == parentJointIndex == IBM', async () => {
    const result = await buildGltfImportOps(
      {
        buffer: fixtureBuffer('skinned-bar.glb'),
        assetRef: 'assets/skinned-bar.glb',
        sceneNodeId: 'n_scene',
      },
      emptyState(),
    );
    const [skin] = gltfAssetOp(result.ops).skins;
    const n = skin.jointKeys.length;
    expect(n).toBe(2);
    expect(skin.bindTRS).toHaveLength(n);
    expect(skin.parentJointIndex).toHaveLength(n);
    expect(skin.inverseBindMatrices).toHaveLength(n);
  });
});

// Phase 7.11 Wave F (F4): the D-03/D-04 additive fields must not break
// pre-7.11 saves or BVH/FBX-emitted Skeleton nodes. The fields are all
// `.optional()` / `.default([])`, so a legacy param object lacking them
// hydrates to the legacy shape and a legacy bone evaluates byte-identical.
describe('back-compat — additive fields are non-breaking (P7.11 F4 / D-03)', () => {
  it('a pre-7.11 GltfAsset param object lacking `skins` hydrates to []', () => {
    // The shape a project saved BEFORE 7.11 carries: no `skins` key at all.
    const legacy = GltfAssetParams.parse({
      assetRef: 'assets/legacy.glb',
      nodeNameMap: {},
      childHierarchy: {},
    });
    expect(legacy.skins).toEqual([]);
  });

  it('the 3-bone default Skeleton evaluates with NO scale/IBM keys (BVH/FBX parity)', () => {
    const params = SkeletonParams.parse({}); // legacy = no scale/IBM authored
    const out = SkeletonNode.evaluate(params, {});
    expect(out.bones).toHaveLength(3);
    for (const b of out.bones) {
      // The optional fields must be ABSENT (not `undefined`) so a legacy
      // Skeleton value is byte-identical to its pre-7.11 self.
      expect('scale' in b).toBe(false);
      expect('inverseBindMatrix' in b).toBe(false);
    }
  });

  it('a Skeleton WITH scale/IBM carries them through (the glTF-projected path)', () => {
    const params = SkeletonParams.parse({
      bones: [
        {
          name: 'j',
          parent: -1,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [2, 2, 2],
          inverseBindMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
      ],
    });
    const out = SkeletonNode.evaluate(params, {});
    expect(out.bones[0].scale).toEqual([2, 2, 2]);
    expect(out.bones[0].inverseBindMatrix).toHaveLength(16);
  });
});
