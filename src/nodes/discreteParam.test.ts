// #1663 — a param that is a CHOICE is keyed stepped at every door that writes a key, so a camera
// cut lands on its key. The read side (`activeCamera.ts`) is pinned in `activeCamera.test.ts`.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRegistryForTests,
  applyOp,
  emptyDagState,
  getNodeType,
  listNodeTypes,
  paramFieldsOf,
  type DagState,
} from '../core/dag';
import { registerAllNodes } from './registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../agent/mutators';
import { useDagStore } from '../core/dag/store';
import { useDiffStore } from '../agent/diff/store';
import { dispatchFirstKeyComposite, dispatchMutatorFromUI } from '../app/animate/dispatchMutator';
import { isDiscreteParam, keyEasingFor } from './paramWidget';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

/** A CameraSelect switching camA/camB, and an ArrayModifier (whose `count` is an int that is an
 *  AMOUNT). #1668 — a cut key names its camera, so the switch has cameras to name. */
function seed(): DagState {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'sel', nodeType: 'CameraSelect', params: {} }).next;
  for (const id of ['camA', 'camB']) {
    s = makeSplitCamera(s, { objectId: id }).state;
    s = applyOp(s, {
      type: 'connect',
      from: { node: id, socket: 'out' },
      to: { node: 'sel', socket: 'cameras' },
    }).next;
  }
  s = applyOp(s, { type: 'addNode', nodeId: 'arr', nodeType: 'ArrayModifier', params: {} }).next;
  return s;
}

type Key = { time: number; value: unknown; easing: string };
const keysOf = (id: string): Key[] =>
  (useDagStore.getState().state.nodes[id]?.params as { keyframes: Key[] }).keyframes;

