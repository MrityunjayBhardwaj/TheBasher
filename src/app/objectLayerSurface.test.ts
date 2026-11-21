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
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildCrateMockup } from '../test-utils/crateMockup';
import { objectLayerSurface, type LaneGroup } from './objectLayerSurface';

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
    { type: 'connect', from: { node: 'poseL', socket: 'out' }, to: { node: objectId, socket: 'pose' } },
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
