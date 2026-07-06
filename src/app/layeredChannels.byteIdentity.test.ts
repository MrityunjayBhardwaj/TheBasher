// Byte-identity anchor (epic #283 Phase 2) — the falsify gate carried A→E.
//
// The load-bearing NLA guarantee: with ZERO Action/Strip/Track nodes, the layered
// enumeration returns EXACTLY the bare direct-channel enumeration — so an existing
// project (no NLA nodes) folds acc=base, byte-identical to pre-#283. Slice A ships
// this against the stub (which delegates verbatim); Slice C keeps it green via the
// real enumerator's empty-strip-set early return. If this ever goes red, the empty
// set is perturbing the fold — the #274–#281 discipline.
//
// REF: docs/NLA-DESIGN.md §3.1/§4/§6; vyapti V88 D2/D3; RESEARCH.md test infra.

import { describe, it, expect, beforeAll } from 'vitest';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { layeredChannelValues } from './layeredChannels';
import { directChannelValuesForTarget } from './nodeChannels';
import type { KeyframeChannelValue } from '../nodes/types';

beforeAll(() => {
  __reseedAllNodesForTests();
});

const vec3Channel = (
  id: string,
  target: string,
  paramPath: string,
  value: [number, number, number],
) => ({
  id,
  type: 'KeyframeChannelVec3',
  params: { name: paramPath, target, paramPath, keyframes: [{ time: 0, value, easing: 'cubic' }] },
  inputs: {},
});

const numChannel = (id: string, target: string, paramPath: string, value: number) => ({
  id,
  type: 'KeyframeChannelNumber',
  params: { name: paramPath, target, paramPath, keyframes: [{ time: 0, value, easing: 'linear' }] },
  inputs: {},
});

/** A serializable projection of a channel value (its `sample` closure is not
 *  deep-equal-able) — the enumerable fields plus sampled outputs at a few times. */
const project = (v: KeyframeChannelValue) => ({
  kind: v.kind,
  valueType: v.valueType,
  name: v.name,
  target: v.target,
  paramPath: v.paramPath,
  mute: v.mute,
  weight: v.weight,
  blendMode: v.blendMode,
  order: v.order,
  samples: [0, 0.5, 1, 2].map((t) => v.sample(t)),
});

describe('layeredChannelValues — empty NLA set is byte-identical to the bare channel path', () => {
  it('returns exactly the direct-channel enumeration when there are zero Action/Strip/Track nodes', () => {
    const nodes = {
      ch1: vec3Channel('ch1', 'box1', 'position', [1, 2, 3]),
      ch2: numChannel('ch2', 'box1', 'material.base.metalness', 0.7),
      other: vec3Channel('other', 'box2', 'position', [4, 5, 6]),
    };
    const layered = layeredChannelValues(nodes, 'box1').map(project);
    const bare = directChannelValuesForTarget(nodes, 'box1').map(project);
    expect(layered).toEqual(bare);
    // and it actually found the box1 channels (guard against both being empty)
    expect(layered.length).toBe(2);
  });

  it('is empty for a target with no channels and no NLA nodes', () => {
    const nodes = { other: vec3Channel('other', 'box2', 'position', [4, 5, 6]) };
    expect(layeredChannelValues(nodes, 'box1')).toEqual([]);
  });
});
