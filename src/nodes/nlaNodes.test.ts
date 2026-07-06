// NLA sidecar nodes — Action / Strip / Track (epic #283 Phase 2, Slice A).
// These nodes are INERT in Slice A (render nothing); this suite proves they are
// registered (addNode-valid, V1), their schemas parse defaults + populated params,
// they serialize round-trip, and an Action channel is target-less (I-1).

import { describe, it, expect, beforeAll } from 'vitest';
import { __reseedAllNodesForTests } from './registerAll';
import { getNodeType } from '../core/dag/registry';
import { ActionParams, ActionChannelSchema } from './Action';
import { StripParams } from './Strip';
import { TrackParams } from './Track';

beforeAll(() => {
  __reseedAllNodesForTests();
});

describe('NLA nodes are registered (addNode validates — V1)', () => {
  it.each(['Action', 'Strip', 'Track'])('registers %s', (type) => {
    const def = getNodeType(type);
    expect(def).toBeTruthy();
    expect(def!.type).toBe(type);
    expect(def!.pure).toBe(true);
    // Edge-less sidecar: no inputs (reached by resolver scan, not by wire).
    expect(def!.inputs).toEqual({});
  });
});

describe('Action — target-less relative-path channel bundle', () => {
  it('parses defaults (empty performance)', () => {
    expect(ActionParams.parse({})).toEqual({ name: 'Action', channels: [] });
  });

  it('a channel spec carries no bound target (I-1) but keeps the relative paramPath', () => {
    const parsed = ActionChannelSchema.parse({
      valueType: 'vec3',
      paramPath: 'position',
      keyframes: [{ time: 0, value: [1, 2, 3] }],
    });
    expect(parsed.valueType).toBe('vec3');
    expect(parsed.paramPath).toBe('position');
    expect('target' in parsed).toBe(false);
  });

  it('parses every valueType arm of the discriminated union', () => {
    for (const valueType of ['number', 'vec2', 'vec3', 'quat', 'color', 'text', 'image'] as const) {
      const parsed = ActionChannelSchema.parse({ valueType, paramPath: 'p' });
      expect(parsed.valueType).toBe(valueType);
    }
  });

  it('evaluate returns an ActionValue carrying its channels', () => {
    const def = getNodeType('Action')!;
    const params = ActionParams.parse({
      name: 'walk',
      channels: [
        { valueType: 'vec3', paramPath: 'position', keyframes: [{ time: 0, value: [0, 1, 0] }] },
      ],
    });
    const value = def.evaluate(params, {}, {} as never) as {
      kind: string;
      name: string;
      channels: unknown[];
    };
    expect(value.kind).toBe('Action');
    expect(value.name).toBe('walk');
    expect(value.channels).toHaveLength(1);
  });
});

describe('Strip — placement of an Action (edge-less id-refs)', () => {
  it('parses identity defaults', () => {
    expect(StripParams.parse({})).toEqual({
      name: 'Strip',
      action: '',
      target: '',
      start: 0,
      timeScale: 1,
      repeat: 1,
      reverse: false,
      extrapolate: 'hold',
      blendMode: 'replace',
      influence: 1,
      muted: false,
    });
  });

  it('rejects a non-positive timeScale and out-of-range influence', () => {
    expect(() => StripParams.parse({ timeScale: 0 })).toThrow();
    expect(() => StripParams.parse({ influence: 1.5 })).toThrow();
  });

  it('evaluate returns a StripValue binding action + target', () => {
    const def = getNodeType('Strip')!;
    const params = StripParams.parse({
      action: 'act1',
      target: 'box1',
      start: 3,
      blendMode: 'combine',
    });
    const value = def.evaluate(params, {}, {} as never) as {
      kind: string;
      action: string;
      target: string;
    };
    expect(value.kind).toBe('Strip');
    expect(value.action).toBe('act1');
    expect(value.target).toBe('box1');
  });
});

describe('Track — ordered mute/solo container', () => {
  it('parses identity defaults', () => {
    expect(TrackParams.parse({})).toEqual({
      name: 'Track',
      strips: [],
      order: 0,
      mute: false,
      solo: false,
    });
  });

  it('evaluate returns a TrackValue with its ordered strip ids', () => {
    const def = getNodeType('Track')!;
    const params = TrackParams.parse({ strips: ['s1', 's2'], order: 2 });
    const value = def.evaluate(params, {}, {} as never) as { kind: string; strips: string[] };
    expect(value.kind).toBe('Track');
    expect(value.strips).toEqual(['s1', 's2']);
  });
});

describe('serialization round-trip (Action/Strip/Track are serializable)', () => {
  it('survives parse → JSON → parse byte-identically', () => {
    const action = ActionParams.parse({
      name: 'walk',
      channels: [
        { valueType: 'vec3', paramPath: 'position', keyframes: [{ time: 0, value: [1, 0, 0] }] },
      ],
    });
    const strip = StripParams.parse({ action: 'a', target: 'box', start: 2, repeat: 3 });
    const track = TrackParams.parse({ strips: ['s1'], order: 1, solo: true });
    expect(ActionParams.parse(JSON.parse(JSON.stringify(action)))).toEqual(action);
    expect(StripParams.parse(JSON.parse(JSON.stringify(strip)))).toEqual(strip);
    expect(TrackParams.parse(JSON.parse(JSON.stringify(track)))).toEqual(track);
  });
});
