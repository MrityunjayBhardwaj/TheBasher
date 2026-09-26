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
  driverPathLockOf,
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
  driverKindsOf,
  driverPathLock,
  driverPathOptions,
  driverTargetOptions,
  expandPathPattern,
} from './channelPickers';
import { comfyParamPath, importComfyGraph } from '../core/comfy/comfyGraph';
import { bakeComfyBatchedTracks } from './video/compileComfyBatch';
import { buildSpringOps } from './solverBind';

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

  it('a path the census says animates, on a node holding no value there, says so', () => {
    const spot = place(buildDefaultDagState(), 'SpotLight');
    // Minted by hand: the builders always fill intensity, but a node is params, and a list
    // built from held values must not read a missing one as "animates".
    const params = { ...(spot.s.nodes[spot.data].params as Record<string, unknown>) };
    delete params.intensity;
    const bare = {
      ...spot.s,
      nodes: { ...spot.s.nodes, [spot.data]: { ...spot.s.nodes[spot.data], params } },
    } as DagState;
    const s = withChannel(bare, 'KeyframeChannelNumber', spot.data, 'intensity');
    expect(reasonOf(channelPathOptions(s, 'ch', 'number'), 'intensity')).toBe(
      'this node holds no value at intensity',
    );
  });

  it('a text channel on a scene node: only a ComfyUI workflow reads text', () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    const s = withChannel(cube.s, 'KeyframeChannelText', cube.data, '');
    expect(channelPathLock(s, 'ch', 'text')).toBe('only a ComfyUI workflow reads a text channel');
  });
});

function withDriver(
  s: DagState,
  target: string,
  paramPath: string,
  source: Record<string, unknown>,
) {
  return apply(s, [
    {
      type: 'addNode',
      nodeId: 'drv',
      nodeType: 'ParamDriver',
      params: { target, paramPath, ...source },
    },
  ]);
}

