import { describe, it, expect, beforeAll } from 'vitest';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import {
  directChannelNodesForTarget,
  channelValuesFromNodes,
  directChannelValuesForTarget,
  directChannelTargetSet,
  animatedAncestorSet,
} from './nodeChannels';

beforeAll(() => {
  __reseedAllNodesForTests();
});

// A KeyframeChannelNumber node targeting `target.paramPath` with one key.
const numChannel = (id: string, target: string, paramPath: string, value: number) => ({
  id,
  type: 'KeyframeChannelNumber',
  params: {
    name: paramPath,
    target,
    paramPath,
    keyframes: [{ time: 0, value, easing: 'linear' }],
  },
  inputs: {},
});

const vec3Channel = (
  id: string,
  target: string,
  paramPath: string,
  value: [number, number, number],
) => ({
  id,
  type: 'KeyframeChannelVec3',
  params: {
    name: paramPath,
    target,
    paramPath,
    keyframes: [{ time: 0, value, easing: 'cubic' }],
  },
  inputs: {},
});

describe('directChannelNodesForTarget — free-floating channels for a node (#197)', () => {
  it('finds channels whose params.target matches', () => {
    const nodes = {
      ch1: numChannel('ch1', 'box1', 'material.base.metalness', 0.7),
      ch2: vec3Channel('ch2', 'box1', 'position', [1, 2, 3]),
      other: numChannel('other', 'box2', 'material.base.roughness', 0.3),
    };
    const found = directChannelNodesForTarget(nodes, 'box1')
      .map((n) => n.id)
      .sort();
    expect(found).toEqual(['ch1', 'ch2']);
  });

  it('excludes channels with zero keyframes', () => {
    const empty = numChannel('empty', 'box1', 'position', 0);
    empty.params.keyframes = [];
    const found = directChannelNodesForTarget({ empty }, 'box1');
    expect(found).toEqual([]);
  });

  it('returns [] for an empty targetId', () => {
    const nodes = { ch1: numChannel('ch1', 'box1', 'position', 1) };
    expect(directChannelNodesForTarget(nodes, '')).toEqual([]);
  });
});

describe('channelValuesFromNodes — build sampling values via each node evaluate', () => {
  it('builds a KeyframeChannelValue with a working sample() and the right paramPath', () => {
    const nodes = directChannelNodesForTarget(
      { ch: numChannel('ch', 'box1', 'material.base.metalness', 0.9) },
      'box1',
    );
    const values = channelValuesFromNodes(nodes);
    expect(values).toHaveLength(1);
    expect(values[0].paramPath).toBe('material.base.metalness');
    expect(values[0].valueType).toBe('number');
    expect(values[0].sample(0)).toBeCloseTo(0.9);
  });

  it('builds vec3 channel values (cubic) with sample()', () => {
    const nodes = directChannelNodesForTarget(
      { ch: vec3Channel('ch', 'box1', 'position', [4, 5, 6]) },
      'box1',
    );
    const values = channelValuesFromNodes(nodes);
    expect(values[0].valueType).toBe('vec3');
    expect(values[0].sample(0)).toEqual([4, 5, 6]);
  });

  describe('per-channel SOLO filter (#263 — per-target, the render==read choke point)', () => {
    // A solo'd vec3 channel (solo lives on params, surfaced into the value by evaluate).
    const soloVec3 = (id: string, paramPath: string, value: [number, number, number]) => {
      const n = vec3Channel(id, 'box1', paramPath, value);
      return { ...n, params: { ...n.params, solo: true } };
    };

    it('no channel solo → ALL contribute (byte-identical to pre-solo)', () => {
      const nodes = directChannelNodesForTarget(
        {
          a: numChannel('a', 'box1', 'material.base.metalness', 0.9),
          b: vec3Channel('b', 'box1', 'position', [1, 2, 3]),
        },
        'box1',
      );
      expect(channelValuesFromNodes(nodes)).toHaveLength(2);
    });

    it('any solo on the target → ONLY solo channels contribute (the rest gated like mute)', () => {
      const nodes = directChannelNodesForTarget(
        {
          a: numChannel('a', 'box1', 'scale', 2), // non-solo sibling → dropped
          b: soloVec3('b', 'position', [1, 2, 3]),
        },
        'box1',
      );
      const values = channelValuesFromNodes(nodes);
      expect(values).toHaveLength(1);
      expect(values[0].paramPath).toBe('position');
      expect(values[0].solo).toBe(true);
    });

    it('multiple solo channels all contribute', () => {
      const nodes = directChannelNodesForTarget(
        { a: soloVec3('a', 'position', [1, 2, 3]), b: soloVec3('b', 'scale', [2, 2, 2]) },
        'box1',
      );
      expect(channelValuesFromNodes(nodes)).toHaveLength(2);
    });
  });
});

