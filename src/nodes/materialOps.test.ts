// The material operator lane — SetMaterialOp + MaterialOverrideOp (#394 S3c).
//
// Two things are proven here, and the second is the one the slice exists for:
//   1. the ops FOLD — `base → op₁ → … → opₙ`, in stack order, through the one
//      composition rule;
//   2. the WRITE ROAD lands on the layer that renders. That is asserted on the EVALUATED
//      value after running the REAL mutator, never on the ops it emitted: an op-shaped
//      assertion ("a setParam was emitted against X") passes against the broken version,
//      which is exactly how this class of failure survives review (PLAN-2 §5).
//
// VACUITY GUARD: every fixture gives the base and the operator DIFFERENT values, so a fold
// that never ran reads the base and goes red rather than coincidentally matching.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import { __reseedAllNodesForTests } from './registerAll';
import type { InlineMaterialSpec, ObjectData } from './types';
import { setMaterialColorMutator } from '../agent/mutators/builders/setMaterialColor';
import type { ClosureSet } from '../agent/closure/types';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

const BASE_COLOR = '#112233';
const MAT_COLOR = '#c81e5a';
const OP_COLOR = '#00ff88';
const WRITE_COLOR = '#f0a010';

function splitPair(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'data',
    nodeType: 'BoxData',
    params: {
      size: [1, 1, 1],
      material: { name: 'inline', base: { color: BASE_COLOR }, specular: { roughness: 0.11 } },
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

function spliceOp(state: DagState, id: string, nodeType: string, params: object): DagState {
  let s = applyOp(state, { type: 'addNode', nodeId: id, nodeType, params }).next;
  const belowRef = (s.nodes.obj.inputs as Record<string, { node: string; socket: string }>).data;
  s = applyOp(s, { type: 'disconnect', from: belowRef, to: { node: 'obj', socket: 'data' } }).next;
  s = applyOp(s, { type: 'connect', from: belowRef, to: { node: id, socket: 'target' } }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: id, socket: 'out' },
    to: { node: 'obj', socket: 'data' },
  }).next;
  return s;
}

function addMaterialNode(state: DagState, id: string, color: string): DagState {
  return applyOp(state, {
    type: 'addNode',
    nodeId: id,
    nodeType: 'Material',
    params: { material: { name: id, base: { color } } },
  }).next;
}

/** The material the OBJECT actually wears — the value the renderer reads, not a param. */
function evaluatedMaterial(state: DagState, id = 'obj'): InlineMaterialSpec {
  const value = evaluate(state, id).value as { data?: ObjectData } | undefined;
  const data = value?.data;
  if (!data || !('material' in data) || !data.material || !('base' in data.material)) {
    throw new Error(`no inline material on the evaluated ${id}`);
  }
  return data.material;
}

describe('SetMaterialOp — wholesale replace from a Material node on its socket', () => {
  function withSetOp(opts: { linked?: boolean; muted?: boolean } = {}): DagState {
    let s = spliceOp(splitPair(), 'setm', 'SetMaterialOp', { muted: opts.muted ?? false });
    if (opts.linked ?? true) {
      s = addMaterialNode(s, 'mat', MAT_COLOR);
      s = applyOp(s, {
        type: 'connect',
        from: { node: 'mat', socket: 'out' },
        to: { node: 'setm', socket: 'material' },
      }).next;
    }
    return s;
  }

  it('replaces the source material with the one on its socket', () => {
    expect(evaluatedMaterial(withSetOp()).base.color).toBe(MAT_COLOR);
  });

  it('keeps the source GEOMETRY untouched — it has an opinion about material only', () => {
    const withOp = evaluate(withSetOp(), 'obj').value as { data?: ObjectData };
    const without = evaluate(splitPair(), 'obj').value as { data?: ObjectData };
    const geomOf = (d: ObjectData | undefined) => (d && 'geometry' in d ? d.geometry.key : null);
    expect(geomOf(withOp.data)).toBe(geomOf(without.data));
  });

  it('is a passthrough while muted (V58)', () => {
    expect(evaluatedMaterial(withSetOp({ muted: true })).base.color).toBe(BASE_COLOR);
  });

  it('is a passthrough with nothing wired — an op added before its material is picked', () => {
    // Never a blanked mesh: the honest answer for "no material chosen yet" is the source's.
    expect(evaluatedMaterial(withSetOp({ linked: false })).base.color).toBe(BASE_COLOR);
  });
});

