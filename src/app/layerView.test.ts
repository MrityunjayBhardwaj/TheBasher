// #1894 S1 — the pure row read model. Two things it must do:
//
//   read == render — the value a row shows for an animatable amount is the value the renderer
//   composes, not the raw param the graph stores. A step's influence is a `Value` node's `value`
//   param, read through `resolveEvaluatedParam` (the render's own read, folding through
//   `foldChannelValue`). A keyed/driven influence shows the FOLDED number. A constraint setting
//   renders through a SEPARATE path (`worldStepFold`/`constraintStepFold`), but its settings are
//   read through the SAME resolver — so a read model built on it cannot drift from either lane.
//
//   G3 (pure view) — the row is derived from the declared contract (`chain.section`), never from an
//   implementation-kind flag (`worldStep`) or a node-type switch. A source gate proves it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  __resetRegistryForTests,
  applyOps,
  getNodeType,
  listNodeTypes,
  LAYER_LANES,
} from '../core/dag';
import { constraintStepFold } from './constraintChain';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { foldChannelValue } from '../nodes/foldChannel';
import { poseLayerWeightOf, PoseLayerParams as PoseLayerParamsSchema } from '../nodes/PoseLayer';
import { buildCrateMockup, type CrateMockup } from '../test-utils/crateMockup';
import { formatValue, layerView } from './layerView';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { stackOf, type StackNodeRow, type StackRow } from './stackTree';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const ctxAt = (seconds: number): EvalCtx => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});

const every = (rows: readonly StackRow[]): StackRow[] =>
  rows.flatMap((r) =>
    r.kind === 'same'
      ? [r]
      : [r, ...r.groups.flatMap((g) => every(g.rows)), ...every(r.template?.inside ?? [])],
  );
const rowOf = (rows: readonly StackRow[], id: string) =>
  every(rows).find((r) => r.kind === 'node' && r.nodeId === id) as StackNodeRow;