describe('directChannelValuesForTarget — the one-shot read-side form', () => {
  it('returns the built values for every channel targeting the node', () => {
    const nodes = {
      ch1: numChannel('ch1', 'box1', 'material.base.roughness', 0.25),
      ch2: vec3Channel('ch2', 'box1', 'scale', [2, 2, 2]),
      other: numChannel('other', 'box2', 'position', 1),
    };
    const values = directChannelValuesForTarget(nodes, 'box1');
    const paths = values.map((v) => v.paramPath).sort();
    expect(paths).toEqual(['material.base.roughness', 'scale']);
  });
});

describe('directChannelTargetSet — one-pass membership for the renderer (#197)', () => {
  it('collects every node id with a free-floating direct channel', () => {
    const nodes = {
      ch1: numChannel('ch1', 'box1', 'material.base.metalness', 0.5),
      ch2: vec3Channel('ch2', 'box2', 'position', [1, 1, 1]),
      empty: numChannel('empty', 'box3', 'position', 0),
    };
    nodes.empty.params.keyframes = [];
    const set = directChannelTargetSet(nodes);
    expect(set.has('box1')).toBe(true);
    expect(set.has('box2')).toBe(true);
    expect(set.has('box3')).toBe(false); // zero keyframes → not animated
  });
});

describe('animatedAncestorSet — nodes under an animated ancestor (#242 / H132 GAP 1)', () => {
  // A Group node referencing children via the `children` input socket.
  const group = (id: string, children: string[]) => ({
    id,
    type: 'Group',
    params: {},
    inputs: { children: children.map((node) => ({ node, socket: 'out' })) },
  });
  // A Transform node referencing one child via the `target` socket.
  const transform = (id: string, target: string) => ({
    id,
    type: 'Transform',
    params: {},
    inputs: { target: { node: target, socket: 'out' } },
  });
  const leaf = (id: string) => ({ id, type: 'BoxMesh', params: {}, inputs: {} });

  it('marks a node whose parent Group is animated', () => {
    const nodes = {
      grp: group('grp', ['cam']),
      cam: leaf('cam'),
    };
    const out = animatedAncestorSet(nodes, new Set(['grp']));
    expect(out.has('cam')).toBe(true);
    expect(out.has('grp')).toBe(false); // the animated node itself is not its own ancestor
  });

  it('walks MULTIPLE levels up (animated grandparent)', () => {
    const nodes = {
      outer: group('outer', ['inner']),
      inner: group('inner', ['cam']),
      cam: leaf('cam'),
    };
    const out = animatedAncestorSet(nodes, new Set(['outer']));
    expect(out.has('cam')).toBe(true);
    expect(out.has('inner')).toBe(true);
  });

  it('follows the Transform `target` socket too (mirrors childEdges)', () => {
    const nodes = {
      xf: transform('xf', 'cam'),
      cam: leaf('cam'),
    };
    const out = animatedAncestorSet(nodes, new Set(['xf']));
    expect(out.has('cam')).toBe(true);
  });

  it('does NOT mark a node with only static ancestors', () => {
    const nodes = {
      grp: group('grp', ['cam']),
      cam: leaf('cam'),
    };
    const out = animatedAncestorSet(nodes, new Set()); // nothing animated
    expect(out.has('cam')).toBe(false);
  });

  it('terminates on a malformed cyclic graph (cycle guard)', () => {
    const nodes = {
      a: group('a', ['b']),
      b: group('b', ['a']),
    };
    // No infinite loop; neither is animated so neither is marked.
    const out = animatedAncestorSet(nodes, new Set());
    expect(out.size).toBe(0);
  });
});
