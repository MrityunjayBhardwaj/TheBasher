// resolveDataParamOwner — the object↔data split's "who owns this data param?" reach.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { resolveDataParamOwner } from './resolveDataParamOwner';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

/** An Object (transform) pointing at a BoxData (geometry + material) via `data`. */
function splitPair(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'data',
    nodeType: 'BoxData',
    params: { size: [1, 1, 1] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'obj',
    nodeType: 'Object',
    params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'data', socket: 'out' },
    to: { node: 'obj', socket: 'data' },
  }).next;
  return s;
}

function fusedBox(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0] },
  }).next;
  return s;
}

describe('resolveDataParamOwner', () => {
  it('reaches through an Object to the BoxData for material + size', () => {
    const s = splitPair();
    expect(resolveDataParamOwner(s, 'obj', 'material')).toBe('data');
    expect(resolveDataParamOwner(s, 'obj', 'size')).toBe('data');
  });

  it('returns the Object itself for a transform param it owns', () => {
    const s = splitPair();
    expect(resolveDataParamOwner(s, 'obj', 'position')).toBe('obj');
    expect(resolveDataParamOwner(s, 'obj', 'scale')).toBe('obj');
  });

  it('returns the node itself for a fused mesh that owns the param directly', () => {
    const s = fusedBox();
    expect(resolveDataParamOwner(s, 'box', 'size')).toBe('box');
  });

  it('returns null when neither the node nor its data carries the param', () => {
    const s = splitPair();
    expect(resolveDataParamOwner(s, 'obj', 'radius')).toBeNull();
    expect(resolveDataParamOwner(s, 'missing', 'material')).toBeNull();
  });

  // #485 — the camera is the first kind whose POSE spans both halves, and this helper is
  // what the gizmo's write chokepoint asks before every `position` / `lookAt` / `roll`
  // write. It got that wrong once already: all three went to the Object, where two of them
  // are silently dropped, and the aim reticle stopped working with nothing to show for it.
  //
  // The split is not obvious from the outside — `position` is a pose param and stays, while
  // `lookAt` and `roll` are ALSO pose params and move — so it is pinned per param rather
  // than described.
  it('splits a camera pose across both halves — position stays, lookAt and roll move', () => {
    const cam = makeSplitCamera(emptyDagState(), { objectId: 'cam' });

    expect(resolveDataParamOwner(cam.state, 'cam', 'position')).toBe('cam');
    expect(resolveDataParamOwner(cam.state, 'cam', 'lookAt')).toBe(cam.dataId);
    expect(resolveDataParamOwner(cam.state, 'cam', 'roll')).toBe(cam.dataId);
    // The lens rides with the aim, for the same reason.
    expect(resolveDataParamOwner(cam.state, 'cam', 'fov')).toBe(cam.dataId);
  });

  // The reach above is only sound because CameraData DECLARES `lookAt` and `roll` with zod
  // defaults and `addNode` stores PARSED params, so a freshly minted lens carries both keys.
  // This helper's possession test reads live params: an optional param with no default would
  // be absent until something wrote it, and this would resolve to the Object forever — the
  // self-locking shape that has bitten a possession check here before. So the presence of
  // the keys is asserted directly, not assumed by the test above passing.
  it('the camera lens carries its aim keys at mint, which is what makes the reach work', () => {
    const cam = makeSplitCamera(emptyDagState(), { objectId: 'cam' });
    const lensParams = cam.state.nodes[cam.dataId].params as Record<string, unknown>;

    expect(Object.keys(lensParams)).toEqual(expect.arrayContaining(['lookAt', 'roll']));
  });
});
