// P7.7 (#91) C2 — the GltfChild manual-override write path, in isolation.
//
// The gizmo's onObjectChange (Gizmo.tsx) writes a GltfChild's TRS as the manual
// override LAYER (R-4): value + the matching `overridden[field]` flag in ONE
// atomic dispatch. Two things make that correct, both proven here without React:
//
//   1. routeAnimatedGrab(childId, field, value) returns FALSE for a GltfChild —
//      there is NO KeyframeChannel* targeting it (the clip lives on the asset,
//      not a channel), so paramAnimationState is 'none'. That false IS the
//      fall-through to the raw write — the manual layer (do NOT assume it;
//      observe it).
//
//   2. The atomic [setParam value, setParam 'overridden.<field>'=true] lands as
//      ONE undo step and applySetParam's dotted nested-path support
//      (ops.ts setAtPath) flips ONLY the matching flag, leaving the other two
//      false. Writing the value WITHOUT the flag would let the clip/base re-win
//      on the next renderer re-layer (the H36 snap-back trap).
//
// REF: PLAN.md Wave C (C2); CONTEXT 7.7 R-4; hetvabhasa H36; vyapti V1/V20.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { buildDefaultDagState } from '../../core/project/default';
import { __resetRegistryForTests } from '../../core/dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { routeAnimatedGrab } from './autoKeyCommit';
import { useDagStore } from '../../core/dag/store';
import { useAutoKeyStore } from '../stores/autoKeyStore';
import { useTimeStore } from '../stores/timeStore';

const ASSET_REF = 'assets/skinned-bar.glb';
const CHILD_ID = 'n_gltf_child';
const CHILD_NAME = 'Bone';
const BASE: [number, number, number] = [1, 0, 0];
const ID3: [number, number, number] = [0, 0, 0];
const SCALE1: [number, number, number] = [1, 1, 1];

function buildChildState(): DagState {
  let state = buildDefaultDagState();
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: 'n_gltf_asset',
      nodeType: 'GltfAsset',
      params: { assetRef: ASSET_REF, nodeNameMap: { [CHILD_NAME]: CHILD_ID } },
    },
    {
      type: 'addNode',
      nodeId: CHILD_ID,
      nodeType: 'GltfChild',
      params: {
        assetRef: ASSET_REF,
        childName: CHILD_NAME,
        position: BASE,
        rotation: ID3,
        scale: SCALE1,
        overridden: { position: false, rotation: false, scale: false },
      },
    },
  ];
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('GltfChild manual-override write (P7.7 C2)', () => {
  // 1. routeAnimatedGrab fall-through — a GltfChild has no channel, so the
  //    route is NOT handled here; the gizmo proceeds to the raw atomic write.
  it('routeAnimatedGrab returns false for a GltfChild (no channel → manual layer)', () => {
    const state = buildChildState();
    useDagStore.setState({ state } as Partial<ReturnType<typeof useDagStore.getState>>);
    useAutoKeyStore.setState({ enabled: true } as never);
    useTimeStore.setState({ playing: false, frame: 0 } as never);

    const handled = routeAnimatedGrab(CHILD_ID, 'position', [5, 6, 7]);
    expect(handled).toBe(false); // un-animated → caller does the raw write
  });

  // 2. Atomic value + flag — ONE undo step; only the matching flag flips.
  it('the atomic value+flag write sets the value AND only that overridden flag', () => {
    const state = buildChildState();
    const newPos: [number, number, number] = [5, 6, 7];
    const ops: Op[] = [
      { type: 'setParam', nodeId: CHILD_ID, paramPath: 'position', value: newPos },
      { type: 'setParam', nodeId: CHILD_ID, paramPath: 'overridden.position', value: true },
    ];
    let s = state;
    for (const op of ops) s = applyOp(s, op).next;

    const p = s.nodes[CHILD_ID].params as {
      position: [number, number, number];
      overridden: { position: boolean; rotation: boolean; scale: boolean };
    };
    expect(p.position).toEqual(newPos); // value written
    expect(p.overridden.position).toBe(true); // matching flag flipped
    expect(p.overridden.rotation).toBe(false); // others untouched
    expect(p.overridden.scale).toBe(false);
  });

  // 3. The dotted nested path is honored by applySetParam (the C2 mechanism):
  //    writing 'overridden.scale' flips scale only, value-equality irrelevant.
  it('dotted overridden.<field> path flips exactly one flag (no value-equality)', () => {
    let s = buildChildState();
    s = applyOp(s, {
      type: 'setParam',
      nodeId: CHILD_ID,
      paramPath: 'overridden.scale',
      value: true,
    }).next;
    const p = s.nodes[CHILD_ID].params as {
      overridden: { position: boolean; rotation: boolean; scale: boolean };
    };
    expect(p.overridden).toEqual({ position: false, rotation: false, scale: true });
  });
});