describe('read == render — the row shows the FOLDED value, not the raw param', () => {
  // The Barrel's Track-To carries an influence of 0.5 (crateMockup): six small nodes whose factor
  // is the `Value` node `barrelAim_influence_value`. Keying/driving that param makes raw ≠ folded.
  const FACTOR = 'barrelAim_influence_value';

  const keyFactor = (keyframes: { time: number; value: number }[], extra: object = {}) => {
    const m = buildCrateMockup(buildDefaultDagState());
    const state = applyOps(m.state, [
      {
        type: 'addNode',
        nodeId: 'barrelAim_influence_key',
        nodeType: 'KeyframeChannelNumber',
        params: { target: FACTOR, paramPath: 'value', keyframes, ...extra },
      },
    ]).next;
    return { m, state };
  };

  it('a channel/driver param: influence == the value the renderer composes (foldChannelValue)', () => {
    // A single channel holds the factor at 0.2 — the renderer samples 0.2, the graph still stores
    // the base 0.5. The row must show 0.2 (what renders), not 0.5 (what it reads off the node).
    const { m, state } = keyFactor([{ time: 0, value: 0.2 }]);
    const row = rowOf(stackOf(state, m.barrel), 'barrelAim');
    const rendered = resolveEvaluatedParam(state, FACTOR, 'value', ctxAt(0))?.value;

    expect(rendered).toBe(0.2); // the render-identical read, not the stored 0.5
    expect(layerView(state, row, ctxAt(0)).influence).toBe('0.2');
    expect(layerView(state, row, ctxAt(0)).influence).not.toBe('0.5'); // able-to-red: the raw read

    // TWO channels compose through `foldChannelValue` (resolveEvaluatedParam's 2+ path). The row
    // still shows exactly what that render path produces — never a hand-recomputed number.
    const stacked = applyOps(state, [
      {
        type: 'addNode',
        nodeId: 'barrelAim_influence_key2',
        nodeType: 'KeyframeChannelNumber',
        params: {
          target: FACTOR,
          paramPath: 'value',
          keyframes: [{ time: 0, value: 0.7 }],
          order: 1,
        },
      },
    ]).next;
    const row2 = rowOf(stackOf(stacked, m.barrel), 'barrelAim');
    const folded = resolveEvaluatedParam(stacked, FACTOR, 'value', ctxAt(0))?.value;
    expect(layerView(stacked, row2, ctxAt(0)).influence).toBe(formatValue(folded));
    expect(folded).not.toBe(0.5); // the fold moved it off the stored base
  });

  it('a static factor still reads its stored number (no override ⇒ base, byte-identical)', () => {
    const m = buildCrateMockup(buildDefaultDagState());
    const row = rowOf(stackOf(m.state, m.barrel), 'barrelAim');
    expect(layerView(m.state, row, ctxAt(0)).influence).toBe('0.5');
  });

  // A constraint SETTING renders through `worldStepFold` (`constraintStepFold`), a path separate
  // from the operator fold. Its settings are read through the SAME `resolveEvaluatedParam` the row
  // model uses — so the lane S0b added cannot ship read ≠ render. Keyed `roll` proves it.
  it('a constraint setting: worldStepFold consumes the folded value, the same resolver the row reads', () => {
    const I = new THREE.Matrix4().identity().toArray();
    const trackTo = (roll: number, key?: number): DagState => {
      let s = buildDefaultDagState();
      s = applyOps(s, [
        {
          type: 'addNode',
          nodeId: 't',
          nodeType: 'TrackTo',
          params: { aimPoint: [1, 0, 0], up: [0, 1, 0], roll, aimSpace: 'world', aimBone: '' },
        },
      ]).next;
      if (key !== undefined) {
        s = applyOps(s, [
          {
            type: 'addNode',
            nodeId: 't_roll',
            nodeType: 'KeyframeChannelNumber',
            params: { target: 't', paramPath: 'roll', keyframes: [{ time: 0, value: key }] },
          },
        ]).next;
      }
      return s;
    };

    const keyed = trackTo(0, 1.2); // stored roll 0, a channel holds it at 1.2
    expect(resolveEvaluatedParam(keyed, 't', 'roll', ctxAt(0))?.value).toBe(1.2); // render read

    const fold = (s: DagState) => constraintStepFold(s, 't', { in: I }, {}, ctxAt(0), undefined);
    const mKeyed = fold(keyed);
    const mBaked = fold(trackTo(1.2)); // same, with roll baked to the folded value, no channel
    const mRaw = fold(trackTo(0)); // the raw stored roll

    // worldStepFold aimed with the FOLDED roll (== baked), not the stored one (!= raw).
    expect(mKeyed).toEqual(mBaked);
    expect(mKeyed).not.toEqual(mRaw);
  });
});

