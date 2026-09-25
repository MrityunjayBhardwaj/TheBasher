// #1066 — a keyframe channel's target and path pickers, on subjects built by the product's own
// Add builders. The both-ways property over a whole scene is gate row 20
// (`paramWidgetDeclaration.gate.test.ts`); these rows pin the cases the issue names and the
// words each refusal shows.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import {
  channelPathLockOf,
  channelPathOptionsOf,
  installChannelPickers,
  PICKERS_NOT_INSTALLED,
} from '../nodes/channelPickerSlot';
import { buildAddPrimitiveOps, type PrimitiveKind } from './addPrimitives';
import { buildAddConstraintOps } from './constraintStack';
import { buildNewMaterialOps } from './materialLink';
import { buildAddModifierOps } from './operatorStack';
import {
  channelPathLock,
  channelPathOptions,
  channelTargetOptions,
  expandPathPattern,
} from './channelPickers';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (s: DagState, ops: readonly Op[]) => {
  let n = s;
  for (const op of ops) n = applyOp(n, op).next;
  return n;
};

function place(state: DagState, kind: PrimitiveKind) {
  const r = buildAddPrimitiveOps(state, kind, [0, 0, 0])!;
  return { s: apply(state, r.ops), obj: r.newNodeId, data: r.dataNodeId ?? r.newNodeId };
}

function withChannel(s: DagState, type: string, target: string, paramPath: string) {
  return apply(s, [
    { type: 'addNode', nodeId: 'ch', nodeType: type, params: { target, paramPath } },
  ]);
}

const enabled = (options: readonly { value: string; disabledReason?: string }[]) =>
  options.filter((o) => !o.disabledReason).map((o) => o.value);
const reasonOf = (options: readonly { value: string; disabledReason?: string }[], v: string) =>
  options.find((o) => o.value === v)?.disabledReason;

describe('channel pickers — the rows #1066 names', () => {
  it("a light's intensity is offered to a number channel and not to a colour channel", () => {
    const spot = place(buildDefaultDagState(), 'SpotLight');
    const number = withChannel(spot.s, 'KeyframeChannelNumber', spot.data, '');
    expect(enabled(channelPathOptions(number, 'ch', 'number'))).toContain('intensity');
    const color = withChannel(spot.s, 'KeyframeChannelColor', spot.data, '');
    expect(enabled(channelPathOptions(color, 'ch', 'color'))).not.toContain('intensity');
  });

  it('a material colour path is offered to a colour channel, on the node that owns it', () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    const s = withChannel(cube.s, 'KeyframeChannelColor', cube.data, '');
    expect(enabled(channelPathOptions(s, 'ch', 'color'))).toContain('material.base.color');
    // The Object owns placement, not colour: it is no colour target (the data node is).
    const targets = channelTargetOptions(s, 'ch', 'color');
    expect(enabled(targets)).toContain(cube.data);
    expect(targets.map((t) => t.value)).not.toContain(cube.obj);
  });

  it('a split object: the data node yields its data params, the Object its transform', () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    const onData = withChannel(cube.s, 'KeyframeChannelVec3', cube.data, '');
    expect(enabled(channelPathOptions(onData, 'ch', 'vec3'))).toContain('size');
    expect(enabled(channelPathOptions(onData, 'ch', 'vec3'))).not.toContain('position');
    const onObj = withChannel(cube.s, 'KeyframeChannelVec3', cube.obj, '');
    expect(enabled(channelPathOptions(onObj, 'ch', 'vec3'))).toEqual(
      expect.arrayContaining(['position', 'rotation', 'scale']),
    );
  });

  it('changing the target re-derives the list, and a path the new target lacks says why', () => {
    const spot = place(buildDefaultDagState(), 'SpotLight');
    const point = place(spot.s, 'PointLight');
    const onSpot = withChannel(point.s, 'KeyframeChannelNumber', spot.data, 'angle');
    expect(reasonOf(channelPathOptions(onSpot, 'ch', 'number'), 'angle')).toBeUndefined();
    const onPoint = apply(onSpot, [
      { type: 'setParam', nodeId: 'ch', paramPath: 'target', value: point.data },
    ]);
    const paths = channelPathOptions(onPoint, 'ch', 'number');
    // Listed, not "not found": a point light has no cone, and the row says so.
    expect(reasonOf(paths, 'angle')).toBe('nothing drawn changes');
    expect(enabled(paths)).toContain('intensity');
    // And the target list, read with the path still set, disables the point light for it.
    expect(reasonOf(channelTargetOptions(onPoint, 'ch', 'number'), point.data)).toMatch(
      /angle does not animate here — clear the path/,
    );
  });
});

