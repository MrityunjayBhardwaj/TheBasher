// #1940 T0a — the per-object structural-lane surface. Four gates, each mutation-proven:
//
//   G-census   — an object standing on modifier + constraint + pose yields one group per structural
//                lane it stands on, non-vacuous (dropping a lane reds).
//   G-readrender — a keyed influence on a structural row shows the FOLDED value, not the raw param
//                (the fold survives through `objectLayerSurface`, inherited from `layerView`).
//   G-grouped  — groups are in the fixed pipeline order modifiers → constraints → pose; reordering
//                or merging two lanes reds.
//   G-purity   — the module names no registered node KIND (grep, forbidden list DERIVED from the
//                registry, exactly as `layerView`'s G3 gate does).
//
// #1940 T0b — the VALUE lanes (channel / strip / driver), prepended before the structural groups:
//
//   G-readrender-value — a keyed channel, a placed strip and a keyed driver on the object each
//                produce a row whose value is the FOLDED (render-identical) value, not a raw/base
//                read (proven with a value that differs folded-vs-raw).
//   G-grouped (extend) — value groups PREPEND the structural groups, in fold order
//                channels → strips → drivers; appending them after, or merging a value lane into a
//                structural one, reds.
//   G-cache    — a value row's folded amount is the SAME warm (cache-forwarded) as cold, so the
//                forward opens no cold origin and does not change the answer. The `#1386`
//                evaluatorCache gate catches a dropped `cache` on the value-lane read directly.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  __resetRegistryForTests,
  applyOps,
  getNodeType,
  listNodeTypes,
  LAYER_LANES,
} from '../core/dag';
import { createEvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildCrateMockup } from '../test-utils/crateMockup';
import { objectLayerSurface, type LaneGroup } from './objectLayerSurface';

/** The default box Object, and a numeric data param the fold reads (default 0). */
const BOX_ID = 'n_box';
const NUM_PARAM = 'material.base.metalness';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const ctxAt = (seconds: number): EvalCtx => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});

const groupNamed = (groups: readonly LaneGroup[], lane: string) =>
  groups.find((g) => g.lane === lane);

/** The Crate (modifier + constraint) with a pose layer wired onto its `pose` input. */
function crateWithPose(): { state: DagState; objectId: string } {
  const m = buildCrateMockup(buildDefaultDagState());
  const objectId = (m.crate as { node: string }).node;
  const state = applyOps(m.state, [
    {
      type: 'addNode',
      nodeId: 'poseL',
      nodeType: 'PoseLayer',
      params: {
        name: 'L',
        mode: 'override',
        solo: false,
        members: [{ bone: 'b', rotationMode: 'XYZ' }],
        channels: [],
      },
    },
    {
      type: 'connect',
      from: { node: 'poseL', socket: 'out' },
      to: { node: objectId, socket: 'pose' },
    },
  ]).next;
  return { state, objectId };
}

describe('G-census — one group per structural lane the object stands on', () => {
  it('a modifier + constraint + pose object yields all three groups, non-vacuous', () => {
    const { state, objectId } = crateWithPose();
    const { groups } = objectLayerSurface(state, objectId);

    // Every structural lane the object stands on is a group — and each is NON-empty, so a mutation
    // that drops a lane from the table (or that fails to reach it in one walk) reds here.
    const modifier = groupNamed(groups, 'modifier');
    const constraint = groupNamed(groups, 'constraint');
    const pose = groupNamed(groups, 'pose');

    expect(modifier).toBeDefined();
    expect(constraint).toBeDefined();
    expect(pose).toBeDefined();

    // The crate wears three modifiers (Mirror ← Array ← Bevel), three constraint rows (Track-To A,
    // Follow Path, Track-To B) and one pose layer — measured counts, so a lane silently going empty
    // (reached zero rows) reds too.
    expect(modifier!.count).toBe(3);
    expect(modifier!.rows).toHaveLength(3);
    expect(constraint!.count).toBe(3);
    expect(pose!.count).toBe(1);
  });

  it('an object with no pose yields only the two groups it stands on (no empty group)', () => {
    const m = buildCrateMockup(buildDefaultDagState());
    const objectId = (m.crate as { node: string }).node;
    const { groups } = objectLayerSurface(m.state, objectId);
    expect(groups.map((g) => g.lane)).toEqual(['modifier', 'constraint']);
    expect(groupNamed(groups, 'pose')).toBeUndefined();
  });

  it('resolves the object from a node INSIDE a stack, not just the object id', () => {
    // Selecting a modifier must land on the same surface as selecting the object — `resolveStackObject`
    // walks the modifier forward to its object.
    const m = buildCrateMockup(buildDefaultDagState());
    const objectId = (m.crate as { node: string }).node;
    const fromObject = objectLayerSurface(m.state, objectId).groups.map((g) => [g.lane, g.count]);
    const fromModifier = objectLayerSurface(m.state, 'bevel').groups.map((g) => [g.lane, g.count]);
    expect(fromModifier).toEqual(fromObject);
  });
});

