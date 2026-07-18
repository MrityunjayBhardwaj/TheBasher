// Partial material setParam re-parse gate (v0.6 #2, #178, PLAN W1 1.7 — R6).
//
// ops.ts re-validates the WHOLE params object on every setParam. A grouped
// OpenPBR material field edited in isolation (e.g. material.base.metalness) must
// succeed: the zod whole-params re-parse fills every OTHER material field from
// its `.default` (R6). A missing sub-default → the partial edit fails validation
// for an unrelated undefined sibling. Every nested object carries a `.default`
// (materialSchema.ts) precisely so this holds.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '.';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { buildDefaultDagState } from '../project/default';
import type { InlineMaterialSpec } from '../../nodes/types';
import type { Op } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

// #365 Phase 5a (Slice 1b) — the box's material lives on the BoxData node now (n_box_data),
// not the Object (n_box). The R6 partial-reparse behavior is identical (same openpbr schema).
function setParam(paramPath: string, value: unknown): Op {
  return { type: 'setParam', nodeId: 'n_box_data', paramPath, value } as Op;
}

describe('partial material setParam re-parse (R6 — every sibling defaulted)', () => {
  it('material.base.metalness edit succeeds; siblings stay defaulted', () => {
    const state = buildDefaultDagState();
    const next = applyOp(state, setParam('material.base.metalness', 0.7)).next;
    const mat = next.nodes.n_box_data.params.material as InlineMaterialSpec;
    expect(mat.base.metalness).toBe(0.7); // edited field landed
    expect(mat.base.color).toBe('#5af07a'); // sibling preserved
    expect(mat.specular.roughness).toBe(0.3); // sibling defaulted, NOT dropped
    expect(mat.geometry.opacity).toBe(1);
    expect(mat.maps.albedo).toBeNull();
  });

  it('material.base.color edit succeeds and keeps the full IR', () => {
    const state = buildDefaultDagState();
    const next = applyOp(state, setParam('material.base.color', '#ff0000')).next;
    const mat = next.nodes.n_box_data.params.material as InlineMaterialSpec;
    expect(mat.base.color).toBe('#ff0000');
    expect(mat.specular.ior).toBe(1.5);
    expect(mat.emission.color).toBe('#000000');
  });

  it('material.specular.roughness edit succeeds (deepest nested scalar)', () => {
    const state = buildDefaultDagState();
    const next = applyOp(state, setParam('material.specular.roughness', 0.85)).next;
    const mat = next.nodes.n_box_data.params.material as InlineMaterialSpec;
    expect(mat.specular.roughness).toBe(0.85);
    expect(mat.base.metalness).toBe(0); // sibling lobe untouched
  });
});
