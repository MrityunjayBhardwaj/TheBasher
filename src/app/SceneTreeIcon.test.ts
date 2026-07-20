// SceneTreeIcon — which icon family a scene-tree row gets (#414).
//
// The load-bearing case here is the LAST one. Node types are strings, not a closed
// union (the registry is keyed by `NodeTypeId = z.string()`), so the compiler cannot
// force a newly-registered data kind to be answered in `kindForNodeType` the way an
// exhaustive switch closed by `never` would. That missing compiler pressure is
// exactly how `'Object'` came to fall through to the generic dot in the first place.
//
// So the guard is the REGISTRY itself: every registered node type that can sit on an
// Object's `data` socket must resolve to a real icon. Stage C registers SphereData,
// CurveData, LightData and CameraData behind the same `Object` wrapper — each one
// reddens this test the moment it lands without an icon arm, which is the pressure
// the type system cannot supply here.
//
// REF: src/app/SceneTreeIcon.tsx; src/app/resolveDataParamOwner.ts; issue #414.

import { describe, it, expect, beforeEach } from 'vitest';
import { emptyDagState, applyOp } from '../core/dag';
import { listNodeTypes, getNodeType } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import { iconKindForNode } from './SceneTreeIcon';

describe('SceneTreeIcon — a row is iconed by what it IS, not what type carries it', () => {
  beforeEach(() => __reseedAllNodesForTests());

  it('a split cube gets the mesh icon, resolved through its data edge (#414)', () => {
    const { state, objectId } = makeSplitCube(emptyDagState(), {
      objectId: 'n_box',
      size: [1, 1, 1],
    });
    // Before the fix this was 'dot': 'Object' matched no arm of the mesh list.
    expect(iconKindForNode(state, objectId, 'Object')).toBe('mesh');
  });

  it('the data node itself also reads as a mesh', () => {
    const { state, dataId } = makeSplitCube(emptyDagState(), {
      objectId: 'n_box',
      size: [1, 1, 1],
    });
    expect(iconKindForNode(state, dataId, 'BoxData')).toBe('mesh');
  });

  it('an Object with no data is an Empty — a transform, deliberately not a dot', () => {
    const state = applyOp(emptyDagState(), {
      type: 'addNode',
      nodeId: 'n_empty',
      nodeType: 'Object',
      params: {},
    }).next;
    // 'dot' means "I don't know what this is". We know exactly what an Empty is.
    expect(iconKindForNode(state, 'n_empty', 'Object')).toBe('transform');
    expect(iconKindForNode(state, 'n_empty', 'Object')).not.toBe('dot');
  });

  it('non-Object rows are unaffected — the type still answers directly', () => {
    const state = emptyDagState();
    expect(iconKindForNode(state, 'x', 'SphereMesh')).toBe('mesh');
    expect(iconKindForNode(state, 'x', 'Group')).toBe('group');
    expect(iconKindForNode(state, 'x', 'PointLight')).toBe('light');
    expect(iconKindForNode(state, 'x', 'PerspectiveCamera')).toBe('camera');
    expect(iconKindForNode(state, 'x', 'Curve')).toBe('curve');
  });

  it('an unknown type still degrades to a dot rather than throwing', () => {
    expect(iconKindForNode(emptyDagState(), 'x', 'NotARealNodeType')).toBe('dot');
  });

  // Locked BEFORE these types exist, on purpose. The first shape of this fix mapped
  // `endsWith('Data')` straight to 'mesh', which would have drawn a CUBE for a light
  // and a camera the moment the per-kind rollout registered them. That is worse than
  // the dot it replaced — a wrong-but-plausible icon reads as correct — and the
  // registry sweep below could not have caught it, because that sweep only asks
  // "not a dot". A data node is iconed by its STEM; these pin what each stem means.
  it('a data node is iconed by its stem, so the rollout cannot draw a cube for a light', () => {
    const s = emptyDagState();
    expect(iconKindForNode(s, 'x', 'BoxData')).toBe('mesh');
    expect(iconKindForNode(s, 'x', 'SphereData')).toBe('mesh');
    expect(iconKindForNode(s, 'x', 'LightData')).toBe('light');
    expect(iconKindForNode(s, 'x', 'CameraData')).toBe('camera');
    expect(iconKindForNode(s, 'x', 'CurveData')).toBe('curve');
  });

  // THE STRUCTURAL GUARD — see the file header.
  //
  // No nodes are constructed here on purpose: a data type is resolved by type alone
  // (only 'Object' consults the graph), so the sweep needs no params and cannot be
  // broken by a data node's schema requirements. It composes with the delegation
  // case above — that one proves Object → data → icon works, this one proves every
  // data kind has an icon to delegate TO.
  it('every registered data-socket node type resolves to a real icon, not a dot', () => {
    const dataKinds = listNodeTypes().filter(
      (type) => getNodeType(type)?.outputs?.out?.type === 'ObjectData',
    );
    // Guard the guard: if this ever finds nothing, the filter has drifted and the
    // test would pass vacuously for every future data kind.
    expect(dataKinds.length).toBeGreaterThan(0);

    const state = emptyDagState();
    const unanswered = dataKinds.filter((type) => iconKindForNode(state, 'x', type) === 'dot');
    expect(unanswered).toEqual([]);
  });
});
