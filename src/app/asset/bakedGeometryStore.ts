// Baked-geometry serialize / deserialize + content-hash + OPFS persist
// (Phase 151 Apply-Transform, Wave 1, issue #151).
//
// AUTHORITATIVE store (the NEW vyapti): unlike box/sphere geometry — which the
// geometryRegistry REBUILDS from params on demand (a derived, V1-EXEMPT cache) —
// a baked BufferGeometry is the product of `applyMatrix4` on a clone and CANNOT
// be rebuilt from the DAG. Its bytes are authoritative state. They therefore
// persist to OPFS keyed by a deterministic content hash; the DAG carries ONLY a
// `GeometryRef{kind:'baked'}` handle (§48 / V29 preserved — heavy buffers never
// inline into project.json, io.ts:60).
//
// Determinism (Q3): the hash is `hashValue` (FNV-1a + stableStringify,
// core/dag/hash.ts) over a CANONICAL record built in FIXED key order
// {position, normal, uv, index} from plain number arrays. Identical geometry →
// identical hash → identical OPFS key → ONE file (dedupe, SC-4). The OPFS key
// carries `<hash>-<vertexCount>` to blunt the 32-bit FNV collision surface.
//
// Encoding (Q2): a small binary header (magic + version + per-attribute item
// sizes + lengths) followed by the raw typed-array bytes — NOT base64-in-JSON, so
// a 100k-vertex buffer does not bloat the project JSON or pay an encode tax.
//
// The OPFS write is a side effect at Apply-dispatch time (mirrors
// `renameImportedAsset`, importCommon.ts), NEVER inside a pure evaluator.
//
// REF: PLAN.md Wave 1 Task 1; RESEARCH §Q2/§Q3; core/dag/hash.ts (hashValue);
//      StorageCapability.ts:25-32 (write/read/exists); vyapti (authoritative baked store).

import { BufferAttribute, BufferGeometry } from 'three';
import { hashValue, type ContentHash } from '../../core/dag/hash';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import type { GeometryRef } from '../../nodes/types';

/** Root OPFS directory for baked geometry blobs. */
export const BAKED_GEOMETRY_ROOT = 'baked-geometry';

const MAGIC = 0x42474d31; // 'BGM1' — baked-geometry magic, little-endian u32.
const VERSION = 1;

/**
 * The canonical, fixed-order set of attributes a baked geometry serializes. Order
 * is load-bearing for the hash (stableStringify sorts keys, but we ALSO keep the
 * binary layout fixed so deserialize reads them back in the same order).
 */
interface CanonicalAttributes {
  readonly position: Float32Array;
  readonly normal: Float32Array | null;
  readonly uv: Float32Array | null;
  readonly index: Uint32Array | null;
}

function toFloat32(attr: BufferAttribute | undefined): Float32Array | null {
  if (!attr) return null;
  // BufferAttribute.array is a typed array; normalise to a fresh Float32Array so
  // the byte layout is independent of the source's underlying buffer/offset.
  return Float32Array.from(attr.array as ArrayLike<number>);
}

function extractCanonical(geom: BufferGeometry): CanonicalAttributes {
  const position = geom.getAttribute('position') as BufferAttribute | undefined;
  if (!position) {
    throw new Error('bakedGeometryStore: geometry has no position attribute');
  }
  const index = geom.getIndex();
  return {
    position: Float32Array.from(position.array as ArrayLike<number>),
    normal: toFloat32(geom.getAttribute('normal') as BufferAttribute | undefined),
    uv: toFloat32(geom.getAttribute('uv') as BufferAttribute | undefined),
    index: index ? Uint32Array.from(index.array as ArrayLike<number>) : null,
  };
}

/**
 * Deterministic content hash of a baked geometry. Hashes the canonical record as
 * plain number arrays in FIXED key order via the project's `hashValue` (FNV-1a +
 * stableStringify). Float values are encoded by JSON.stringify identically for
 * identical inputs, so two bakes of the same geometry hash equal (SC-4).
 */
function hashCanonical(c: CanonicalAttributes): ContentHash {
  return hashValue({
    position: Array.from(c.position),
    normal: c.normal ? Array.from(c.normal) : null,
    uv: c.uv ? Array.from(c.uv) : null,
    index: c.index ? Array.from(c.index) : null,
  });
}

/** Vertex count = position component count / 3. */
function vertexCountOf(position: Float32Array): number {
  return position.length / 3;
}

export interface SerializedGeometry {
  readonly bytes: Uint8Array;
  readonly hash: string;
  readonly vertexCount: number;
}

// Header layout (all little-endian):
//   u32 magic, u32 version,
//   u32 positionLen, u32 normalLen, u32 uvLen, u32 indexLen   (element counts)
// followed by: position f32[], normal f32[], uv f32[], index u32[].
const HEADER_U32_COUNT = 6;
const HEADER_BYTES = HEADER_U32_COUNT * 4;

/**
 * Serialize a BufferGeometry to a content-hashed binary blob. Pure (no I/O).
 */