describe('G3 — the row is derived from the contract, with no kind-branch', () => {
  let m: CrateMockup;
  beforeAll(() => {
    m = buildCrateMockup(buildDefaultDagState());
  });

  it('a modifier lane: no constraint tag, no influence', () => {
    let s = buildDefaultDagState();
    s = applyOps(s, [
      { type: 'addNode', nodeId: 'bd', nodeType: 'BoxData', params: { size: [1, 1, 1] } },
      { type: 'addNode', nodeId: 'bevel', nodeType: 'BevelModifier', params: {} },
      {
        type: 'connect',
        from: { node: 'bd', socket: 'out' },
        to: { node: 'bevel', socket: 'target' },
      },
    ]).next;
    const row = rowOf(stackOf(s, { node: 'bevel', socket: 'out' }), 'bevel');
    const view = layerView(s, row);
    expect(view.tag).toBeNull();
    expect(view.influence).toBeNull();
  });

  it('a constraint lane: the tag comes from section === constraint (not worldStep)', () => {
    const row = rowOf(stackOf(m.state, m.crate), 'aimA');
    expect(layerView(m.state, row).tag).toBe('constraint');
  });

  it('a material lane: a section-material writer draws a plain row', () => {
    let s = buildDefaultDagState();
    s = applyOps(s, [
      { type: 'addNode', nodeId: 'bd', nodeType: 'BoxData', params: { size: [1, 1, 1] } },
      { type: 'addNode', nodeId: 'mat', nodeType: 'MaterialOverrideOp', params: {} },
      {
        type: 'connect',
        from: { node: 'bd', socket: 'out' },
        to: { node: 'mat', socket: 'target' },
      },
    ]).next;
    const row = rowOf(stackOf(s, { node: 'mat', socket: 'out' }), 'mat');
    const view = layerView(s, row);
    expect(view.tag).toBeNull();
    expect(view.influence).toBeNull();
  });

  it('the source names no LAYER KIND — the forbidden list is DERIVED from the registry, so it reds for PoseLayer or any future kind (code, comments stripped)', () => {
    const src = readFileSync(join(__dirname, 'layerView.ts'), 'utf8');
    // Strip block + line comments so the gate reads the CODE, not the prose that explains the ban.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/worldStep/); // the implementation-kind flag G3 forbids
    expect(code).not.toMatch(/\bswitch\b/); // no node-type switch

    // #1927 P1 — the forbidden set is DERIVED, not a hardcoded sample. The old literal list
    // (`TrackTo`, `FollowPath`, …) did not include `PoseLayer`, so a `nodeType === 'PoseLayer'`
    // branch would have passed this gate GREEN — a gate blind to the new kind is not a gate. Here
    // it is every registered node type a stack ROW can BE: a chain declarer (an operator) OR a
    // `mainInput` node (a layer, like `PoseLayer`). So the day someone branches on ANY layer kind,
    // present or future, this reds.
    const layerKinds = listNodeTypes().filter((t) => {
      const def = getNodeType(t);
      return !!def && (def.chain !== undefined || def.mainInput !== undefined);
    });
    // A LANE name is EXCLUDED, not forbidden. `PosedSkeleton` is BOTH a node type AND the pose lane
    // (`LAYER_LANES`), and dispatching on the LANE — a contract field, P0's `rowLaneOf` — is the
    // SANCTIONED mechanism this slice uses; it is not a kind-branch. `Value` is not a layer kind at
    // all (no chain, no mainInput), so the read==render influence read `holder.type === 'Value'`
    // stays untouched — it reads the influence FACTOR's holder, never the row's own kind.
    const forbidden = layerKinds.filter((k) => !(k in LAYER_LANES));
    expect(forbidden).toContain('PoseLayer'); // the kind this slice must never branch on
    expect(forbidden).not.toContain('PosedSkeleton'); // the pose LANE is dispatchable, not forbidden
    for (const kind of forbidden) {
      // A kind-branch reads as a QUOTED literal (`node.type === 'Kind'`, `case 'Kind':`), never a
      // bare substring: an import path (`from '../nodes/PoseLayer'`) or an identifier
      // (`poseLayerWeightOf`) is not a branch and must not red. Match the quoted forms only.
      expect(code).not.toContain(`'${kind}'`);
      expect(code).not.toContain(`"${kind}"`);
    }
  });
});

