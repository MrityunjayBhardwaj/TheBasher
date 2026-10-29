// #1731 — an inspector field follows the playhead only when its node's own value can move.
//
// Measured before this (real GPU, 800 objects, a static sphere under a keyed Group selected):
// 11.3 ms of our own code per frame, most of it the inspector re-resolving numbers that do not
// move. The probe below stands in for a field: it counts its renders while the playhead moves.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../core/dag';
import { useDagStore } from '../../core/dag/store';
import type { Op } from '../../core/dag/types';
import { buildDefaultDagState } from '../../core/project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { useTimeStore } from '../stores/timeStore';
import { usePlayheadFor, type Playhead } from './usePlayheadFor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

let container: HTMLDivElement;
let root: Root;
let renders = 0;
let seen: Playhead | null = null;

function Probe({ nodeId }: { nodeId: string }) {
  renders++;
  seen = usePlayheadFor(nodeId);
  return null;
}

const KEY: Op = {
  type: 'addNode',
  nodeId: 'k',
  nodeType: 'KeyframeChannelVec3',
  params: {
    name: 'position',
    target: 'n_box',
    paramPath: 'position',
    keyframes: [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 2, value: [4, 0, 0], easing: 'linear' },
    ],
  },
} as Op;

const scrub = (times: number[]) => {
  for (const t of times) act(() => useTimeStore.getState().setTime(t));
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  renders = 0;
  seen = null;
  act(() => useTimeStore.getState().setTime(0));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('#1731 usePlayheadFor', () => {
  it('a node nothing animates does not re-render as the playhead moves', () => {
    act(() => useDagStore.getState().hydrate(buildDefaultDagState()));
    act(() => root.render(<Probe nodeId="n_box" />));
    const before = renders;
    scrub([0.5, 1, 1.5]);
    expect(renders).toBe(before);
  });

  it('…and reads the current playhead when it renders for another reason', () => {
    act(() => useDagStore.getState().hydrate(buildDefaultDagState()));
    act(() => root.render(<Probe nodeId="n_box" />));
    scrub([1.25]);
    act(() => root.render(<Probe nodeId="n_box" key="again" />));
    expect(seen?.seconds).toBe(1.25);
  });

  it('a keyed node re-renders on every playhead move, with the moved time', () => {
    act(() => useDagStore.getState().hydrate(applyOp(buildDefaultDagState(), KEY).next));
    act(() => root.render(<Probe nodeId="n_box" />));
    const before = renders;
    scrub([0.5, 1, 1.5]);
    expect(renders).toBe(before + 3);
    expect(seen?.seconds).toBe(1.5);
  });

  it('keying a node while it is shown starts following the playhead', () => {
    act(() => useDagStore.getState().hydrate(buildDefaultDagState()));
    act(() => root.render(<Probe nodeId="n_box" />));
    act(() => useDagStore.getState().hydrate(applyOp(useDagStore.getState().state, KEY).next));
    const before = renders;
    scrub([0.75]);
    expect(renders).toBe(before + 1);
    expect(seen?.seconds).toBe(0.75);
  });
});
