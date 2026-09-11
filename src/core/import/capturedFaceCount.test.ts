// #1023 — what a glTF child's face count is captured as, and when it refuses.
//
// The refusals matter more than the counts here. `undefined` means WE DID NOT CAPTURE IT,
// and every reader downstream must keep treating it as "cannot say" rather than as zero — a
// child of lines answering `0` faces would be a confident wrong answer that every
// face-domain consumer believes. So each refusal below is its own case.
//
// Grounded: glTF accepts TRIANGLES (4, the default when `mode` is absent), TRIANGLE_STRIP (5)
// and TRIANGLE_FAN (6), converting the last two via `toTrianglesDrawMode`, whose own
// arithmetic is `numberOfTriangles = index.count - 2` (`BufferGeometryUtils.js:801`), and
// throws on every other mode (`GLTFLoader.js:3832`).

import { describe, it, expect } from 'vitest';
import { captureChildFaceCount } from './gltfImportChain';

const acc = (...counts: number[]) => counts.map((count) => ({ count }));

describe('captureChildFaceCount', () => {
  it('counts an indexed triangle list', () => {
    // A cube: 36 indices, 12 triangles. Matches the real `public/assets/cube.gltf`.
    const json = { meshes: [{ primitives: [{ indices: 0 }] }], accessors: acc(36) };
    expect(captureChildFaceCount({ mesh: 0 }, json)).toBe(12);
  });

  it('treats an absent mode as TRIANGLES rather than as unknown', () => {
    const withMode = { meshes: [{ primitives: [{ indices: 0, mode: 4 }] }], accessors: acc(6) };
    const without = { meshes: [{ primitives: [{ indices: 0 }] }], accessors: acc(6) };
    expect(captureChildFaceCount({ mesh: 0 }, without)).toBe(
      captureChildFaceCount({ mesh: 0 }, withMode),
    );
    expect(captureChildFaceCount({ mesh: 0 }, without)).toBe(2);
  });

  it('falls back to POSITION when the primitive is not indexed', () => {
    const json = { meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: acc(9) };
    expect(captureChildFaceCount({ mesh: 0 }, json)).toBe(3);
  });

  it('uses count - 2 for a strip and a fan, not count / 3', () => {
    for (const mode of [5, 6]) {
      const json = { meshes: [{ primitives: [{ indices: 0, mode }] }], accessors: acc(8) };
      // 8 indices: a strip/fan yields 6 triangles, where a list would have refused (8 % 3).
      expect(captureChildFaceCount({ mesh: 0 }, json), `mode ${mode}`).toBe(6);
    }
  });

  it('sums across primitives — a multi-primitive child is still one child', () => {
    // The real `two-material-quad.gltf` shape: two primitives of 3 indices each.
    const json = {
      meshes: [{ primitives: [{ indices: 0 }, { indices: 1 }] }],
      accessors: acc(3, 3),
    };
    expect(captureChildFaceCount({ mesh: 0 }, json)).toBe(2);
  });

  it('mixes modes across primitives correctly', () => {
    const json = {
      meshes: [{ primitives: [{ indices: 0 }, { indices: 1, mode: 6 }] }],
      accessors: acc(6, 5),
    };
    expect(captureChildFaceCount({ mesh: 0 }, json)).toBe(2 + 3);
  });

  it('a degenerate strip contributes none without refusing the child', () => {
    const json = {
      meshes: [{ primitives: [{ indices: 0, mode: 5 }, { indices: 1 }] }],
      accessors: acc(2, 3),
    };
    // Two indices cannot make a triangle — 0, not -1, and the sibling still counts.
    expect(captureChildFaceCount({ mesh: 0 }, json)).toBe(1);
  });

  describe('refuses — and each of these must NOT come back as 0', () => {
    it('a node with no mesh (a bone, an empty)', () => {
      expect(captureChildFaceCount({}, { meshes: [], accessors: [] })).toBeUndefined();
    });

    it('a single non-triangle primitive refuses the WHOLE child', () => {
      for (const mode of [0, 1, 2, 3]) {
        const json = {
          meshes: [{ primitives: [{ indices: 0 }, { indices: 1, mode }] }],
          accessors: acc(36, 4),
        };
        // The triangle sibling is not partially counted — the child has no honest answer.
        expect(captureChildFaceCount({ mesh: 0 }, json), `mode ${mode}`).toBeUndefined();
      }
    });

    it('an index count that is not a whole number of triangles', () => {
      const json = { meshes: [{ primitives: [{ indices: 0 }] }], accessors: acc(7) };
      expect(captureChildFaceCount({ mesh: 0 }, json)).toBeUndefined();
    });

    it('a missing accessor, a missing mesh, and an empty primitive list', () => {
      expect(
        captureChildFaceCount(
          { mesh: 0 },
          { meshes: [{ primitives: [{ indices: 9 }] }], accessors: acc(3) },
        ),
      ).toBeUndefined();
      expect(captureChildFaceCount({ mesh: 7 }, { meshes: [], accessors: acc(3) })).toBeUndefined();
      expect(
        captureChildFaceCount({ mesh: 0 }, { meshes: [{ primitives: [] }], accessors: acc(3) }),
      ).toBeUndefined();
      // A primitive with neither indices nor POSITION says nothing about its size.
      expect(
        captureChildFaceCount({ mesh: 0 }, { meshes: [{ primitives: [{}] }], accessors: acc(3) }),
      ).toBeUndefined();
    });
  });
});