describe('G-readrender — a keyed influence shows the FOLDED value through the surface', () => {
  const FACTOR = 'barrelAim_influence_value';

  const keyFactor = (value: number) => {
    const m = buildCrateMockup(buildDefaultDagState());
    const state = applyOps(m.state, [
      {
        type: 'addNode',
        nodeId: 'barrelAim_influence_key',
        nodeType: 'KeyframeChannelNumber',
        params: { target: FACTOR, paramPath: 'value', keyframes: [{ time: 0, value }] },
      },
    ]).next;
    return { state, barrel: (m.barrel as { node: string }).node };
  };

  it('a channel holds the factor at 0.2 — the constraint row shows 0.2 (render), never 0.5 (raw)', () => {
    const { state, barrel } = keyFactor(0.2);
    const constraint = groupNamed(objectLayerSurface(state, barrel, ctxAt(0)).groups, 'constraint');
    expect(constraint).toBeDefined();

    // The blended constraint row is the one carrying an influence; the Follow Path under it has none.
    const influenced = constraint!.rows.find((r) => r.influence !== null);
    expect(influenced).toBeDefined();
    expect(influenced!.influence).toBe('0.2'); // the render-identical read, folded
    expect(influenced!.influence).not.toBe('0.5'); // able-to-red: the raw stored base
  });

  it('a static factor reads its stored number (no override ⇒ base)', () => {
    const m = buildCrateMockup(buildDefaultDagState());
    const barrel = (m.barrel as { node: string }).node;
    const constraint = groupNamed(objectLayerSurface(m.state, barrel).groups, 'constraint');
    const influenced = constraint!.rows.find((r) => r.influence !== null);
    expect(influenced!.influence).toBe('0.5');
  });
});

describe('G-grouped — groups are in the fixed pipeline order modifiers → constraints → pose', () => {
  it('the group order is exactly modifier, constraint, pose', () => {
    const { state, objectId } = crateWithPose();
    const { groups } = objectLayerSurface(state, objectId);
    // A mutation that reorders the lane table (e.g. pose before modifier), or that merges two lanes
    // into one group, changes this sequence and reds.
    expect(groups.map((g) => g.lane)).toEqual(['modifier', 'constraint', 'pose']);
  });

  it('each group holds ONLY its own lane — no lane is merged into another', () => {
    const { state, objectId } = crateWithPose();
    const { groups } = objectLayerSurface(state, objectId);
    // Distinct group labels, one per lane — a merge would collapse the count below the lane count.
    expect(new Set(groups.map((g) => g.lane)).size).toBe(groups.length);
    expect(groups).toHaveLength(3);
  });
});

