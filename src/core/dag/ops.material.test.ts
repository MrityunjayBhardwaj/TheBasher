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
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from '../project/default';
import type { InlineMaterialSpec } from '../../nodes/types';
import type { Op } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
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
    expect(mat.base.color).toBe('#cccccc'); // sibling preserved (the standard, #394 D7)
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

// #1123 — the map strengths are an OPTIONAL bag with no default, so a material saved before it
// has none. An inspector edit on that material must create it, not fail validation or vanish.
describe('#1123 — an edit on an absent map-strength bag creates it', () => {
  it('the default box has no bag, and setting one strength makes a bag holding only it', () => {
    const state = buildDefaultDagState();
    const before = state.nodes.n_box_data.params.material as InlineMaterialSpec;
    expect('mapStrengths' in before).toBe(false);
    const next = applyOp(state, setParam('material.mapStrengths.normal', 0.4)).next;
    const mat = next.nodes.n_box_data.params.material as InlineMaterialSpec;
    expect(mat.mapStrengths).toEqual({ normal: 0.4 });
    expect(mat.base.color).toBe(before.base.color); // the rest of the material is untouched
  });
});

// #1123 — THE PLAN'S OPEN QUESTION for the first new lobe: fuzz is optional with no default on the
// lobe, so a material saved before it has none. An edit on one of its fields must create the WHOLE
// lobe, its other fields at OpenPBR's defaults (`open_pbr_surface.mtlx`: colour white, roughness 0.5).
describe('#1123 — an edit on an absent fuzz lobe creates the whole lobe', () => {
  it('setting the weight on a box with no fuzz makes a lobe with the other fields defaulted', () => {
    const state = buildDefaultDagState();
    expect('fuzz' in (state.nodes.n_box_data.params.material as InlineMaterialSpec)).toBe(false);
    const next = applyOp(state, setParam('material.fuzz.weight', 0.7)).next;
    const mat = next.nodes.n_box_data.params.material as InlineMaterialSpec;
    expect(mat.fuzz).toEqual({ weight: 0.7, color: '#ffffff', roughness: 0.5 });
  });
});

// #1321 — the specular lobe always exists, but its weight and colour are optional fields inside it:
// an edit on one must add that field alone and leave the other absent (absent means OpenPBR's default).
describe('#1321 — an edit on an absent specular weight adds that field alone', () => {
  it('setting the weight leaves the colour absent', () => {
    const state = buildDefaultDagState();
    const next = applyOp(state, setParam('material.specular.weight', 0.4)).next;
    const mat = next.nodes.n_box_data.params.material as InlineMaterialSpec;
    expect(mat.specular).toEqual({ roughness: 0.3, ior: 1.5, weight: 0.4 });
  });
});