describe('MaterialOverrideOp — the sparse diff, folded through the one composition rule', () => {
  it('composes its authored channel over the source', () => {
    const s = spliceOp(splitPair(), 'ovr', 'MaterialOverrideOp', { color: OP_COLOR });
    expect(evaluatedMaterial(s).base.color).toBe(OP_COLOR);
  });

  it('leaves channels it has no opinion about to the source (the sparse half)', () => {
    // The base's roughness is 0.11 and the op's default is 0.5 — DIFFERENT on purpose, so
    // "the op wrote everything wholesale" is distinguishable from "the op composed".
    const s = spliceOp(splitPair(), 'ovr', 'MaterialOverrideOp', {
      color: OP_COLOR,
      roughness: 0.5,
      overridden: { roughness: false },
    });
    // With no source map defending it the scalar IS the value, so it applies — the #99
    // map-aware default, not a wholesale write. Pinned so the rule cannot drift silently.
    expect(evaluatedMaterial(s).specular.roughness).toBe(0.5);
    // …while the lobes no MaterialValue carries an opinion about ride through untouched.
    expect(evaluatedMaterial(s).specular.ior).toBe(evaluatedMaterial(splitPair()).specular.ior);
  });

  it('is a passthrough while muted (V58)', () => {
    const s = spliceOp(splitPair(), 'ovr', 'MaterialOverrideOp', {
      color: OP_COLOR,
      muted: true,
    });
    expect(evaluatedMaterial(s).base.color).toBe(BASE_COLOR);
  });

  it('folds a chain in stack order — the TOP layer is the one that renders', () => {
    let s = spliceOp(splitPair(), 'lower', 'MaterialOverrideOp', { color: '#ff0000' });
    s = spliceOp(s, 'upper', 'MaterialOverrideOp', { color: OP_COLOR });
    expect(evaluatedMaterial(s).base.color).toBe(OP_COLOR);
  });

  it('composes onto a SetMaterialOp below it — the two operators fold together', () => {
    // The composable claim: a wholesale set is the degenerate fold step, and a diff over it
    // must see the material IT installed, not the one further down.
    let s = spliceOp(splitPair(), 'setm', 'SetMaterialOp', {});
    s = addMaterialNode(s, 'mat', MAT_COLOR);
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'mat', socket: 'out' },
      to: { node: 'setm', socket: 'material' },
    }).next;
    s = spliceOp(s, 'ovr', 'MaterialOverrideOp', {
      roughness: 0.77,
      overridden: { roughness: true },
    });
    const m = evaluatedMaterial(s);
    expect(m.specular.roughness).toBe(0.77); // the op's channel
    // WHAT THE ACCUMULATOR WAS, proven on a channel the override has no opinion about.
    // Every field a `MaterialValue` carries is forced when no map defends it — including
    // `color`, whose default is white — so the colour cannot distinguish "composed over
    // the SET material" from "composed over the BoxData's". `name` can: it rides through
    // the fold from the base untouched.
    expect(m.name).toBe('mat'); // `addMaterialNode` names the spec after the node id
    expect(evaluatedMaterial(splitPair()).name).toBe('inline'); // the control
  });

  it('applies its colour even at the default — the tint fields are unconditional', () => {
    // NOT a defect and NOT this slice's call: `color`/`emissive`/`opacity` ignore the
    // authored set by design (their default is map-identity, materialOverrideMerge.ts:88),
    // and the scene-band wrapper has always behaved this way. Pinned because it is
    // surprising on a MAPLESS native material, where white means white rather than
    // "multiply the map by 1" — so a stack UI that adds one of these with defaults
    // visibly whitens the object. Changing it would diverge the two hosts of one rule.
    const s = spliceOp(splitPair(), 'ovr', 'MaterialOverrideOp', {});
    expect(evaluatedMaterial(s).base.color).toBe('#ffffff');
  });

  it('passes non-mesh data through — a light wears no material', () => {
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'lightdata',
      nodeType: 'LightData',
      params: { lightKind: 'Point', intensity: 3 },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'ovr',
      nodeType: 'MaterialOverrideOp',
      params: { color: OP_COLOR },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'lightdata', socket: 'out' },
      to: { node: 'ovr', socket: 'target' },
    }).next;
    const out = evaluate(s, 'ovr').value as ObjectData;
    expect(out.kind).toBe('LightData');
  });
});

