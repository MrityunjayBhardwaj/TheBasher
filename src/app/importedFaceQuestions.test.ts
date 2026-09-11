// #1023 — what the model's face and corner questions answer for an imported child.
//
// The pairing is the point: every assertion about a CAPTURED child is made beside the same
// assertion about an UNCAPTURED one, because the whole risk of this change is that a missing
// readout starts reading as zero. `0` and `null` are both falsy and both plausible per-mesh
// integers, and a consumer that gets `0` for "we never captured it" will confidently draw
// nothing instead of refusing.

import { describe, it, expect } from 'vitest';
import type { GeometryDescriptor } from '../nodes/types';
import { faceCountOf, faceArityOf, faceCornersOf, cornerCountOf } from './faceCount';

const captured = (faceCount: number): GeometryDescriptor => ({
  kind: 'gltf',
  assetRef: 'user-imports/m/m.gltf',
  childName: 'Cube',
  faceCount,
});
const uncaptured: GeometryDescriptor = {
  kind: 'gltf',
  assetRef: 'user-imports/m/m.gltf',
  childName: 'Cube',
};

describe('an imported child that stated its face count', () => {
  it('answers the face count it captured', () => {
    expect(faceCountOf(captured(12))).toBe(12);
  });

  it('answers three corners per face, because a glTF face is a triangle', () => {
    expect(faceCornersOf(captured(12))).toEqual(new Array<number>(12).fill(3));
    expect(cornerCountOf(captured(12))).toBe(36);
  });

  it('answers one triangle per face — the fan rule, corners minus two', () => {
    expect(faceArityOf(captured(12))).toEqual(new Array<number>(12).fill(1));
  });

  it('keeps corners and arity in the agreement the rest of the model is held to', () => {
    // `cornerCount.gate.test.ts` asserts `corners[i] === arity[i] + 2` at every
    // sync-buildable descriptor. An imported one now has to satisfy it too.
    const arity = faceArityOf(captured(7)) as readonly number[];
    const corners = faceCornersOf(captured(7)) as readonly number[];
    expect(corners).toHaveLength(arity.length);
    for (let i = 0; i < arity.length; i++) expect(corners[i]).toBe(arity[i] + 2);
  });

  it('a zero-face child is a real answer and not a refusal', () => {
    // Reachable: a mesh whose only primitive is a two-index strip. It HAS no faces, which
    // is a different claim from "we do not know", and the two must not collapse.
    expect(faceCountOf(captured(0))).toBe(0);
    expect(faceCornersOf(captured(0))).toEqual([]);
    expect(cornerCountOf(captured(0))).toBe(0);
  });
});

describe('an imported child that captured nothing answers exactly as it did before', () => {
  it('refuses with null, and NEVER with zero', () => {
    expect(faceCountOf(uncaptured)).toBeNull();
    expect(faceArityOf(uncaptured)).toBeNull();
    expect(faceCornersOf(uncaptured)).toBeNull();
    expect(cornerCountOf(uncaptured)).toBeNull();
  });

  it('is distinguishable from a captured child that genuinely has no faces', () => {
    // The load-bearing pair. If these two ever agree, the distinction this change is built
    // to preserve has been lost, and every pre-#1023 save starts claiming zero faces.
    expect(faceCountOf(uncaptured)).toBeNull();
    expect(faceCountOf(captured(0))).toBe(0);
    expect(faceCountOf(uncaptured)).not.toBe(faceCountOf(captured(0)));
  });
});

describe('baked still refuses, and not from its vertexCount', () => {
  it('does not mistake a buffer vertex count for an element count', () => {
    // `baked` carries `vertexCount`, and it is the RAW buffer's — it names the OPFS blob.
    // Answering 24/3 = 8 faces from it would be arithmetic on the wrong quantity, and for
    // an indexed mesh it is not even the right input.
    const baked: GeometryDescriptor = { kind: 'baked', hash: 'h', vertexCount: 24 };
    expect(faceCountOf(baked)).toBeNull();
    expect(faceArityOf(baked)).toBeNull();
    expect(cornerCountOf(baked)).toBeNull();
  });
});