export function serializeGeometry(geom: BufferGeometry): SerializedGeometry {
  const c = extractCanonical(geom);
  const hash = hashCanonical(c);
  const vertexCount = vertexCountOf(c.position);

  const positionLen = c.position.length;
  const normalLen = c.normal ? c.normal.length : 0;
  const uvLen = c.uv ? c.uv.length : 0;
  const indexLen = c.index ? c.index.length : 0;

  const floatBytes = (positionLen + normalLen + uvLen) * 4;
  const indexBytes = indexLen * 4;
  const total = HEADER_BYTES + floatBytes + indexBytes;

  const buffer = new ArrayBuffer(total);
  const header = new Uint32Array(buffer, 0, HEADER_U32_COUNT);
  header[0] = MAGIC;
  header[1] = VERSION;
  header[2] = positionLen;
  header[3] = normalLen;
  header[4] = uvLen;
  header[5] = indexLen;

  let offset = HEADER_BYTES;
  new Float32Array(buffer, offset, positionLen).set(c.position);
  offset += positionLen * 4;
  if (c.normal) {
    new Float32Array(buffer, offset, normalLen).set(c.normal);
    offset += normalLen * 4;
  }
  if (c.uv) {
    new Float32Array(buffer, offset, uvLen).set(c.uv);
    offset += uvLen * 4;
  }
  if (c.index) {
    new Uint32Array(buffer, offset, indexLen).set(c.index);
    offset += indexLen * 4;
  }

  return { bytes: new Uint8Array(buffer), hash, vertexCount };
}

/**
 * Inverse of `serializeGeometry`: rebuild a BufferGeometry from the binary blob.
 */
export function deserializeGeometry(bytes: Uint8Array): BufferGeometry {
  // Copy into a fresh, 4-byte-aligned ArrayBuffer so the typed-array views are
  // valid regardless of the input Uint8Array's byteOffset.
  const aligned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(aligned).set(bytes);

  const header = new Uint32Array(aligned, 0, HEADER_U32_COUNT);
  if (header[0] !== MAGIC) {
    throw new Error('bakedGeometryStore: bad magic — not a baked-geometry blob');
  }
  if (header[1] !== VERSION) {
    throw new Error(`bakedGeometryStore: unsupported version ${header[1]}`);
  }
  const positionLen = header[2];
  const normalLen = header[3];
  const uvLen = header[4];
  const indexLen = header[5];

  let offset = HEADER_BYTES;
  // `slice` copies, so each attribute owns a standalone, aligned buffer.
  const position = new Float32Array(aligned, offset, positionLen).slice();
  offset += positionLen * 4;
  const normal = normalLen ? new Float32Array(aligned, offset, normalLen).slice() : null;
  offset += normalLen * 4;
  const uv = uvLen ? new Float32Array(aligned, offset, uvLen).slice() : null;
  offset += uvLen * 4;
  const index = indexLen ? new Uint32Array(aligned, offset, indexLen).slice() : null;
  offset += indexLen * 4;

  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(position, 3));
  if (normal) geom.setAttribute('normal', new BufferAttribute(normal, 3));
  if (uv) geom.setAttribute('uv', new BufferAttribute(uv, 2));
  if (index) geom.setIndex(new BufferAttribute(index, 1));
  return geom;
}

/** The OPFS file path for a baked geometry, keyed by hash + vertex count. */
export function bakedGeometryPath(hash: string, vertexCount: number): string {
  return `${BAKED_GEOMETRY_ROOT}/${hash}-${vertexCount}.bin`;
}

/** The GeometryRef cache key for a baked geometry. */
export function bakedGeometryKey(hash: string, vertexCount: number): string {
  return `baked|${hash}-${vertexCount}`;
}

/**
 * Serialize + persist a baked geometry to OPFS, returning its handle.
 *
 * Idempotent (SC-4 dedupe): if the content-hashed file already exists, the write
 * is SKIPPED — two bakes of the same geometry resolve to one OPFS file. The OPFS
 * write is the single chokepoint (V20); callers `await` it before committing the
 * DAG node that references the handle (reload-safe ordering, K15 extension).
 */
export async function writeBakedGeometry(
  storage: StorageCapability,
  geom: BufferGeometry,
): Promise<GeometryRef> {
  const { bytes, hash, vertexCount } = serializeGeometry(geom);
  const path = bakedGeometryPath(hash, vertexCount);
  // Read-or-skip dedupe: only write when absent.
  if (!(await storage.exists(path))) {
    await storage.write(path, bytes);
  }
  return {
    key: bakedGeometryKey(hash, vertexCount),
    kind: 'baked',
    descriptor: { kind: 'baked', hash, vertexCount },
  };
}

/** Read a baked geometry back from OPFS by its content hash + vertex count. */
export async function readBakedGeometry(
  storage: StorageCapability,
  hash: string,
  vertexCount: number,
): Promise<BufferGeometry> {
  const bytes = await storage.read(bakedGeometryPath(hash, vertexCount));
  return deserializeGeometry(bytes);
}