describe('THE WRITE ROAD, asserted on what renders (PLAN-2 §5)', () => {
  /** Run the REAL mutator end to end and return the state its ops produced. */
  function runSetMaterialColor(state: DagState, target: string, color: string): DagState {
    const spec = { targetSelectors: [target], color };
    const pre = setMaterialColorMutator.preconditions(spec, {} as ClosureSet, state);
    expect(pre.ok, `precondition refused: ${pre.ok ? '' : pre.reason}`).toBe(true);
    const ops = setMaterialColorMutator.build(spec, {} as ClosureSet, state);
    expect(ops.length).toBeGreaterThan(0);
    return ops.reduce((s, op) => applyOp(s, op).next, state);
  }

  it('a write reaches what renders even with a FORCING operator in the stack', () => {
    // MEASURED SHAPE OF THE DEFECT: with the per-root reach this wrote the Material node,
    // the op composed over it, the mutator reported success and the cube did not change.
    // The assertion is the EVALUATED colour, so that version cannot pass here.
    let s = spliceOp(splitPair(), 'ovr', 'MaterialOverrideOp', { color: OP_COLOR });
    s = addMaterialNode(s, 'mat', MAT_COLOR);
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'mat', socket: 'out' },
      to: { node: 'data', socket: 'material' },
    }).next;
    // Precondition: the op really is masking, i.e. the fixture is not vacuous.
    expect(evaluatedMaterial(s).base.color).toBe(OP_COLOR);

    s = runSetMaterialColor(s, 'obj', WRITE_COLOR);

    expect(evaluatedMaterial(s).base.color).toBe(WRITE_COLOR);
  });

  it('still reaches the linked Material node when nothing masks the field', () => {
    // The shipped `ac7c86f` behaviour, unchanged — a fix for the new case that broke the
    // old one would pass the test above.
    let s = splitPair();
    s = addMaterialNode(s, 'mat', MAT_COLOR);
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'mat', socket: 'out' },
      to: { node: 'data', socket: 'material' },
    }).next;
    expect(evaluatedMaterial(s).base.color).toBe(MAT_COLOR);

    s = runSetMaterialColor(s, 'obj', WRITE_COLOR);

    expect(evaluatedMaterial(s).base.color).toBe(WRITE_COLOR);
    // …and it wrote the SHARED material, which is the point of the node existing.
    expect((s.nodes.mat.params as { material: InlineMaterialSpec }).material.base.color).toBe(
      WRITE_COLOR,
    );
  });

  it('reaches past a MUTED operator to the layer that actually renders', () => {
    // A muted layer masks nothing, so the write must go through it — the mirror of the
    // forcing case, and the one a "is there any operator?" check would get wrong.
    let s = spliceOp(splitPair(), 'ovr', 'MaterialOverrideOp', {
      color: OP_COLOR,
      muted: true,
    });
    s = runSetMaterialColor(s, 'obj', WRITE_COLOR);
    expect(evaluatedMaterial(s).base.color).toBe(WRITE_COLOR);
  });
});