describe('#1927 P1 — the row speaks the pose vocabulary, dispatched by LANE not kind', () => {
  // A minimal pose layer as a stack row: an `override` layer touching bone `b`, its weight keyed at
  // `weightKey`. Built with no skeleton upstream — `layerView` reads the DECLARED params, not a
  // rendered deform, so a bare layer is enough to read mode/weight/solo.
  const poseRow = (weightKey: number, extra: object = {}) => {
    const s = applyOps(buildDefaultDagState(), [
      {
        type: 'addNode',
        nodeId: 'poseL',
        nodeType: 'PoseLayer',
        params: {
          name: 'L',
          mode: 'override',
          solo: false,
          members: [{ bone: 'b', rotationMode: 'XYZ' }],
          channels: [{ component: 'weight', bone: '', keyframes: [{ time: 0, value: weightKey }] }],
          ...extra,
        },
      },
    ]).next;
    return layerView(s, rowOf(stackOf(s, { node: 'poseL', socket: 'out' }), 'poseL'), ctxAt(0));
  };

  it('mode and solo are read from the layer’s own params; mute still works', () => {
    const v = poseRow(1, { mode: 'additive', solo: true });
    expect(v.pose).not.toBeNull();
    expect(v.pose!.mode).toBe('additive');
    expect(v.pose!.solo).toBe(true);
    expect(v.muted).toBe(false); // the existing mute read is unchanged
  });

  it('weight is read == render: a keyed weight OUTSIDE [0,1] shows what the fold USES, not the raw', () => {
    // `poseLayerWeightOf` is EXACTLY the function the render fold calls for the weight
    // (`PoseLayer.ts:642`), and it is UNCLAMPED (`PoseLayer.ts:459`). Prove the sample reads out of
    // range — this is why an in-[0,1] key could never red: raw and fold-used would be equal.
    const sampleAt = (value: number) =>
      poseLayerWeightOf(
        PoseLayerParamsSchema.parse({
          members: [{ bone: 'b' }],
          channels: [{ component: 'weight', bone: '', keyframes: [{ time: 0, value }] }],
        }),
      )(0);
    expect(sampleAt(1.5)).toBe(1.5); // unclamped raw
    expect(sampleAt(-0.2)).toBe(-0.2); // unclamped raw

    // The render fold clamps that weight to [0,1] (`foldChannelValue`/`clamp01`) and treats weight
    // ≤ 0 as NO contribution (`PoseLayer.ts:677`). Exercised on the real fold: a 0→20 replace folds
    // identically at influence 1.5 and at 1 (both full), and leaves the base at influence −0.2.
    const foldAt = (inf: number) =>
      foldChannelValue(10, [{ value: 20, mode: 'replace', influence: inf }], 'number', 'x');
    expect(foldAt(1.5)).toBe(foldAt(1)); // the fold treats 1.5 as 1
    expect(foldAt(1.5)).toBe(20);
    expect(foldAt(-0.2)).toBe(10); // the fold treats −0.2 as off — base untouched

    // So the row must show the fold-used weight, never the raw sample. GREEN on the fold-used read,
    // able-to-RED on the raw read.
    expect(poseRow(1.5).pose!.weight).toBe(1);
    expect(poseRow(1.5).pose!.weight).not.toBe(1.5); // able-to-red: the raw, unclamped sample
    expect(poseRow(-0.2).pose!.weight).toBe(0); // off
    expect(poseRow(-0.2).pose!.weight).not.toBe(-0.2); // able-to-red: the raw, unclamped sample
  });

  it('a keyed weight INSIDE [0,1] passes through (the fold uses it verbatim)', () => {
    expect(poseRow(0.3).pose!.weight).toBe(0.3);
  });

  it('dispatch is by LANE + param contract, not kind: an operator and a pose-lane CARRIER read null', () => {
    // An operator row is off the pose lane entirely → no pose vocabulary.
    const m = buildCrateMockup(buildDefaultDagState());
    expect(layerView(m.state, rowOf(stackOf(m.state, m.crate), 'aimA')).pose).toBeNull();

    // A `Rig` STANDS ON the `PosedSkeleton` lane (rowLaneOf === PosedSkeleton) yet is a carrier: it
    // declares no mode/weight/solo. The row reads null because the CONTRACT says so — proof the
    // dispatch is not "lane alone" (which would paint 3 carriers) and is not a `nodeType` branch.
    const s = applyOps(buildDefaultDagState(), [
      { type: 'addNode', nodeId: 'rig', nodeType: 'Rig', params: {} },
    ]).next;
    expect(layerView(s, rowOf(stackOf(s, { node: 'rig', socket: 'out' }), 'rig')).pose).toBeNull();
  });
});
