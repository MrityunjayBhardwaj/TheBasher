// gltfImportChain unit tests — Wave D2 + D3.
//
// Synthetic in-memory GLBs (parser/encoder shared with glb.test.ts).
// Pin the determinism + ordering + degenerate-path contracts plus the
// B3 CHECKPOINT rad→deg conversion at the emit site.
//
// REF: PLAN.md Wave D; SECTION-INVENTORY.md B3.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Quaternion } from 'three';
import { quaternionToEulerVec3 } from './threeAdapter';
import { radVec3ToDeg } from '../../viewport/rotation';
import { buildGltfImportOps, buildNodeNameMap, importGroupNodeIds } from './gltfImportChain';
import type { Op } from '../dag/types';
import type { DagState } from '../dag/state';
import type { GltfJson } from './glb';

/** Loads the committed skinned-bar.glb fixture as an ArrayBuffer (P7.7 #91).
 *  vitest runs from the repo root, so resolve against process.cwd(). */
function skinnedBarBuffer(): ArrayBuffer {
  const node = readFileSync(resolve(process.cwd(), 'public/assets/skinned-bar.glb'));
  return node.buffer.slice(node.byteOffset, node.byteOffset + node.byteLength) as ArrayBuffer;
}

const MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

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

function f32Bytes(values: number[]): Uint8Array {
  const arr = new Float32Array(values);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(len);
  let cursor = 0;
  for (const c of chunks) {
    out.set(c, cursor);
    cursor += c.length;
  }
  return out;
}

/** Minimal DagState shape — only the TimeSource discovery cares. */
function stateWithTimeSource(timeId = 'n_time'): DagState {
  return {
    nodes: {
      [timeId]: { id: timeId, type: 'TimeSource', version: 1, params: {}, inputs: {} },
      n_scene: { id: 'n_scene', type: 'Scene', version: 1, params: {}, inputs: {} },
    },
    outputs: {},
  } as unknown as DagState;
}