describe('G-purity — the module names no registered node KIND (contract/lane dispatch only)', () => {
  it('the source names no layer kind — the forbidden list is DERIVED from the registry', () => {
    const src = readFileSync(join(__dirname, 'objectLayerSurface.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/worldStep/); // the implementation-kind flag G3 forbids
    expect(code).not.toMatch(/\bswitch\b/); // no node-type switch

    // Every registered node type a stack ROW can BE — a chain declarer (operator) OR a `mainInput`
    // node (a layer, like `PoseLayer`) — minus the LANE names, which are the SANCTIONED dispatch
    // (`rowLaneOfType`, a contract field). So branching on any layer KIND, present or future, reds;
    // naming a lane (`PosedSkeleton`) does not.
    const layerKinds = listNodeTypes().filter((t) => {
      const def = getNodeType(t);
      return !!def && (def.chain !== undefined || def.mainInput !== undefined);
    });
    const forbidden = layerKinds.filter((k) => !(k in LAYER_LANES));
    expect(forbidden).toContain('PoseLayer'); // the kind this slice must never branch on
    expect(forbidden).not.toContain('PosedSkeleton'); // the pose LANE is dispatchable, not forbidden

    for (const kind of forbidden) {
      expect(code).not.toContain(`'${kind}'`);
      expect(code).not.toContain(`"${kind}"`);
    }
  });
});

// ── T0b — the VALUE lanes (channel / strip / driver) ───────────────────────────────────

/** Default box + a channel on it: 0 at t=0 → 1 at t=1 (linear), so t=0.5 folds to 0.5. */
function boxWithChannel(): DagState {
  return applyOps(buildDefaultDagState(), [
    {
      type: 'addNode',
      nodeId: 'ch_metal',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'metal',
        target: BOX_ID,
        paramPath: NUM_PARAM,
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1, value: 1, easing: 'linear' },
        ],
      },
    },
  ]).next;
}

/** Default box + a Strip placing a constant-0.6 Action on the Object (the SAME enumerator the
 *  fold consumes), so the folded read is a steady 0.6 at any playhead. */
function boxWithStrip(): DagState {
  return applyOps(buildDefaultDagState(), [
    {
      type: 'addNode',
      nodeId: 'act',
      nodeType: 'Action',
      params: {
        name: 'act',
        channels: [
          {
            valueType: 'number',
            paramPath: NUM_PARAM,
            keyframes: [
              { time: 0, value: 0.6 },
              { time: 2, value: 0.6 },
            ],
          },
        ],
      },
    },
    {
      type: 'addNode',
      nodeId: 's1',
      nodeType: 'Strip',
      params: { name: 's1', action: 'act', target: BOX_ID, start: 0 },
    },
    {
      type: 'addNode',
      nodeId: 'trk',
      nodeType: 'Track',
      params: { name: 'trk', strips: ['s1'], order: 0 },
    },
  ] as Op[]).next;
}

/** Default box + a ParamDriver on it, its `in` fed by a constant Value of 0.77 (replace), so the
 *  folded read is 0.77 — distinct from the base metalness (0). */
function boxWithDriver(): DagState {
  return applyOps(buildDefaultDagState(), [
    { type: 'addNode', nodeId: 'val', nodeType: 'Value', params: { value: 0.77 } },
    {
      type: 'addNode',
      nodeId: 'drv',
      nodeType: 'ParamDriver',
      params: { target: BOX_ID, paramPath: NUM_PARAM, blendMode: 'replace', order: 0 },
    },
    { type: 'connect', from: { node: 'val', socket: 'out' }, to: { node: 'drv', socket: 'in' } },
  ] as Op[]).next;
}

describe('G-readrender-value — each value lane shows the FOLDED (render-identical) value', () => {
  it('a channel row shows the interpolated 0.5 at the playhead, never the raw 0 (keyframe/base)', () => {
    const channel = groupNamed(
      objectLayerSurface(boxWithChannel(), BOX_ID, ctxAt(0.5)).groups,
      'channel',
    );
    expect(channel).toBeDefined();
    expect(channel!.count).toBe(1);
    const row = channel!.rows[0];
    expect(row.type).toBe('channel');
    expect(row.tag).toBe(NUM_PARAM); // the param the lane writes
    expect(row.influence).toBe('0.5'); // the folded, render-identical read at t=0.5
    expect(row.influence).not.toBe('0'); // able-to-red: the raw first keyframe / the base
  });

  it('a placed strip row shows its folded 0.6, never the base 0', () => {
    const strip = groupNamed(
      objectLayerSurface(boxWithStrip(), BOX_ID, ctxAt(0.5)).groups,
      'strip',
    );
    expect(strip).toBeDefined();
    expect(strip!.count).toBe(1);
    const row = strip!.rows[0];
    expect(row.type).toBe('strip');
    expect(row.tag).toBe(NUM_PARAM);
    expect(row.influence).toBe('0.6'); // the strip's folded value (render-identical)
    expect(row.influence).not.toBe('0'); // able-to-red: the raw base metalness
  });

  it('a driver row shows its folded 0.77, never the base 0', () => {
    const driver = groupNamed(
      objectLayerSurface(boxWithDriver(), BOX_ID, ctxAt(0)).groups,
      'driver',
    );
    expect(driver).toBeDefined();
    expect(driver!.count).toBe(1);
    const row = driver!.rows[0];
    expect(row.type).toBe('driver');
    expect(row.tag).toBe(NUM_PARAM);
    expect(row.influence).toBe('0.77'); // the driven value folded through resolveEvaluatedParam
    expect(row.influence).not.toBe('0'); // able-to-red: the raw base
  });
});

