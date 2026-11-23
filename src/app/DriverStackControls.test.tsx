// DriverStackControls (#425) — the driver MANAGING panel reaches through the object↔data split,
// rendered to the DOM (OBSERVATION). The default box is split-native (`n_box` Object → `n_box_data`
// data). A driver on a data-half param (material) targets the DATA node, while the director selects
// the Object. V112: a managing surface aggregates the halves under the object — so the Object's
// driver panel must draw that driver with a removable row. Before the reach it drew the empty state,
// which is the bug this ticket's worst symptom names: "the driver exists, drives, and has no row
// anywhere to bypass, reorder or delete it."

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOps } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { DriverStackControls } from './DriverStackControls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOX_ID = 'n_box';
const BOX_DATA_ID = 'n_box_data';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

let container: HTMLDivElement;
let root: Root;
const el = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function show(state: DagState, nodeId: string) {
  act(() => useDagStore.getState().hydrate(state));
  act(() => root.render(<DriverStackControls nodeId={nodeId} />));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** A driver on the DATA half: a Clamp source wired into a ParamDriver whose target is `n_box_data`
 *  (material lives on the data node), order 0. This is what the inspector mints when you bind a
 *  driver to a cube's colour. */
function boxWithDataHalfDriver(): DagState {
  return applyOps(buildDefaultDagState(), [
    { type: 'addNode', nodeId: 'c_data', nodeType: 'Clamp', params: { min: 0.3, max: 1 } },
    {
      type: 'addNode',
      nodeId: 'd_data',
      nodeType: 'ParamDriver',
      params: { target: BOX_DATA_ID, paramPath: 'material.metalness', blendMode: 'replace', order: 0 },
    },
    { type: 'connect', from: { node: 'c_data', socket: 'out' }, to: { node: 'd_data', socket: 'in' } },
  ] as Op[]).next;
}

describe('DriverStackControls — a managing surface reaches the data half (#425, V112)', () => {
  it('a data-half driver draws a removable row when the OBJECT is selected', () => {
    show(boxWithDataHalfDriver(), BOX_ID); // selected = the Object; driver is on n_box_data
    // The band for the data-half param renders under the Object, not the empty state.
    expect(el('driver-bands')).not.toBeNull();
    expect(el('driver-band-material.metalness')).not.toBeNull();
    // The driver has a row AND a remove control — the exact affordance the bug said was missing.
    expect(el('driver-row-d_data')).not.toBeNull();
    expect(el('driver-remove-d_data')).not.toBeNull();
    expect(el('driver-mute-d_data')).not.toBeNull();
  });

  it('a fused object with no driver still shows the empty state (unchanged)', () => {
    show(buildDefaultDagState(), BOX_ID);
    expect(el('driver-bands')).toBeNull();
    expect(el('driver-stack')).not.toBeNull(); // the empty OperatorStackRows
  });
});