describe('channel pickers — what the census cannot answer is listed with its reason', () => {
  it("a Track-To's aim point is read raw: listed, disabled, never offered", () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    const tt = buildAddConstraintOps(cube.s, cube.obj, 'TrackTo')!;
    const s = withChannel(
      apply(cube.s, tt.ops),
      'KeyframeChannelVec3',
      tt.constraintId,
      'aimPoint',
    );
    expect(reasonOf(channelPathOptions(s, 'ch', 'vec3'), 'aimPoint')).toBe('nothing drawn changes');
    // And since no vec3 param of a Track-To draws, the panel shows the path read-only.
    expect(channelPathLock(s, 'ch', 'vec3')).toBe('no vec3 param of TrackTo animates');
  });

  it('a data node under an operator stack: its path is read-only with the reason', () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    const s = withChannel(
      apply(cube.s, buildAddModifierOps(cube.s, cube.data, 'UVProjectModifier')!.ops),
      'KeyframeChannelVec3',
      cube.data,
      'size',
    );
    // The reason names the context itself, not whichever path happened to be asked first.
    expect(channelPathLock(s, 'ch', 'vec3')).toMatch(/^under an operator stack.*#1247/);
    expect(reasonOf(channelTargetOptions(s, 'ch', 'vec3'), cube.data)).toMatch(/#1247/);
  });

  it('a linked Material owns the colour: the cube is listed, disabled, naming the owner', () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    const mat = buildNewMaterialOps(cube.s, cube.data)!;
    const s = withChannel(apply(cube.s, mat.ops), 'KeyframeChannelColor', '', '');
    expect(reasonOf(channelTargetOptions(s, 'ch', 'color'), cube.data)).toContain(
      `${mat.materialNodeId}.material.base.color supplies it`,
    );
  });

  it('"never measured" and "measured, nothing animates" read differently', () => {
    let s = buildDefaultDagState();
    s = apply(s, [{ type: 'addNode', nodeId: 'shot', nodeType: 'Shot', params: {} }]);
    expect(
      channelPathLock(withChannel(s, 'KeyframeChannelNumber', 'shot', ''), 'ch', 'number'),
    ).toBe('the census has not measured Shot');
    const spot = place(buildDefaultDagState(), 'SpotLight');
    expect(
      channelPathLock(withChannel(spot.s, 'KeyframeChannelColor', spot.obj, ''), 'ch', 'color'),
    ).toBe('no color param of Object<LightData:Spot> animates');
  });

  it('a text channel on a scene node: only a ComfyUI workflow reads text', () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    const s = withChannel(cube.s, 'KeyframeChannelText', cube.data, '');
    expect(channelPathLock(s, 'ch', 'text')).toBe('only a ComfyUI workflow reads a text channel');
  });
});

describe('the slot the channel schemas ask fails closed', () => {
  afterEach(() =>
    installChannelPickers({
      targetOptions: channelTargetOptions,
      pathOptions: channelPathOptions,
      pathLock: channelPathLock,
    }),
  );

  it('with nothing installed, the path is read-only and says why — never an empty "nothing"', () => {
    const spot = place(buildDefaultDagState(), 'SpotLight');
    const s = withChannel(spot.s, 'KeyframeChannelNumber', spot.data, '');
    expect(channelPathLockOf('number')(s, 'ch')).toBeNull();
    installChannelPickers(null);
    expect(channelPathLockOf('number')(s, 'ch')).toBe(PICKERS_NOT_INSTALLED);
    expect(channelPathOptionsOf('number')(s, 'ch')).toEqual([]);
  });
});

describe('expandPathPattern', () => {
  it('turns every * into each index the params hold, and drops what is not there', () => {
    const params = { points: [{ co: [0, 0, 0] }, { co: [1, 1, 1] }, {}], name: 'c' };
    expect(expandPathPattern(params, 'points.*.co')).toEqual(['points.0.co', 'points.1.co']);
    expect(expandPathPattern(params, 'name')).toEqual(['name']);
    expect(expandPathPattern(params, 'missing.*')).toEqual([]);
  });
});
