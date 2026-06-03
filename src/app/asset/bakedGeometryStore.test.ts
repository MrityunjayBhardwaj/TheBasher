import { BoxGeometry } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../../core/storage/MemoryStorage';
import {
  bakedGeometryKey,
  bakedGeometryPath,
  deserializeGeometry,
  readBakedGeometry,
  serializeGeometry,
  writeBakedGeometry,
} from './bakedGeometryStore';

// A unit box is indexed with position/normal/uv — exercises every attribute slot.
const makeBox = () => new BoxGeometry(2, 1, 1);

describe('bakedGeometryStore', () => {
  it('(a) serialize → deserialize is byte-identical (vertex count + position[0..8])', () => {
    const box = makeBox();
    const srcPos = Float32Array.from(box.getAttribute('position').array as ArrayLike<number>);

    const { bytes, vertexCount } = serializeGeometry(box);
    const round = deserializeGeometry(bytes);
    const roundPos = round.getAttribute('position').array as Float32Array;

    expect(vertexCount).toBe(srcPos.length / 3);
    expect(round.getAttribute('position').count).toBe(box.getAttribute('position').count);
    // Byte-identical position data — every component, not just a sample.
    expect(Array.from(roundPos)).toEqual(Array.from(srcPos));
    // The named first-9 components (observation per plan verify).
    for (let i = 0; i < 9; i++) {
      expect(roundPos[i]).toBe(srcPos[i]);
    }
    // Normal + uv + index survive too.
    expect(round.getAttribute('normal')).not.toBeUndefined();
    expect(round.getAttribute('uv')).not.toBeUndefined();
    expect(round.getIndex()).not.toBeNull();
    expect((round.getIndex()!.array as Uint32Array).length).toBe(
      (box.getIndex()!.array as ArrayLike<number>).length,
    );
  });

  it('(b) the same geometry serialized twice → identical hash + key (SC-4 determinism)', () => {
    const a = serializeGeometry(makeBox());
    const b = serializeGeometry(makeBox());
    expect(a.hash).toBe(b.hash);
    expect(a.vertexCount).toBe(b.vertexCount);
    expect(bakedGeometryKey(a.hash, a.vertexCount)).toBe(bakedGeometryKey(b.hash, b.vertexCount));
    expect(bakedGeometryPath(a.hash, a.vertexCount)).toBe(bakedGeometryPath(b.hash, b.vertexCount));
  });

  it('(b2) different geometry → different hash (no false dedupe)', () => {
    const a = serializeGeometry(new BoxGeometry(1, 1, 1));
    const b = serializeGeometry(new BoxGeometry(2, 1, 1));
    expect(a.hash).not.toBe(b.hash);
  });

  it('(c) writeBakedGeometry twice for identical geometry → storage.write called ONCE (idempotent dedupe)', async () => {
    const storage = new MemoryStorage();
    const writeSpy = vi.spyOn(storage, 'write');

    const ref1 = await writeBakedGeometry(storage, makeBox());
    const ref2 = await writeBakedGeometry(storage, makeBox());

    expect(writeSpy).toHaveBeenCalledTimes(1); // second bake hit the read-or-skip dedupe
    expect(ref1.key).toBe(ref2.key);
    expect(ref1.kind).toBe('baked');
    expect(ref1.descriptor).toEqual(ref2.descriptor);
    // The handle carries only structure — no buffers (V29 / §48).
    expect(ref1.descriptor.kind).toBe('baked');
    if (ref1.descriptor.kind === 'baked') {
      expect(typeof ref1.descriptor.hash).toBe('string');
      expect(ref1.descriptor.vertexCount).toBeGreaterThan(0);
    }
  });

  it('round-trips through OPFS (write → read) preserving vertex count', async () => {
    const storage = new MemoryStorage();
    const box = makeBox();
    const ref = await writeBakedGeometry(storage, box);
    if (ref.descriptor.kind !== 'baked') throw new Error('expected baked descriptor');

    const loaded = await readBakedGeometry(
      storage,
      ref.descriptor.hash,
      ref.descriptor.vertexCount,
    );
    expect(loaded.getAttribute('position').count).toBe(box.getAttribute('position').count);
    expect(ref.descriptor.vertexCount).toBe(box.getAttribute('position').count);
  });
});