describe('#1663 — a choice is keyed stepped', () => {
  it('the params that declare themselves a choice are exactly these', () => {
    // A second one reds this on purpose: its READ site must hold too, and only
    // `CameraSelect.active`'s reader (`cutCameraIdAt`, a step over text keys) does today.
    const found: string[] = [];
    for (const type of listNodeTypes()) {
      const fields = paramFieldsOf(getNodeType(type)!) ?? {};
      for (const [path, schema] of Object.entries(fields)) {
        if (isDiscreteParam(schema)) found.push(`${type}.${path}`);
      }
    }
    expect(found).toEqual(['CameraSelect.active']);
  });

  it('an int that is an amount keeps the requested easing', () => {
    expect(keyEasingFor('ArrayModifier', 'count', 'linear')).toBe('linear');
    expect(keyEasingFor('CameraSelect', 'active', 'linear')).toBe('constant');
  });

  it('the first key on the active camera, from the panel, is stored constant', () => {
    useDagStore.setState({ state: seed() } as never);
    const r = dispatchFirstKeyComposite({
      targetId: 'sel',
      paramPath: 'active',
      value: 'camA',
      seconds: 0,
    });
    expect(r.ok).toBe(true);
    expect(keysOf('sel_active_channel')).toEqual([{ time: 0, value: 'camA', easing: 'constant' }]);
    // #1668 — a text channel, each key naming its camera; by shape a string would be a colour.
    expect(useDagStore.getState().state.nodes.sel_active_channel?.type).toBe('KeyframeChannelText');
  });

  it('the first key on an amount, from the panel, stays linear (control)', () => {
    useDagStore.setState({ state: seed() } as never);
    const r = dispatchFirstKeyComposite({
      targetId: 'arr',
      paramPath: 'count',
      value: 3,
      seconds: 0,
    });
    expect(r.ok).toBe(true);
    expect(keysOf('arr_count_channel')[0].easing).toBe('linear');
  });

  it("an agent key on the active camera is stored constant even when it asks for 'linear'", () => {
    useDagStore.setState({ state: seed() } as never);
    dispatchFirstKeyComposite({ targetId: 'sel', paramPath: 'active', value: 'camA', seconds: 0 });
    const add = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { channelId: 'sel_active_channel', time: 2, value: 'camB', easing: 'linear' },
      'cut to camera B',
    );
    expect(add.ok).toBe(true);
    // Re-keying an existing time is a write too.
    const rekey = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { channelId: 'sel_active_channel', time: 0, value: 'camA', easing: 'cubic' },
      're-key camera A',
    );
    expect(rekey.ok).toBe(true);
    expect(keysOf('sel_active_channel').map((k) => k.easing)).toEqual(['constant', 'constant']);
  });

  it('a channel the agent adds on the active camera starts with a constant key', () => {
    useDagStore.setState({ state: seed() } as never);
    const r = dispatchMutatorFromUI(
      'mutator.timeline.addChannel',
      {
        target: 'sel',
        paramPath: 'active',
        valueType: 'text',
        initialKeyframe: { time: 0, value: 'camA', easing: 'linear' },
      },
      'cut on the active camera',
    );
    expect(r.ok).toBe(true);
    expect(keysOf('sel_active_channel')[0].easing).toBe('constant');
  });

  it('re-interpolating a key on the active camera is refused by name; an amount is not', () => {
    useDagStore.setState({ state: seed() } as never);
    dispatchFirstKeyComposite({ targetId: 'sel', paramPath: 'active', value: 'camA', seconds: 0 });
    dispatchFirstKeyComposite({ targetId: 'arr', paramPath: 'count', value: 3, seconds: 0 });
    const refused = dispatchMutatorFromUI(
      'mutator.timeline.setKeyframeInterp',
      { channelId: 'sel_active_channel', easing: 'linear' },
      'smooth the cut',
    );
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.reason).toContain('always');
    expect(keysOf('sel_active_channel')[0].easing).toBe('constant');
    const allowed = dispatchMutatorFromUI(
      'mutator.timeline.setKeyframeInterp',
      { channelId: 'arr_count_channel', easing: 'cubic' },
      'ease the count',
    );
    expect(allowed.ok).toBe(true);
    expect(keysOf('arr_count_channel')[0].easing).toBe('cubic');
  });

  it("an agent key on an amount keeps 'linear' (control)", () => {
    useDagStore.setState({ state: seed() } as never);
    dispatchFirstKeyComposite({ targetId: 'arr', paramPath: 'count', value: 3, seconds: 0 });
    dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { channelId: 'arr_count_channel', time: 2, value: 6, easing: 'linear' },
      'more copies',
    );
    expect(keysOf('arr_count_channel').map((k) => k.easing)).toEqual(['linear', 'linear']);
  });
});

describe('#1668 — a cut key names a camera the switch can pick', () => {
  it('an agent channel on the active camera keyed as numbers is refused by name', () => {
    useDagStore.setState({ state: seed() } as never);
    const r = dispatchMutatorFromUI(
      'mutator.timeline.addChannel',
      {
        target: 'sel',
        paramPath: 'active',
        valueType: 'number',
        initialKeyframe: { time: 0, value: 0 },
      },
      'cut by index',
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toContain('valueType "text"');
  });

  it('an agent key naming a camera not wired into the switch is refused, naming the ones it can pick', () => {
    useDagStore.setState({ state: seed() } as never);
    dispatchFirstKeyComposite({ targetId: 'sel', paramPath: 'active', value: 'camA', seconds: 0 });
    const r = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { channelId: 'sel_active_channel', time: 2, value: 'camZ' },
      'cut to a camera that is not there',
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toContain('camA, camB');
    expect(keysOf('sel_active_channel')).toHaveLength(1);
  });

  it('control: an agent key naming a wired camera is taken', () => {
    useDagStore.setState({ state: seed() } as never);
    dispatchFirstKeyComposite({ targetId: 'sel', paramPath: 'active', value: 'camA', seconds: 0 });
    const r = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      { channelId: 'sel_active_channel', time: 2, value: 'camB' },
      'cut to camera B',
    );
    expect(r.ok).toBe(true);
  });
});
