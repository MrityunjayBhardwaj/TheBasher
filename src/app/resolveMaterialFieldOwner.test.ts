// resolveMaterialFieldOwner — the PER-FIELD material reach (#394 S3c).
//
// THE FIXTURE IS THE FINDING, again. The per-root reach (`resolveDataParamOwner`) and the
// material operator lane are each fully covered alone; the defect lives exactly at their
// intersection, where an operator forces a field and every write road still aims at the
// layer below it. Every case here puts a forcing layer and a write road in ONE state.
//
// VACUITY GUARD: every fixture gives each layer a DIFFERENT value, so a fold that never
// ran (or a layer wrongly reported transparent) reads the other layer's value and goes
// red instead of coincidentally matching.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { MATERIAL_FIELD_IR_PATH, resolveMaterialFieldOwners } from './resolveMaterialFieldOwner';
import { resolveDataParamOwner } from './resolveDataParamOwner';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

const BASE_COLOR = '#112233';
const MAT_COLOR = '#c81e5a';
const OP_COLOR = '#00ff88';

const ROUGHNESS_MAP = {
  hash: 'rough-hash',
  colorSpace: 'no-colorspace' as const,
  flipY: false,
  wrapS: 1000,
  wrapT: 1000,
};

/** `BoxData → Object`, the data node carrying its own inline material. */
function splitPair(opts: { roughnessMap?: boolean } = {}): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'data',
    nodeType: 'BoxData',
    params: {
      size: [1, 1, 1],
      material: {
        name: 'inline',
        base: { color: BASE_COLOR },
        specular: { roughness: 0.11 },
        ...(opts.roughnessMap ? { maps: { roughness: ROUGHNESS_MAP } } : {}),
      },
    },
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

/** Add a Material node and wire it into the BoxData's own `material` socket (S2). */
function withLinkedMaterial(state: DagState, id = 'mat'): DagState {
  let s = applyOp(state, {
    type: 'addNode',
    nodeId: id,
    nodeType: 'Material',
    params: { material: { name: id, base: { color: MAT_COLOR } } },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: id, socket: 'out' },
    to: { node: 'data', socket: 'material' },
  }).next;
  return s;
}

/**
 * Splice an operator into the data lane between `data` and `obj`:
 * `BoxData → op → Object.data`. This is the post-#415 stack shape, and building it by
 * re-wiring (rather than by hand-writing bindings) is what keeps the fixture honest about
 * what the UI would actually mint.
 */
function spliceOp(state: DagState, id: string, nodeType: string, params: object): DagState {
  let s = applyOp(state, { type: 'addNode', nodeId: id, nodeType, params }).next;
  const belowRef = (s.nodes.obj.inputs as Record<string, { node: string; socket: string }>).data;
  s = applyOp(s, {
    type: 'disconnect',
    from: belowRef,
    to: { node: 'obj', socket: 'data' },
  }).next;
  s = applyOp(s, { type: 'connect', from: belowRef, to: { node: id, socket: 'target' } }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: id, socket: 'out' },
    to: { node: 'obj', socket: 'data' },
  }).next;
  return s;
}

describe('with no material operator in the chain, it is the shipped reach plus a path', () => {
  // A strict extension, asserted as one: if this diverges, the lane has quietly become a
  // second answer to a question that already had one.
  it('resolves to the data node, at the field’s IR path', () => {
    const s = splitPair();
    expect(resolveMaterialFieldOwners(s, 'obj').color).toEqual({
      nodeId: resolveDataParamOwner(s, 'obj', 'material'),
      paramPath: 'material.base.color',
    });
  });

  it('resolves to the LINKED Material node when the socket supersedes the param', () => {
    const s = withLinkedMaterial(splitPair());
    expect(resolveMaterialFieldOwners(s, 'obj').color).toEqual({
      nodeId: 'mat',
      paramPath: 'material.base.color',
    });
  });

  it('maps every field to its own lobe — one wrong lobe is one silently-unwritten channel', () => {
    // Pinned as LITERALS, deliberately: comparing against MATERIAL_FIELD_IR_PATH would be
    // the map compared with itself and could not tell a right lobe from a wrong one.
    const s = splitPair();
    const paths = Object.fromEntries(
      (
        ['color', 'metalness', 'roughness', 'opacity', 'emissive', 'emissiveIntensity'] as const
      ).map((f) => [f, resolveMaterialFieldOwners(s, 'obj')[f]?.paramPath]),
    );
    expect(paths).toEqual({
      color: 'material.base.color',
      metalness: 'material.base.metalness',
      roughness: 'material.specular.roughness',
      opacity: 'material.geometry.opacity',
      emissive: 'material.emission.color',
      emissiveIntensity: 'material.emission.luminance',
    });
    // …and it is the exported map the resolver read, not a private second table.
    expect(paths).toEqual(MATERIAL_FIELD_IR_PATH);
  });

  it('returns null for a target that carries no material at all', () => {
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'null1',
      nodeType: 'Null',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }).next;
    expect(resolveMaterialFieldOwners(s, 'null1').color).toBeNull();
    expect(resolveMaterialFieldOwners(s, 'missing').color).toBeNull();
  });
});

