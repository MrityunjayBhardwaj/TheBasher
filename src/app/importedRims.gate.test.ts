// importedRims.gate — an imported mesh's polygon rims, and the check that stands in for the
// alignment one it cannot have (#1025).
//
// ⚠️ #1053 — the `gltf` kind is gone, and with it every ground that recovered an imported mesh's
// rims from its buffer (2, 4, 5, 10, 11, 13c, 22): the kind they measured no longer exists. What
// stays pins the classification and that `baked`, the one buffer-only kind left, reaches none of
// the road — it states no arity to walk a buffer against.
//
// REF: src/app/builtRims.ts (`alignedSplitRims`, `topologyIsBufferOnly`);
//      src/app/uvAttributes.ts (`refusalFor`); issues #1025, #1053, #738.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { GeometryDescriptor, GeometryRef } from '../nodes/types';
import {
  bevelGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
} from './modifierGeometry';
import { alignedSplitRims, builtPolygonRims, topologyIsBufferOnly } from './builtRims';
import { faceArityOf, faceElementStarts } from './faceCount';
import { weldedPolygonsOf } from './edgeIdentity';
import { getForRead, prime } from './geometryRegistry';
import { readMeshUVs } from './uvAttributes';

const box = boxGeometryRef([1, 1, 1], null);

describe('#1025 — which road a descriptor takes', () => {
  it('1 — classified exhaustively, and the buffer-only set is the censused escape hatch', () => {
    // Typed as a Record over the kind union: a new kind that is not classified here is a
    // missing-property TYPE error rather than a silent default. `never` in the production
    // switch closes "did you decide?"; this closes "decided the same way twice?".
    const road: Record<GeometryDescriptor['kind'], 'substrate' | 'buffer-only'> = {
      box: 'substrate',
      sphere: 'substrate',
      array: 'substrate',
      mirror: 'substrate',
      subset: 'substrate',
      bevel: 'substrate',
      uvProject: 'substrate',
      mesh: 'substrate',
      baked: 'buffer-only',
    };
    const kinds = Object.keys(road) as GeometryDescriptor['kind'][];
    expect(kinds.length, 'every descriptor kind is classified').toBe(9);

    for (const kind of kinds)
      expect(
        topologyIsBufferOnly({ kind } as GeometryDescriptor),
        `${kind} — the road it takes through alignedSplitRims`,
      ).toBe(road[kind] === 'buffer-only');

    // The same two `weldedPolygonsOf`, `faceCountOf` and `pointCountOf` declare. Stated as an
    // equality rather than two lists, so the day one of them widens this reds instead of
    // drifting apart quietly.
    expect(kinds.filter((k) => road[k] === 'buffer-only')).toEqual(['baked']);

    // 🔴 AND IT IS NOT `polygonLayoutOf`'s `outside-the-descriptor` SET, which also holds
    // `bevel`. Pinned because reusing that verdict is the obvious shortcut and it would put a
    // bevel — whose welded rims ARE stated, and whose alignment check is real — on the road
    // that has no check at all.
    expect(topologyIsBufferOnly(bevelGeometryRef(box, 0.1).descriptor)).toBe(false);
  });
});

describe('#1025 — the check that stands in for the alignment one', () => {
  it('6 — baked stays refused, and it is the arity that refuses it', () => {
    // Not a road question: a `baked` descriptor carries a vertex count and no face count, so
    // there is no arity to walk a buffer against. It takes the buffer-only road and reaches
    // none of it. This row is what reds the day a baked face count is captured without a decision.
    const baked: GeometryDescriptor = { kind: 'baked', hash: 'deadbeef', vertexCount: 24 };
    const ref: GeometryRef = { key: 'k|baked', descriptor: baked };
    expect(topologyIsBufferOnly(baked)).toBe(true);
    expect(faceArityOf(baked)).toBeNull();
    expect(alignedSplitRims(ref, new THREE.BoxGeometry(1, 1, 1))).toBeNull();
  });

  it('6b — and a baked mesh keeps its OWN reason, which is not an imported one', () => {
    // 🔴 THE NEGATIVE CONTROL FOR THE REFUSAL SENTENCES. `baked` shares the buffer-only road
    // and none of the imported vocabulary: it was authored here, not imported, so there is no
    // import to redo and no captured count to be stale. The first draft of the refusal block
    // did not separate them and told a baked mesh it had been "imported before its face count
    // was captured". Pinned here because this file's code is what can break it again.
    const baked: GeometryDescriptor = { kind: 'baked', hash: 'cafebabe', vertexCount: 3 };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
    prime({ key: 'k|baked-own-reason', descriptor: baked }, geometry);

    const read = readMeshUVs({ key: 'k|baked-own-reason', descriptor: baked }) as {
      status: string;
      attribute?: { why?: string };
    };
    if (read.status !== 'ok') return;
    const why = read.attribute?.why ?? '';
    expect(why, 'a baked mesh names OPFS, its own reason').toMatch(/OPFS/);
    expect(why, 'and never the imported vocabulary').not.toMatch(/imported/);
  });
});

describe('#1025 — the substrate kinds are untouched', () => {
  it('7 — every kind that answered before still answers, and is still ROTATED', () => {
    // 🔴 THE `rotates` COLUMN IS WHY THIS ROW DISCRIMINATES. Counting rims and comparing them
    // against `weldedPolygonsOf` passes whichever road a kind takes, so on its own this row
    // stays green even if every kind is misclassified as buffer-only — measured, when that
    // falsifier was run. What separates the roads is whether the rotation moves anything, and
    // for three of the four it moves a lot: a box's walk starts at a different corner from the
    // substrate on all 6 faces, a sphere on 32 of 48, a mirror on all 12.
    //
    // `bevel` is FALSE and is kept rather than dropped: its builder happens to lay each face
    // down starting where the layout does, so the rotation is an identity for it today. That is
    // a property of the builder, not a guarantee — asserting movement there would red on a
    // harmless change to it, and asserting the road is what this column is for.
    const substrate: readonly (readonly [string, GeometryRef, boolean])[] = [
      ['box', box, true],
      ['sphere', sphereGeometryRef(1, 8, 6, null), true],
      ['mirror', mirrorGeometryRef(box, 'x', 1), true],
      ['bevel', bevelGeometryRef(box, 0.1), false],
    ];
    expect(substrate.length, 'substrate kinds examined').toBe(4);
    for (const [name, ref, rotates] of substrate) {
      const geometry = getForRead(ref);
      expect(geometry, `${name} builds`).not.toBeNull();
      const rims = alignedSplitRims(ref, geometry!);
      expect(rims, `${name} still recovers its rims`).not.toBeNull();
      // The aligned road's own gate: one rim per welded rim, corner for corner.
      expect(rims!.length, `${name} — one rim per substrate rim`).toBe(
        weldedPolygonsOf(ref.descriptor)!.length,
      );

      const arity = faceArityOf(ref.descriptor)!;
      const walked = builtPolygonRims(geometry!, arity, faceElementStarts(arity))!;
      const moved = rims!.filter((rim, f) => rim.join() !== walked[f].join()).length;
      if (rotates)
        expect(
          moved,
          `${name} — the walk and the substrate disagree about where each rim starts, so the ` +
            `rotation must be doing work. Zero here means this kind has been routed onto the ` +
            `imported road, where nothing aligns it.`,
        ).toBeGreaterThan(0);
    }
  });
});