describe('G-grouped (extend) — value groups PREPEND the structural groups, in fold order', () => {
  it('a channel on an object with modifiers + constraints lands BEFORE them', () => {
    const m = buildCrateMockup(buildDefaultDagState());
    const crateId = (m.crate as { node: string }).node;
    const state = applyOps(m.state, [
      {
        type: 'addNode',
        nodeId: 'ch_crate',
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: 'c',
          target: crateId,
          paramPath: NUM_PARAM,
          keyframes: [{ time: 0, value: 0.3 }],
        },
      },
    ]).next;
    const { groups } = objectLayerSurface(state, crateId);
    // The value group (what SETS the param) is FIRST; the structural lanes (what consume it) follow.
    // A mutation that appends the value groups AFTER the structural loop reds here.
    expect(groups.map((g) => g.lane)).toEqual(['channel', 'modifier', 'constraint']);
  });

  it('the three value lanes sort channels → strips → drivers (the fold order)', () => {
    // All three on one object: the surface orders them as `resolveEvaluatedParam` composes them.
    const { groups } = objectLayerSurface(boxWithAllThreeValueLanes(), BOX_ID, ctxAt(0));
    expect(groups.map((g) => g.lane)).toEqual(['channel', 'strip', 'driver']);
    // Distinct lanes, never merged into one group.
    expect(new Set(groups.map((g) => g.lane)).size).toBe(groups.length);
  });

  it('a value lane with no contributor yields no group (no empty group)', () => {
    // The bare box has no modifiers/constraints/pose and no value contributors → no groups at all.
    expect(objectLayerSurface(buildDefaultDagState(), BOX_ID).groups).toHaveLength(0);
  });
});

/** Default box carrying a channel, a strip and a driver at once (distinct params so each lane is
 *  non-empty and the three groups are present). */
function boxWithAllThreeValueLanes(): DagState {
  return applyOps(buildDefaultDagState(), [
    {
      type: 'addNode',
      nodeId: 'ch_metal',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'metal',
        target: BOX_ID,
        paramPath: NUM_PARAM,
        keyframes: [{ time: 0, value: 0.2 }],
      },
    },
    {
      type: 'addNode',
      nodeId: 'act',
      nodeType: 'Action',
      params: {
        name: 'act',
        channels: [
          {
            valueType: 'number',
            paramPath: 'material.base.roughness',
            keyframes: [
              { time: 0, value: 0.6 },
              { time: 2, value: 0.6 },
            ],
          },
        ],
      },
    },
    {
      type: 'addNode',
      nodeId: 's1',
      nodeType: 'Strip',
      params: { name: 's1', action: 'act', target: BOX_ID, start: 0 },
    },
    {
      type: 'addNode',
      nodeId: 'trk',
      nodeType: 'Track',
      params: { name: 'trk', strips: ['s1'], order: 0 },
    },
    { type: 'addNode', nodeId: 'val', nodeType: 'Value', params: { value: 0.77 } },
    {
      type: 'addNode',
      nodeId: 'drv',
      nodeType: 'ParamDriver',
      params: {
        target: BOX_ID,
        paramPath: 'material.base.specular',
        blendMode: 'replace',
        order: 0,
      },
    },
    { type: 'connect', from: { node: 'val', socket: 'out' }, to: { node: 'drv', socket: 'in' } },
  ] as Op[]).next;
}