describe('ParamDriver pickers — the census driver answers, of the source kind (#1258)', () => {
  it("a camera's fov is offered to a number channel, and not to a driver", () => {
    const cam = place(buildDefaultDagState(), 'PerspectiveCamera');
    const s = withChannel(cam.s, 'KeyframeChannelNumber', cam.data, '');
    expect(enabled(channelPathOptions(s, 'ch', 'number'))).toContain('fov');
    // The camera pose reads bare channels only (#1266): the census measured a driver on fov
    // move nothing, so the row is listed with that answer, never offered.
    const d = withDriver(cam.s, cam.data, 'fov', {});
    expect(enabled(driverPathOptions(d, 'drv'))).not.toContain('fov');
    expect(reasonOf(driverPathOptions(d, 'drv'), 'fov')).toBe('nothing drawn changes');
  });

  it("a driver's kind is its source's: a Point controller lists vec3 paths only", () => {
    const sphere = place(buildDefaultDagState(), 'Sphere');
    const ctl = place(sphere.s, 'Null');
    const point = withDriver(ctl.s, sphere.obj, '', { sourceTransformVec: { node: ctl.obj } });
    expect(driverKindsOf(point, 'drv')).toEqual(['vec3']);
    expect(enabled(driverPathOptions(point, 'drv'))).toEqual(
      expect.arrayContaining(['position', 'scale']),
    );
    const onData = withDriver(ctl.s, sphere.data, '', { sourceTransformVec: { node: ctl.obj } });
    expect(enabled(driverPathOptions(onData, 'drv'))).not.toContain('radius');
    // The same data node through a transform channel (a number) offers the radius.
    const scalar = withDriver(ctl.s, sphere.data, '', {
      sourceTransform: { node: ctl.obj, channel: 'tx' },
    });
    expect(driverKindsOf(scalar, 'drv')).toEqual(['number']);
    expect(enabled(driverPathOptions(scalar, 'drv'))).toContain('radius');
  });

  it('a spring reads as a vec3: its Solver feeds the driver a Vector3', () => {
    const sphere = place(buildDefaultDagState(), 'Sphere');
    const ctl = place(sphere.s, 'Null');
    const spring = buildSpringOps(ctl.s, {
      targetId: sphere.obj,
      controllerId: ctl.obj,
      idFor: (k) => `spring_${k}`,
    });
    expect(spring.ok).toBe(true);
    const s = apply(ctl.s, spring.ok ? spring.ops : []);
    const driver = Object.values(s.nodes).find((n) => n.type === 'ParamDriver')!.id;
    expect(driverKindsOf(s, driver)).toEqual(['vec3']);
    expect(enabled(driverPathOptions(s, driver))).toContain('position');
    expect(enabled(driverPathOptions(s, driver))).not.toContain('radius');
  });

  it('a camera data node: the path is read-only, saying no param moves for a driver', () => {
    const cam = place(buildDefaultDagState(), 'PerspectiveCamera');
    expect(driverPathLock(withDriver(cam.s, cam.data, 'fov', {}), 'drv')).toBe(
      'a driver moves no number or vec3 param of CameraData:Perspective',
    );
  });

  it('a driver does not count itself as "something else supplies it"', () => {
    const spot = place(buildDefaultDagState(), 'SpotLight');
    const d = withDriver(spot.s, spot.data, 'intensity', {});
    expect(reasonOf(driverPathOptions(d, 'drv'), 'intensity')).toBeUndefined();
    // A second driver on the same band is something else.
    const two = apply(d, [
      {
        type: 'addNode',
        nodeId: 'other',
        nodeType: 'ParamDriver',
        params: { target: spot.data, paramPath: 'intensity' },
      },
    ]);
    expect(reasonOf(driverPathOptions(two, 'drv'), 'intensity')).toMatch(/a driver supplies it/);
  });

  it('a ComfyUI workflow is a driver target: its batch folds drivers as it folds channels', () => {
    const META = { name: 'w', importedAt: 'fixed', fps: 30, frames: 24 };
    const api = {
      '3': { class_type: 'KSampler', inputs: { cfg: 6.5, denoise: 1 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cube' } },
    };
    const ctl = place(buildDefaultDagState(), 'Null');
    const s = apply(ctl.s, [
      {
        type: 'addNode',
        nodeId: 'wf',
        nodeType: 'ComfyUIWorkflow',
        params: { graph: importComfyGraph(api, META) },
      },
    ]);
    const cfg = comfyParamPath('3', 'cfg');
    const bakedCfg = (st: DagState) =>
      bakeComfyBatchedTracks(st, 'wf', importComfyGraph(api, META), 0, 3, 30, 4).find(
        (t) => comfyParamPath(t.nodeId, t.inputName) === cfg,
      )?.values;
    // Observed, not assumed: a driver writing 3 onto cfg bakes 3 where the input says 6.5.
    const driven = withDriver(s, 'wf', cfg, {
      sourceTransform: {
        node: ctl.obj,
        channel: 'tx',
        remap: { inMin: 0, inMax: 1, outMin: 3, outMax: 3 },
      },
    });
    expect({ undriven: bakedCfg(s), driven: bakedCfg(driven) }).toEqual({
      undriven: [6.5, 6.5, 6.5, 6.5],
      driven: [3, 3, 3, 3],
    });
    expect(enabled(driverTargetOptions(withDriver(s, '', '', {}), 'drv'))).toContain('wf');
    const paths = driverPathOptions(driven, 'drv');
    expect(enabled(paths)).toContain(cfg);
    // A driver carries no text, so the prompt is not a path it can take.
    expect(enabled(paths)).not.toContain(comfyParamPath('6', 'text'));
  });
});

describe('the slot the channel schemas ask fails closed', () => {
  afterEach(() =>
    installChannelPickers({
      targetOptions: channelTargetOptions,
      pathOptions: channelPathOptions,
      pathLock: channelPathLock,
      driverTargetOptions,
      driverPathOptions,
      driverPathLock,
    }),
  );

  it('with nothing installed, the path is read-only and says why — never an empty "nothing"', () => {
    const spot = place(buildDefaultDagState(), 'SpotLight');
    const s = withChannel(spot.s, 'KeyframeChannelNumber', spot.data, '');
    expect(channelPathLockOf('number')(s, 'ch')).toBeNull();
    installChannelPickers(null);
    expect(channelPathLockOf('number')(s, 'ch')).toBe(PICKERS_NOT_INSTALLED);
    expect(channelPathOptionsOf('number')(s, 'ch')).toEqual([]);
    // The driver's path reads the same slot and fails closed the same way.
    const d = withDriver(spot.s, spot.data, '', {});
    expect(driverPathLockOf()(d, 'drv')).toBe(PICKERS_NOT_INSTALLED);
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
