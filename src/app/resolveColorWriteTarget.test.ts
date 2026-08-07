// resolveColorWriteTarget — the two colour roads, and the split reach on each.
//
// #592: before this resolver existed the light road was a RAW read of the handed node's
// params, so a split light's colour was unreachable from the Object — the only half a
// director can name. The cases below pin BOTH roads landing on the owner, and the
// fused/split pair asserts coexistence rather than one shape at a time.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import { makeSplitLight } from '../test-utils/splitLight';
import { resolveColorWriteTarget } from './resolveColorWriteTarget';

describe('resolveColorWriteTarget', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  it('a split MESH resolves to the data node, at the material IR path', () => {
    const state = makeSplitCube(emptyDagState(), {
      objectId: 'box',
      size: [1, 1, 1],
      color: '#ff0000',
    }).state;

    expect(resolveColorWriteTarget(state, 'box')).toEqual({
      nodeId: 'box_data',
      paramPath: 'material.base.color',
    });
  });

  // THE #592 CASE. Asked at the OBJECT — what `identify` hands over for "the point light" —
  // not at the data half, which was never the broken road.
  it('a split LIGHT resolves to the LightData, at the flat color param', () => {
    const state = makeSplitLight(emptyDagState(), {
      objectId: 'light',
      lightKind: 'Directional',
      shading: { color: '#ffffff' },
    }).state;

    expect(resolveColorWriteTarget(state, 'light')).toEqual({
      nodeId: 'light_data',
      paramPath: 'color',
    });
  });

  // Coexistence: AmbientLight is the one light kind that deliberately never splits, so it
  // owns `color` directly. The same resolver must answer SELF for it — a reach that only
  // worked for split pairs would break the fused half instead of the other way round.
  it('a FUSED light resolves to itself', () => {
    let state: DagState = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'amb',
      nodeType: 'AmbientLight',
      params: { color: '#112233' },
    }).next;

    expect(resolveColorWriteTarget(state, 'amb')).toEqual({
      nodeId: 'amb',
      paramPath: 'color',
    });
  });

  it('a target with no colour on either road resolves to null', () => {
    let state: DagState = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'scene',
      nodeType: 'Scene',
      params: {},
    }).next;

    expect(resolveColorWriteTarget(state, 'scene')).toBeNull();
  });

  it('an unknown id resolves to null rather than throwing', () => {
    expect(resolveColorWriteTarget(emptyDagState(), 'nope')).toBeNull();
  });

  // ORDER IS LOAD-BEARING, and this is the case that pins it. A mesh must never be answered
  // by the light road: if the material arm were asked second, a data node that happened to
  // carry a flat `color` would win over the material chain and the write would land on a
  // param nothing renders.
  it('asks the material road FIRST, so a mesh never answers on the light road', () => {
    const state = makeSplitCube(emptyDagState(), {
      objectId: 'box',
      size: [1, 1, 1],
      color: '#00ff00',
    }).state;

    const target = resolveColorWriteTarget(state, 'box');
    expect(target?.paramPath).toBe('material.base.color');
    expect(target?.paramPath).not.toBe('color');
  });
});