function singleTranslationClipGlb(): ArrayBuffer {
  // One Cube node; one animation "bob" that translates Y over t in [0,1].
  const timesBytes = f32Bytes([0, 1]);
  const valuesBytes = f32Bytes([0, 0, 0, 0, 1, 0]); // pos[0]=(0,0,0), pos[1]=(0,1,0)
  const bin = concatBytes(timesBytes, valuesBytes);
  const json: GltfJson = {
    nodes: [{ name: 'Cube' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: timesBytes.length },
      { buffer: 0, byteOffset: timesBytes.length, byteLength: valuesBytes.length },
    ],
    buffers: [{ byteLength: bin.length }],
    animations: [
      {
        name: 'bob',
        channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
        samplers: [{ input: 0, output: 1 }],
      },
    ],
  };
  return makeGlb(json, bin);
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

describe('buildGltfImportOps', () => {
  it('emits 1 TransformClip + 1 ClipSelect + the static chain in locked order', async () => {
    const buf = singleTranslationClipGlb();
    const result = await buildGltfImportOps(
      { buffer: buf, assetRef: 'asset/cube.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    expect(result.transformClipIds).toHaveLength(1);
    expect(result.clipSelectId).not.toBeNull();
    expect(result.nodeNameMap.Cube).toBeDefined();
    // Op order (P7.7 #91 — one GltfChild addNode per scene child is now
    // emitted right after the GltfAsset addNode, before Transform):
    // GltfAsset, GltfChild×N (here 1: 'Cube'), Transform, connect(gltf→tx),
    // Group, connect(tx→grp), connect(grp→scene), TransformClip[0],
    // ClipSelect, connect(clip[0]→sel), connect(sel→gltf.transformClip).
    //
    // P7.10 (#114): the connect(time→clip[0]) wire is GONE. TransformClip's
    // value carries `.sample(seconds)` and time enters at the consumer
    // (GltfAssetR's useFrame), so the importer no longer wires a TimeSource
    // edge. One fewer Op per animation; total = 11 (was 12 with 1 clip).
    const types = result.ops.map((o: Op) => o.type);
    expect(types).toEqual([
      'addNode', // GltfAsset
      'addNode', // GltfChild (Cube)
      'addNode', // Transform
      'connect',
      'addNode', // Group
      'connect',
      'connect',
      'addNode', // TransformClip[0]
      'addNode', // ClipSelect
      'connect', // clip[0] → ClipSelect.clips
      'connect', // ClipSelect.out → GltfAsset.transformClip
    ]);
    // The first GltfChild addNode sits at index 1 (between GltfAsset and Transform).
    const gcOp = result.ops[1];
    expect(gcOp.type).toBe('addNode');
    if (gcOp.type === 'addNode') {
      expect(gcOp.nodeType).toBe('GltfChild');
      expect(gcOp.nodeId).toBe(result.nodeNameMap.Cube);
    }
    const tcOp = result.ops[7];
    expect(tcOp.type).toBe('addNode');
    if (tcOp.type === 'addNode') expect(tcOp.nodeType).toBe('TransformClip');
  });

  it('determinism: same buffer → byte-identical Op[]', async () => {
    const buf = singleTranslationClipGlb();
    const a = await buildGltfImportOps(
      { buffer: buf, assetRef: 'asset/cube.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    const b = await buildGltfImportOps(
      { buffer: buf, assetRef: 'asset/cube.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    expect(JSON.stringify(a.ops)).toBe(JSON.stringify(b.ops));
  });

  it('multi-clip GLB: N TransformClips + ClipSelect picks animations[0]', async () => {
    const timesBytes = f32Bytes([0, 1]);
    const valuesBytes = f32Bytes([0, 0, 0, 0, 1, 0]);
    const bin = concatBytes(timesBytes, valuesBytes);
    const json: GltfJson = {
      nodes: [{ name: 'Cube' }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' },
        { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: timesBytes.length },
        { buffer: 0, byteOffset: timesBytes.length, byteLength: valuesBytes.length },
      ],
      buffers: [{ byteLength: bin.length }],
      animations: [
        {
          name: 'walk',
          channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
          samplers: [{ input: 0, output: 1 }],
        },
        {
          name: 'run',
          channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
          samplers: [{ input: 0, output: 1 }],
        },
        {
          name: 'idle',
          channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
          samplers: [{ input: 0, output: 1 }],
        },
      ],
    };
    const buf = makeGlb(json, bin);
    const result = await buildGltfImportOps(
      { buffer: buf, assetRef: 'asset/multi.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    expect(result.transformClipIds).toHaveLength(3);
    expect(result.clipSelectId).not.toBeNull();
    const selectOp = result.ops.find(
      (o: Op) => o.type === 'addNode' && o.nodeType === 'ClipSelect',
    );
    expect(selectOp).toBeDefined();
    if (selectOp?.type === 'addNode') {
      expect((selectOp.params as { selectedClipName: string }).selectedClipName).toBe('walk');
    }
    // ClipSelect connect indices preserve animations[] order.
    const clipConnects = result.ops.filter(
      (o: Op) =>
        o.type === 'connect' && o.to.node === result.clipSelectId && o.to.socket === 'clips',
    );
    expect(clipConnects).toHaveLength(3);
    clipConnects.forEach((op, i) => {
      if (op.type === 'connect') expect(op.index).toBe(i);
    });
  });

  it('no-animations GLB: degenerate path emits static chain only', async () => {
    const json: GltfJson = { nodes: [{ name: 'Cube' }] };
    const buf = makeGlb(json);
    const result = await buildGltfImportOps(
      { buffer: buf, assetRef: 'asset/static.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    expect(result.transformClipIds).toHaveLength(0);
    expect(result.clipSelectId).toBeNull();
    expect(
      result.ops.find((o: Op) => o.type === 'addNode' && o.nodeType === 'TransformClip'),
    ).toBeUndefined();
    expect(
      result.ops.find((o: Op) => o.type === 'addNode' && o.nodeType === 'ClipSelect'),
    ).toBeUndefined();
  });

  it('B3 CHECKPOINT — rotation quat [0,0,sin(π/4),cos(π/4)] emits ≈ [0,0,90] degrees', async () => {
    const times = f32Bytes([0, 1]);
    const rotValues = f32Bytes([
      // t=0: identity quat
      0,
      0,
      0,
      1,
      // t=1: 90deg about Z
      0,
      0,
      Math.sin(Math.PI / 4),
      Math.cos(Math.PI / 4),
    ]);
    const bin = concatBytes(times, rotValues);
    const json: GltfJson = {
      nodes: [{ name: 'Cube' }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' },
        { bufferView: 1, componentType: 5126, count: 2, type: 'VEC4' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: times.length },
        { buffer: 0, byteOffset: times.length, byteLength: rotValues.length },
      ],
      buffers: [{ byteLength: bin.length }],
      animations: [
        {
          name: 'spin',
          channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }],
          samplers: [{ input: 0, output: 1 }],
        },
      ],
    };
    const buf = makeGlb(json, bin);
    const result = await buildGltfImportOps(
      { buffer: buf, assetRef: 'asset/spin.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    const tcOp = result.ops.find((o: Op) => o.type === 'addNode' && o.nodeType === 'TransformClip');
    if (tcOp?.type !== 'addNode') throw new Error('expected TransformClip addNode');
    const kf = (
      tcOp.params as { keyframes: Array<{ time: number; rotation: [number, number, number] }> }
    ).keyframes;
    const last = kf.find((k) => k.time === 1)!;
    // 90deg about Z — sanity-cross-check via the same helper.
    const expected = radVec3ToDeg(
      quaternionToEulerVec3(new Quaternion(0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4))),
    );
    expect(last.rotation[2]).toBeCloseTo(expected[2], 4);
    expect(last.rotation[2]).toBeCloseTo(90, 1);
    // Negative assertion: NOT radians (π/2 ≈ 1.5708).
    expect(Math.abs(last.rotation[2])).toBeGreaterThan(10);
  });

  it('sanitises bracket-character node names into the keyframe targetNodeId', async () => {
    const times = f32Bytes([0, 1]);
    const values = f32Bytes([0, 0, 0, 0, 1, 0]);
    const bin = concatBytes(times, values);
    const json: GltfJson = {
      nodes: [{ name: 'Cube[0]' }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' },
        { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: times.length },
        { buffer: 0, byteOffset: times.length, byteLength: values.length },
      ],
      buffers: [{ byteLength: bin.length }],
      animations: [
        {
          name: 'a',
          channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
          samplers: [{ input: 0, output: 1 }],
        },
      ],
    };
    const buf = makeGlb(json, bin);
    const result = await buildGltfImportOps(
      { buffer: buf, assetRef: 'asset/bracket.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    const tcOp = result.ops.find((o: Op) => o.type === 'addNode' && o.nodeType === 'TransformClip');
    if (tcOp?.type !== 'addNode') throw new Error('expected TransformClip addNode');
    const kf = (tcOp.params as { keyframes: Array<{ targetNodeId: string }> }).keyframes;
    expect(kf[0].targetNodeId).not.toMatch(/[[\].:/]/);
  });

  // P7.10 (#114) — the OLD invariant ("a TimeSource MUST exist in the DAG
  // before importing an animated glTF") is GONE. TransformClip no longer
  // declares a `time` input, so the importer no longer connects to
  // TimeSource. An empty DAG state is now a valid input for animated
  // imports. This test inverts the old assertion: it must NOT throw, and
  // the resulting Op stream must NOT mention TimeSource.
  it('succeeds when DAG has no TimeSource (P7.10: TransformClip drops Time input)', async () => {
    const buf = singleTranslationClipGlb();
    const state: DagState = { nodes: {}, outputs: {} } as unknown as DagState;
    const result = await buildGltfImportOps(
      { buffer: buf, assetRef: 'asset/x.glb', sceneNodeId: 'n_scene' },
      state,
    );
    expect(result.transformClipIds.length).toBeGreaterThan(0);
    // No emitted Op references TimeSource as either an addNode type or a connect source.
    for (const op of result.ops) {
      if (op.type === 'addNode') expect(op.nodeType).not.toBe('TimeSource');
      if (op.type === 'connect') {
        // No connect should reference a `time` input socket on a consumer
        // (TransformClip is the only node that used to have one in this chain).
        expect(op.to.socket).not.toBe('time');
      }
    }
  });

  it('JSON-only .gltf with a data-URI buffer → TransformClip (#90 container + buffer path)', async () => {
    // The .gltf container path: plain JSON (no GLB magic), buffer bytes
    // inline as a base64 data-URI. One node 'Cube', one "bob" clip moving
    // Y 0→1. Proves parseGltfContainer + resolveBuffers + readAccessor
    // compose end-to-end through the importer with no embedded BIN.
    const timesBytes = f32Bytes([0, 1]);
    const valuesBytes = f32Bytes([0, 0, 0, 0, 1, 0]);
    const bin = concatBytes(timesBytes, valuesBytes);
    const b64 = btoa(String.fromCharCode(...bin));
    const json: GltfJson = {
      nodes: [{ name: 'Cube' }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' },
        { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: timesBytes.length },
        { buffer: 0, byteOffset: timesBytes.length, byteLength: valuesBytes.length },
      ],
      buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${b64}` }],
      animations: [
        {
          name: 'bob',
          channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
          samplers: [{ input: 0, output: 1 }],
        },
      ],
    };
    const buffer = new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;
    const result = await buildGltfImportOps(
      { buffer, assetRef: 'asset/cube.gltf', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    expect(result.transformClipIds).toHaveLength(1);
    const tcOp = result.ops.find((o: Op) => o.type === 'addNode' && o.nodeType === 'TransformClip');
    if (tcOp?.type !== 'addNode') throw new Error('expected TransformClip addNode');
    const kf = (
      tcOp.params as { keyframes: Array<{ time: number; position: [number, number, number] }> }
    ).keyframes;
    expect(kf.find((k) => k.time === 1)!.position[1]).toBeCloseTo(1, 6);
  });

  it('routes an external buffer through the injected resolveBuffer (#90)', async () => {
    // .gltf referencing a sibling .bin; resolver supplies the bytes.
    const timesBytes = f32Bytes([0, 1]);
    const valuesBytes = f32Bytes([0, 0, 0, 0, 2, 0]);
    const bin = concatBytes(timesBytes, valuesBytes);
    const json: GltfJson = {
      nodes: [{ name: 'Cube' }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' },
        { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: timesBytes.length },
        { buffer: 0, byteOffset: timesBytes.length, byteLength: valuesBytes.length },
      ],
      buffers: [{ byteLength: bin.length, uri: 'cube.bin' }],
      animations: [
        {
          name: 'bob',
          channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
          samplers: [{ input: 0, output: 1 }],
        },
      ],
    };
    const buffer = new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;
    let requested = '';
    const result = await buildGltfImportOps(
      {
        buffer,
        assetRef: 'asset/cube.gltf',
        sceneNodeId: 'n_scene',
        resolveBuffer: async (uri) => {
          requested = uri;
          return bin;
        },
      },
      stateWithTimeSource(),
    );
    expect(requested).toBe('cube.bin');
    const tcOp = result.ops.find((o: Op) => o.type === 'addNode' && o.nodeType === 'TransformClip');
    if (tcOp?.type !== 'addNode') throw new Error('expected TransformClip addNode');
    const kf = (
      tcOp.params as { keyframes: Array<{ time: number; position: [number, number, number] }> }
    ).keyframes;
    expect(kf.find((k) => k.time === 1)!.position[1]).toBeCloseTo(2, 6);
  });
});

// P7.7 (#91) Wave A2 — one GltfChild addNode per scene child, deterministic.
describe('buildGltfImportOps — GltfChild emission (#91 A2)', () => {
  it('emits exactly one GltfChild addNode per json.nodes entry, index-ordered', async () => {
    // Two distinct nodes, no animations (degenerate static path).
    const json: GltfJson = { nodes: [{ name: 'Root' }, { name: 'Leaf' }] };
    const buf = makeGlb(json);
    const result = await buildGltfImportOps(
      { buffer: buf, assetRef: 'asset/two.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    const childOps = result.ops.filter(
      (o: Op) => o.type === 'addNode' && o.nodeType === 'GltfChild',
    );
    expect(childOps).toHaveLength(2);
    // Index order: childName Root (index 0) then Leaf (index 1).
    if (childOps[0].type === 'addNode' && childOps[1].type === 'addNode') {
      expect((childOps[0].params as { childName: string }).childName).toBe('Root');
      expect((childOps[1].params as { childName: string }).childName).toBe('Leaf');
    }
  });

  it('GltfChild ids equal hashId(gltfChild, assetRef, key) — the nodeNameMap id', async () => {
    const json: GltfJson = { nodes: [{ name: 'Root' }, { name: 'Leaf' }] };
    const buf = makeGlb(json);
    const result = await buildGltfImportOps(
      { buffer: buf, assetRef: 'asset/two.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    const childOps = result.ops.filter(
      (o: Op) => o.type === 'addNode' && o.nodeType === 'GltfChild',
    );
    for (const op of childOps) {
      if (op.type !== 'addNode') continue;
      const key = (op.params as { childName: string }).childName;
      // The emission MUST reuse the renderer's lookup id (the deduped key's
      // hashId), not the raw name — otherwise the rendered name lookup misses.
      expect(op.nodeId).toBe(result.nodeNameMap[key]);
    }
  });

  it('seeds the child base TRS + overridden all-false', async () => {
    const json: GltfJson = {
      nodes: [{ name: 'Mover', translation: [1, 2, 3], scale: [2, 2, 2] }],
    };
    const buf = makeGlb(json);
    const result = await buildGltfImportOps(
      { buffer: buf, assetRef: 'asset/m.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    const childOp = result.ops.find((o: Op) => o.type === 'addNode' && o.nodeType === 'GltfChild');
    if (childOp?.type !== 'addNode') throw new Error('expected GltfChild addNode');
    const p = childOp.params as {
      position: number[];
      scale: number[];
      overridden: { position: boolean; rotation: boolean; scale: boolean };
    };
    expect(p.position).toEqual([1, 2, 3]);
    expect(p.scale).toEqual([2, 2, 2]);
    expect(p.overridden).toEqual({ position: false, rotation: false, scale: false });
  });

  it('GltfChild addNodes precede the TransformClip block in the atomic chain', async () => {
    const buf = singleTranslationClipGlb();
    const result = await buildGltfImportOps(
      { buffer: buf, assetRef: 'asset/cube.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    const firstChild = result.ops.findIndex(
      (o: Op) => o.type === 'addNode' && o.nodeType === 'GltfChild',
    );
    const firstClip = result.ops.findIndex(
      (o: Op) => o.type === 'addNode' && o.nodeType === 'TransformClip',
    );
    expect(firstChild).toBeGreaterThanOrEqual(0);
    expect(firstClip).toBeGreaterThan(firstChild);
  });

  it('skinned-bar.glb fixture: one GltfChild per scene child (3 nodes)', async () => {
    const buf = skinnedBarBuffer();
    const result = await buildGltfImportOps(
      { buffer: buf, assetRef: 'assets/skinned-bar.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    const childOps = result.ops.filter(
      (o: Op) => o.type === 'addNode' && o.nodeType === 'GltfChild',
    );
    // skinned-bar.glb has 3 json.nodes: Bone1, Bone0, SkinnedBar.
    expect(childOps).toHaveLength(3);
    const names = childOps.map((o) =>
      o.type === 'addNode' ? (o.params as { childName: string }).childName : '',
    );
    expect(names).toEqual(['Bone1', 'Bone0', 'SkinnedBar']);
  });

  it('V22 determinism: skinned-bar.glb → byte-identical Op[] across two runs', async () => {
    const buf = skinnedBarBuffer();
    const a = await buildGltfImportOps(
      { buffer: buf, assetRef: 'assets/skinned-bar.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    const b = await buildGltfImportOps(
      { buffer: skinnedBarBuffer(), assetRef: 'assets/skinned-bar.glb', sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    // The whole ops array — including the GltfChild addNodes — must be
    // byte-identical. This is the V22 gate: deterministic ids + locked order.
    expect(JSON.stringify(a.ops)).toBe(JSON.stringify(b.ops));
  });
});

describe('importGroupNodeIds (#127 — break-refs GC footprint)', () => {
  // Build a DagState containing every node `buildGltfImportOps` emits for an
  // animated single-child glTF, plus the shared Scene and an unrelated
  // user-created Transform. importGroupNodeIds must select EXACTLY the import
  // footprint — never the Scene anchor, never the user node.
  async function importedState(assetRef: string): Promise<{
    state: DagState;
    emitted: string[];
  }> {
    const result = await buildGltfImportOps(
      { buffer: singleTranslationClipGlb(), assetRef, sceneNodeId: 'n_scene' },
      stateWithTimeSource(),
    );
    const nodes: DagState['nodes'] = {
      n_scene: { id: 'n_scene', type: 'Scene', version: 1, params: {}, inputs: {} },
      n_user_tx: { id: 'n_user_tx', type: 'Transform', version: 1, params: {}, inputs: {} },
    };
    const emitted: string[] = [];
    for (const op of result.ops) {
      if (op.type !== 'addNode') continue;
      nodes[op.nodeId] = {
        id: op.nodeId,
        type: op.nodeType,
        version: 1,
        params: op.params,
        inputs: {},
      };
      emitted.push(op.nodeId);
    }
    return { state: { nodes, outputs: {} } as unknown as DagState, emitted };
  }

  it('selects every emitted import node (GltfAsset + GltfChild + Transform + Group + TransformClip + ClipSelect)', async () => {
    const { state, emitted } = await importedState('asset/anim.glb');
    const group = new Set(importGroupNodeIds('asset/anim.glb', state));
    for (const id of emitted) expect(group.has(id)).toBe(true);
    const types = new Set([...group].map((id) => state.nodes[id].type));
    expect(types).toEqual(
      new Set(['GltfAsset', 'GltfChild', 'Transform', 'Group', 'TransformClip', 'ClipSelect']),
    );
  });

  it('never includes the shared Scene anchor nor an unrelated user node', async () => {
    const { state } = await importedState('asset/anim.glb');
    const group = new Set(importGroupNodeIds('asset/anim.glb', state));
    expect(group.has('n_scene')).toBe(false);
    expect(group.has('n_user_tx')).toBe(false);
  });

  it('returns [] for an assetRef with no nodes in the state', async () => {
    const { state } = await importedState('asset/anim.glb');
    expect(importGroupNodeIds('asset/other.glb', state)).toEqual([]);
  });
});
