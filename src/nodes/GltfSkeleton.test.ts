// GltfSkeleton node tests — Phase 7.11 Wave F (F2 + F3, issue #100).
//
// F2 (purity/determinism — D-02 / V2): the node is a pure read of its `asset`
//    input. Twice-eval the SAME GltfAssetValue → deep-equal Skeleton (incl.
//    scale + IBM). A missing/empty skin → { kind:'Skeleton', bones:[] }.
// F3 (no-write-back — V20 / H36, the ENFORCED invariant): grep the node + the
//    projector source for write tokens (setParam / dispatch / store access /
//    GltfChild reference). This converts "the projection is read-only" from
//    prose into a build gate — a future "convenience" write-back fails the
//    build. Mirrors the gltfLoaderConfig.test.ts regression-guard grep
//    (readFileSync + .not.toMatch).
//
// REF: PLAN.md Wave F (F2/F3); GltfSkeleton.ts; projectGltfSkeleton.ts;
// vyapti V2 (purity) / V20 + H36 (single-writer); RESEARCH.md §B1.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GltfSkeletonNode } from './GltfSkeleton';
import type { GltfAssetValue, GltfSkinMetadata, SkeletonValue } from './types';
import type { ResolvedInputs } from '../core/dag/types';

const SKIN: GltfSkinMetadata = {
  jointKeys: ['Bone0', 'Bone1'],
  bindTRS: [
    { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { position: [0, 1, 0], rotation: [90, 0, 0], scale: [2, 2, 2] },
  ],
  parentJointIndex: [-1, 0],
  inverseBindMatrices: [
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1],
  ],
};

function assetValue(skins: GltfSkinMetadata[]): GltfAssetValue {
  return {
    kind: 'GltfAsset',
    assetRef: 'assets/test.glb',
    nodeNameMap: {},
    childHierarchy: {},
    skins,
    transformClip: null,
  };
}

function evalNode(asset: GltfAssetValue | undefined, skinIndex = 0): SkeletonValue {
  const inputs = { asset } as unknown as ResolvedInputs;
  return GltfSkeletonNode.evaluate({ skinIndex }, inputs) as SkeletonValue;
}

describe('GltfSkeleton node — purity + determinism (F2 / D-02 / V2)', () => {
  it('twice-eval the same GltfAssetValue → deep-equal Skeleton (incl. scale + IBM)', () => {
    const av = assetValue([SKIN]);
    const a = evalNode(av);
    const b = evalNode(av);
    expect(a).toEqual(b);
    // The projection actually populated the rig (not a vacuous empty equality).
    expect(a.bones).toHaveLength(2);
    expect(a.bones[1].scale).toEqual([2, 2, 2]);
    expect(a.bones[1].inverseBindMatrix).toHaveLength(16);
  });

  it('selects the skin at `skinIndex`', () => {
    const other: GltfSkinMetadata = {
      jointKeys: ['Only'],
      bindTRS: [{ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
      parentJointIndex: [-1],
      inverseBindMatrices: [],
    };
    const av = assetValue([SKIN, other]);
    expect(evalNode(av, 0).bones.map((x) => x.name)).toEqual(['Bone0', 'Bone1']);
    expect(evalNode(av, 1).bones.map((x) => x.name)).toEqual(['Only']);
  });

  it('missing asset input → empty Skeleton (no throw)', () => {
    expect(evalNode(undefined)).toEqual({ kind: 'Skeleton', bones: [] });
  });

  it('asset with no skins (pre-7.11 / non-skinned) → empty Skeleton', () => {
    expect(evalNode(assetValue([]))).toEqual({ kind: 'Skeleton', bones: [] });
  });

  it('skinIndex out of range → empty Skeleton', () => {
    expect(evalNode(assetValue([SKIN]), 5)).toEqual({ kind: 'Skeleton', bones: [] });
  });
});

describe('GltfSkeleton — no write-back (F3 / V20 / H36, the enforced invariant)', () => {
  // The architectural guarantee D-02 was chosen for: the projection is a PURE
  // read; there is NO code path that writes back to GltfChild. A grep guard
  // fails the build if a future edit reopens H36's dual-write trap.
  const files = [
    join(__dirname, 'GltfSkeleton.ts'),
    join(__dirname, '../core/import/projectGltfSkeleton.ts'),
  ];

  // Write tokens that would indicate a mutation path out of a "pure" node.
  // `setParam` / `dispatch` = an Op write; `setState`/`getState`/`useStore`/
  // `useDagStore`/`useViewportStore` = direct store access; `GltfChild` = a
  // reference to the pose owner (this node must never touch it).
  const WRITE_TOKENS = [
    /\bsetParam\b/,
    /\bdispatch\b/,
    /\bsetState\b/,
    /\bgetState\b/,
    /\buseStore\b/,
    /\buseDagStore\b/,
    /\buseViewportStore\b/,
    /\bGltfChild\b/,
  ];

  for (const file of files) {
    it(`${file.split('/').pop()} contains NO write/store tokens`, () => {
      // Strip line comments + block comments so a doc mention of "GltfChild"
      // or "no dispatch" in the rationale prose does not trip the guard — we
      // assert on CODE, not on the explanatory comments.
      const raw = readFileSync(file, 'utf8');
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
      for (const token of WRITE_TOKENS) {
        expect(code).not.toMatch(token);
      }
    });
  }
});
