// #730 — the placement half of curve-as-control.
//
// The arithmetic here is the whole risk. A Group renders as
// `Translate(position)·R·S·Translate(-pivot)` and the glTF import bakes
// `position = drop + pivot`, so the effective world translation is
// `position - pivot`. Writing `position = offset` instead of `pivot + offset`
// is off by the model's bbox centre — for a humanoid, plausible-looking and
// wrong, which is the failure mode with no witness.

import { describe, it, expect } from 'vitest';
import type { DagState } from '../../core/dag/state';
import { placeCharacterAtPathStart, placementGroupFor } from './placeGeneratedMotion';

/** The node shape the glTF import produces: rig → asset ← group.children. */
function characterState(opts?: {
  position?: [number, number, number];
  pivot?: [number, number, number];
}): DagState {
  return {
    nodes: {
      n_asset: { id: 'n_asset', type: 'GltfAsset', params: { assetRef: '/models/x.glb' } },
      n_rig: {
        id: 'n_rig',
        type: 'GltfSkeleton',
        params: {},
        inputs: { asset: { node: 'n_asset', socket: 'out' } },
      },
      n_group: {
        id: 'n_group',
        type: 'Group',
        params: {
          position: opts?.position ?? [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          pivot: opts?.pivot ?? [0, 0, 0],
        },
        inputs: { children: [{ node: 'n_asset', socket: 'out' }] },
      },
    },
  } as unknown as DagState;
}

describe('finding the placement node', () => {
  it('walks rig → asset → the group that contains it', () => {
    expect(placementGroupFor(characterState(), 'n_rig')).toBe('n_group');
  });

  it('does not mistake an unrelated group for this character’s root', () => {
    const state = characterState();
    // A second Group holding something else entirely — the scan matches on the
    // asset it contains, not on being a Group.
    (state.nodes as Record<string, unknown>).n_other = {
      id: 'n_other',
      type: 'Group',
      params: {},
      inputs: { children: [{ node: 'n_elsewhere', socket: 'out' }] },
    };
    expect(placementGroupFor(state, 'n_rig')).toBe('n_group');
  });

  it('returns null for a rig with no asset behind it', () => {
    const state = characterState();
    delete (state.nodes.n_rig as { inputs?: unknown }).inputs;
    expect(placementGroupFor(state, 'n_rig')).toBeNull();
  });
});

describe('placing the character at the path start', () => {
  it('solves for the EFFECTIVE translation, not the raw position', () => {
    // pivot = the model centre, as the import bakes it. Asking for world [3, 1]
    // must produce position [3 + pivot.x, y, 1 + pivot.z] so that
    // `position - pivot` lands exactly on [3, 1].
    const state = characterState({ position: [0.5, 0, -0.25], pivot: [0.5, 0.9, -0.25] });
    const out = placeCharacterAtPathStart(state, 'n_rig', [3, 1]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ops).toEqual([
      { type: 'setParam', nodeId: 'n_group', paramPath: 'position', value: [3.5, 0, 0.75] },
    ]);
    // The observable claim, stated as the thing a viewer would measure.
    const [px, , pz] = (out.ops[0] as { value: [number, number, number] }).value;
    expect([px - 0.5, pz - -0.25]).toEqual([3, 1]);
    expect(out.to).toEqual([3, 1]);
  });

  it('is NOT a plain position write — a non-zero pivot changes the answer', () => {
    // The falsifier for the row above: same request, pivot the only difference.
    // If this file ever regresses to `position = offset`, these two agree and the
    // bbox-centre error becomes invisible.
    const zero = placeCharacterAtPathStart(characterState({ pivot: [0, 0, 0] }), 'n_rig', [3, 1]);
    const offCentre = placeCharacterAtPathStart(
      characterState({ pivot: [0.5, 0.9, -0.25] }),
      'n_rig',
      [3, 1],
    );
    expect(zero.ok && offCentre.ok).toBe(true);
    if (!zero.ok || !offCentre.ok) return;
    expect(zero.ops).not.toEqual(offCentre.ops);
  });

  it('leaves Y alone, so a character dropped at a height stays there', () => {
    const state = characterState({ position: [0, 2.5, 0], pivot: [0, 0, 0] });
    const out = placeCharacterAtPathStart(state, 'n_rig', [3, 1]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.ops[0] as { value: [number, number, number] }).value[1]).toBe(2.5);
  });

  it('places at the origin when the path genuinely starts there', () => {
    // [0,0] is a placement, not an absence — the same distinction the chain keeps
    // on the way in. A character previously standing at [4, 4] must MOVE.
    const state = characterState({ position: [4, 0, 4], pivot: [0, 0, 0] });
    const out = placeCharacterAtPathStart(state, 'n_rig', [0, 0]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.ops[0] as { value: [number, number, number] }).value).toEqual([0, 0, 0]);
    expect(out.from).toEqual([4, 4]);
  });

  it('refuses — and says why — when the character has no group to place by', () => {
    const state = characterState();
    delete (state.nodes as Record<string, unknown>).n_group;
    const out = placeCharacterAtPathStart(state, 'n_rig', [3, 1]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // The message has to name the CONSEQUENCE, because the clip still plays and
    // the only thing wrong is where.
    expect(out.reason).toMatch(/origin rather than along the path/);
  });

  it('refuses a non-finite offset rather than writing NaN into the graph', () => {
    const out = placeCharacterAtPathStart(characterState(), 'n_rig', [Number.NaN, 1]);
    expect(out.ok).toBe(false);
  });

  it('defaults a legacy group’s missing transform params instead of writing NaN', () => {
    // A pre-#222 Group hydrates with params `{}` and is never re-parsed through
    // zod, so `position`/`pivot` are genuinely absent. `undefined + 3` is NaN.
    const state = characterState();
    (state.nodes.n_group as { params: unknown }).params = {};
    const out = placeCharacterAtPathStart(state, 'n_rig', [3, 1]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.ops[0] as { value: [number, number, number] }).value).toEqual([3, 0, 1]);
  });
});
