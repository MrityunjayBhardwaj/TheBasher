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

/** The split pair above, plus a Material node wired into the BoxData's `material` socket. */
function linkedMaterialPair(): DagState {
  let s = splitPair();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'mat',
    nodeType: 'Material',
    params: { material: { name: 'shared', base: { color: '#c81e5a' } } },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'mat', socket: 'out' },
    to: { node: 'data', socket: 'material' },
  }).next;
  return s;
}

/** The split pair with a geometry modifier spliced into the data lane:
 *  `BoxData → ArrayModifier → Object.data` (the post-#415 stack shape). */
function pairWithModifier(): DagState {
  let s = splitPair();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'arr',
    nodeType: 'ArrayModifier',
    params: { count: 3 },
  }).next;
  s = applyOp(s, {
    type: 'disconnect',
    from: { node: 'data', socket: 'out' },
    to: { node: 'obj', socket: 'data' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'data', socket: 'out' },
    to: { node: 'arr', socket: 'target' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'arr', socket: 'out' },
    to: { node: 'obj', socket: 'data' },
  }).next;
  return s;
}

describe('the reach walks the whole operator chain, never one hop (#516)', () => {
  // THE FIXTURE IS THE FINDING. A modifier and a data-param write each had full
  // coverage alone; nothing put them in the same state, and the gap was exactly
  // their intersection. Once the stack moved onto the data lane, `Object.data`
  // names the TOP of the stack, so the old single hop landed on the operator.
  it('resolves `material` past a spliced modifier to the data node', () => {
    // MEASURED before the fix: null. Every write road reads this, so a cube with
    // one Array modifier reported having no material at all — setMaterialColor
    // refused it, randomize skipped it — while rendering its material correctly.
    expect(resolveDataParamOwner(pairWithModifier(), 'obj', 'material')).toBe('data');
  });

  it('resolves `size` past the same modifier', () => {
    // The second casualty of the same hop: the scale mutator reads `size`/`radius`.
    expect(resolveDataParamOwner(pairWithModifier(), 'obj', 'size')).toBe('data');
  });

  it('still finds the LINKED producer through the chain — both hops compose', () => {
    // The chain walk and the socket-supersedes-param hop are different questions,
    // and a fix for one that dropped the other would pass every test above.
    let s = pairWithModifier();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'mat',
      nodeType: 'Material',
      params: { material: { name: 'shared', base: { color: '#c81e5a' } } },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'mat', socket: 'out' },
      to: { node: 'data', socket: 'material' },
    }).next;
    expect(resolveDataParamOwner(s, 'obj', 'material')).toBe('mat');
  });

  it('leaves the transform on the Object — the walk must not reach past its own question', () => {
    expect(resolveDataParamOwner(pairWithModifier(), 'obj', 'position')).toBe('obj');
  });

  it('reports null for a param nothing in the chain carries', () => {
    expect(resolveDataParamOwner(pairWithModifier(), 'obj', 'radius')).toBeNull();
  });
});

describe('the second hop — a socket that supersedes a param moves ownership (#394)', () => {
  it('resolves `material` to the LINKED Material node, not the data node holding the param', () => {
    // MEASURED before this hop existed: `setMaterialColor` on the Object passed its
    // precondition, emitted a setParam against the BoxData, applied it cleanly, and the
    // rendered colour did not move. Success reported, nothing done. That is what this
    // assertion prevents, and reverting the hop reproduces it exactly.
    expect(resolveDataParamOwner(linkedMaterialPair(), 'obj', 'material')).toBe('mat');
  });

  it('resolves the same answer when asked about the DATA node directly', () => {
    // Both roads reach the same authority: the inspector addresses a data node's rows by
    // the data id, the mutator names the Object. One answer, or the panel reports one
    // colour while the viewport draws another.
    expect(resolveDataParamOwner(linkedMaterialPair(), 'data', 'material')).toBe('mat');
  });

  it('falls back to the data node the moment the link is gone', () => {
    const unlinked = applyOp(linkedMaterialPair(), {
      type: 'disconnect',
      from: { node: 'mat', socket: 'out' },
      to: { node: 'data', socket: 'material' },
    }).next;
    expect(resolveDataParamOwner(unlinked, 'obj', 'material')).toBe('data');
  });

  it('leaves a param with no same-named socket alone — `size` still resolves to the data', () => {
    // The hop is keyed on a socket sharing the param's name AND the producer actually
    // carrying that param, so it cannot wander onto an unrelated edge.
    expect(resolveDataParamOwner(linkedMaterialPair(), 'obj', 'size')).toBe('data');
    expect(resolveDataParamOwner(linkedMaterialPair(), 'obj', 'position')).toBe('obj');
  });
});

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