describe('an override operator MASKS the layer below, so it owns the field (PLAN-2 §5)', () => {
  it('takes ownership of `color` away from the linked Material node', () => {
    // THE DEFECT THIS SLICE EXISTS TO NOT SHIP. Per param ROOT this resolves to 'mat', so
    // setMaterialColor writes the Material node, the op composes over it, and the rendered
    // colour does not move — success reported, nothing done (the `ac7c86f` failure, one
    // layer up). Asked per FIELD it lands on the layer that actually decides.
    const s = spliceOp(withLinkedMaterial(splitPair()), 'ovr', 'MaterialOverrideOp', {
      color: OP_COLOR,
    });
    expect(resolveDataParamOwner(s, 'obj', 'material')).toBe('mat'); // the per-root answer
    expect(resolveMaterialFieldOwners(s, 'obj').color).toEqual({
      nodeId: 'ovr',
      paramPath: 'color',
    });
  });

  it('is transparent while muted — a muted layer is byte-identically no layer', () => {
    const s = spliceOp(withLinkedMaterial(splitPair()), 'ovr', 'MaterialOverrideOp', {
      color: OP_COLOR,
      muted: true,
    });
    expect(resolveMaterialFieldOwners(s, 'obj').color).toEqual({
      nodeId: 'mat',
      paramPath: 'material.base.color',
    });
  });

  it('owns roughness when nothing defends the channel', () => {
    const s = spliceOp(splitPair(), 'ovr', 'MaterialOverrideOp', { roughness: 0.9 });
    expect(resolveMaterialFieldOwners(s, 'obj').roughness?.nodeId).toBe('ovr');
  });

  it('does NOT own roughness when a source map defends it and the bit is unauthored', () => {
    // The conditional branch, and the reason ownership is READ OFF the one decision function
    // rather than re-derived: a map-defended channel is genuinely still the source's, so a
    // write must reach past the operator to the node that owns the scalar.
    const s = spliceOp(splitPair({ roughnessMap: true }), 'ovr', 'MaterialOverrideOp', {
      roughness: 0.9,
    });
    expect(resolveMaterialFieldOwners(s, 'obj').roughness).toEqual({
      nodeId: 'data',
      paramPath: 'material.specular.roughness',
    });
  });

  it('owns roughness over a map once the director authors the bit', () => {
    // The other half of the same rule (#124 explicit force). Same fixture, one bit flipped —
    // so a resolver that ignored `overridden` passes the case above and fails here.
    const s = spliceOp(splitPair({ roughnessMap: true }), 'ovr', 'MaterialOverrideOp', {
      roughness: 0.9,
      overridden: { roughness: true },
    });
    expect(resolveMaterialFieldOwners(s, 'obj').roughness?.nodeId).toBe('ovr');
  });

  it('gives the TOPMOST forcing layer the field, not the first one found from the bottom', () => {
    // Order is the whole question: the layer nearest the Object is the one that renders.
    let s = spliceOp(splitPair(), 'lower', 'MaterialOverrideOp', { color: '#ff0000' });
    s = spliceOp(s, 'upper', 'MaterialOverrideOp', { color: OP_COLOR });
    expect(resolveMaterialFieldOwners(s, 'obj').color?.nodeId).toBe('upper');
  });
});

describe('a wholesale set operator delegates to the material it points at', () => {
  it('resolves to the Material node on its socket, at the IR path', () => {
    let s = spliceOp(splitPair(), 'setm', 'SetMaterialOp', {});
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'mat2',
      nodeType: 'Material',
      params: { material: { name: 'op-material', base: { color: OP_COLOR } } },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'mat2', socket: 'out' },
      to: { node: 'setm', socket: 'material' },
    }).next;
    expect(resolveMaterialFieldOwners(s, 'obj').color).toEqual({
      nodeId: 'mat2',
      paramPath: 'material.base.color',
    });
  });

  it('is transparent with nothing wired — matching its own passthrough evaluate', () => {
    // The resolver and the node must agree about when the operator does nothing, or the
    // write road diverges from what renders for exactly the unwired case.
    const s = spliceOp(splitPair(), 'setm', 'SetMaterialOp', {});
    expect(resolveMaterialFieldOwners(s, 'obj').color).toEqual({
      nodeId: 'data',
      paramPath: 'material.base.color',
    });
  });
});

describe('a geometry modifier is transparent to material', () => {
  it('walks past an ArrayModifier to the data node', () => {
    // It INHERITS its source's material rather than having an opinion on it
    // (ArrayModifier.ts:76), so it must never be mistaken for an owning layer.
    const s = spliceOp(splitPair(), 'arr', 'ArrayModifier', { count: 3 });
    expect(resolveMaterialFieldOwners(s, 'obj').color).toEqual({
      nodeId: 'data',
      paramPath: 'material.base.color',
    });
  });

  it('walks past a modifier stacked ON an override op and still lands on the op', () => {
    // The interleaved case: the material answer must not depend on what else is in the lane.
    let s = spliceOp(splitPair(), 'ovr', 'MaterialOverrideOp', { color: OP_COLOR });
    s = spliceOp(s, 'arr', 'ArrayModifier', { count: 2 });
    expect(resolveMaterialFieldOwners(s, 'obj').color?.nodeId).toBe('ovr');
  });
});