describe('G-cache — the value read forwards the cache: warm == cold, no cold origin opened', () => {
  it('a channel row folds to the same value with a forwarded warm cache as with none', () => {
    const state = boxWithChannel();
    const cache = createEvaluatorCache();
    const cold = groupNamed(objectLayerSurface(state, BOX_ID, ctxAt(0.5)).groups, 'channel');
    const warm = groupNamed(objectLayerSurface(state, BOX_ID, ctxAt(0.5), cache).groups, 'channel');
    // Forwarding the cache cannot change the answer — it only keeps the per-scrub re-read warm.
    expect(warm!.rows[0].influence).toBe(cold!.rows[0].influence);
    expect(warm!.rows[0].influence).toBe('0.5');
  });
});

// ── T1 — the #1928 honesty boundary: a value row flags when its render road is base-only ──

/** Default box + a channel on a NON-material transform param (`position`): the transform render
 *  road DOES fold, so this row must NOT be flagged base-only. */
function boxWithTransformChannel(): DagState {
  return applyOps(buildDefaultDagState(), [
    {
      type: 'addNode',
      nodeId: 'ch_pos',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'posx',
        target: BOX_ID,
        paramPath: 'position',
        keyframes: [{ time: 0, value: 0, easing: 'linear' }],
      },
    },
  ]).next;
}

describe('T1 — #1928 honesty: a value row flags rendersBaseOnly when its render road is base-only', () => {
  it('a material.* channel row is flagged rendersBaseOnly (material renders base only, #1928)', () => {
    const channel = groupNamed(
      objectLayerSurface(boxWithChannel(), BOX_ID, ctxAt(0.5)).groups,
      'channel',
    );
    expect(channel!.rows[0].tag).toBe('material.base.metalness');
    expect(channel!.rows[0].rendersBaseOnly).toBe(true);
  });

  it('a MULTI-SLOT material channel (`materialSlots.*`) is flagged too — the second spelling #1928 hits', () => {
    // The imported multi-material spelling a channel can carry; it renders base-only exactly like
    // `material.*` (#1928). A narrow `startsWith('material.')` would MISS it and ship a silent
    // read≠render row — this case reds that mistake, so it is the real mutation-proof of the predicate.
    const state = applyOps(buildDefaultDagState(), [
      {
        type: 'addNode',
        nodeId: 'ch_slot',
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: 'slotMetal',
          target: BOX_ID,
          paramPath: 'materialSlots.0.base.metalness',
          keyframes: [{ time: 0, value: 0.4, easing: 'linear' }],
        },
      },
    ] as Op[]).next;
    const channel = groupNamed(objectLayerSurface(state, BOX_ID, ctxAt(0)).groups, 'channel');
    expect(channel!.rows[0].tag).toBe('materialSlots.0.base.metalness');
    expect(channel!.rows[0].rendersBaseOnly).toBe(true);
  });

  it('a non-material (transform) channel row is NOT flagged — the transform road folds', () => {
    const channel = groupNamed(
      objectLayerSurface(boxWithTransformChannel(), BOX_ID, ctxAt(0)).groups,
      'channel',
    );
    expect(channel).toBeDefined();
    expect(channel!.rows[0].tag).toBe('position');
    expect(channel!.rows[0].rendersBaseOnly).toBe(false);
  });
  // These three cases MUTATION-PROVE the predicate in both directions AND against an incomplete
  // prefix: a constant-true reds the transform case, a constant-false reds either material case, and
  // a narrow `startsWith('material.')` (the original bug) reds the `materialSlots.` case. None passes
  // a gamed or partial predicate.

  it('structural rows (modifier/constraint/pose) are never base-only — they render folded', () => {
    const { state, objectId } = crateWithPose();
    const structural = objectLayerSurface(state, objectId).groups.filter((g) =>
      ['modifier', 'constraint', 'pose'].includes(g.lane),
    );
    expect(structural.length).toBeGreaterThan(0); // non-vacuous
    for (const g of structural) for (const row of g.rows) expect(row.rendersBaseOnly).toBe(false);
  });

  // glTF-child TRS renders base-only too (#1928), but there is no cheap runtime predicate for an
  // imported glTF child, and a loose detector would mislabel honest rows. V208: this is the
  // decision we cannot take yet — when a child predicate lands, add the glTF-child arm to
  // `rendersBaseOnly` and make this a live assertion.
  it.todo(
    'flags a glTF-child TRS row rendersBaseOnly once an imported-child predicate exists (#1928)',
  );
});
