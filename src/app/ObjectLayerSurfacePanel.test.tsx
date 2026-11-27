// #1940 T2 — the read-only "what changes this object" panel, rendered and clicked (OBSERVATION):
//   - the read model reaches the DOM: a group per lane with its rows;
//   - a material row carries the #1928 "renders base" caveat badge;
//   - a bare object shows the empty line, no groups;
//   - a click emits the right LayerRowPick (lane = the row's group, paramPath on value rows, the
//     row's node id) and the panel performs NO store write (it is a pure view);
//   - the panel imports no shell file (a mountable citizen the shell owns the mount of).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOps } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildCrateMockup } from '../test-utils/crateMockup';
import { ObjectLayerSurfacePanel, type LayerRowPick } from './ObjectLayerSurfacePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOX_ID = 'n_box';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

let container: HTMLDivElement;
let root: Root;
const el = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function show(state: DagState, nodeId: string, onPickRow: (p: LayerRowPick) => void = () => {}) {
  act(() => useDagStore.getState().hydrate(state));
  act(() => root.render(<ObjectLayerSurfacePanel nodeId={nodeId} onPickRow={onPickRow} />));
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

/** Default box + a material channel on it (`material.*` renders base-only today, #1928). */
function boxWithMaterialChannel(): DagState {
  return applyOps(buildDefaultDagState(), [
    {
      type: 'addNode',
      nodeId: 'ch_metal',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'metal',
        target: BOX_ID,
        paramPath: 'material.base.metalness',
        keyframes: [{ time: 0, value: 0.4, easing: 'linear' }],
      },
    },
  ] as Op[]).next;
}

/** The REAL #425 scenario: the default box is split-native (`n_box` Object → `n_box_data` data), and
 *  the inspector authors a material channel against the DATA node — not the Object. The director
 *  selects the Object; the panel must still draw the row by reaching through the split. */
const BOX_DATA_ID = 'n_box_data';
function boxWithDataHalfMaterialChannel(): DagState {
  return applyOps(buildDefaultDagState(), [
    {
      type: 'addNode',
      nodeId: 'ch_dmetal',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'dataMetal',
        target: BOX_DATA_ID,
        paramPath: 'material.base.metalness',
        keyframes: [{ time: 0, value: 0.4, easing: 'linear' }],
      },
    },
  ] as Op[]).next;
}

describe('ObjectLayerSurfacePanel — the read-only surface reaches the DOM', () => {
  it('a bare object shows the empty line and no groups', () => {
    show(buildDefaultDagState(), BOX_ID);
    expect(el('object-layer-surface-empty')?.textContent).toContain(
      'Nothing changes this object yet',
    );
    expect(el('object-layer-surface')).toBeNull();
  });

  it('a material channel draws a channel group carrying the #1928 base-only caveat', () => {
    show(boxWithMaterialChannel(), BOX_ID);
    expect(el('object-layer-group-channel')).not.toBeNull();
    expect(el('object-layer-row-channel')?.textContent).toContain('metal');
    expect(el('object-layer-row-base-only')).not.toBeNull(); // material renders base (#1928)
  });

  it('a data-half material channel still draws the channel group on the Object — reaches through (#425)', () => {
    show(boxWithDataHalfMaterialChannel(), BOX_ID); // selected = the Object, channel on the data half
    expect(el('object-layer-group-channel')).not.toBeNull();
    expect(el('object-layer-row-channel')?.textContent).toContain('dataMetal');
    expect(el('object-layer-row-base-only')).not.toBeNull(); // still the #1928 base-only caveat
  });

  it('a structural object (crate: modifiers + constraints) draws those groups, no caveat', () => {
    const m = buildCrateMockup(buildDefaultDagState());
    const crateId = (m.crate as { node: string }).node;
    show(m.state, crateId);
    expect(el('object-layer-group-modifier')).not.toBeNull();
    expect(el('object-layer-group-constraint')).not.toBeNull();
    expect(el('object-layer-row-base-only')).toBeNull(); // structural rows render folded
  });

  it('draws the groups last applied on top: constraints above modifiers, value lanes at the bottom', () => {
    const m = buildCrateMockup(buildDefaultDagState());
    const crateId = (m.crate as { node: string }).node;
    const keyed = applyOps(m.state, [
      {
        type: 'addNode',
        nodeId: 'ch_crate_metal',
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: 'crateMetal',
          target: crateId,
          paramPath: 'material.base.metalness',
          keyframes: [
            { time: 0, value: 0, easing: 'linear' },
            { time: 1, value: 1, easing: 'linear' },
          ],
        },
      },
    ] as Op[]).next;
    show(keyed, crateId);
    const lanes = [...container.querySelectorAll('[data-testid^="object-layer-group-"]')].map((g) =>
      g.getAttribute('data-testid')!.slice('object-layer-group-'.length),
    );
    expect(lanes.indexOf('constraint')).toBeGreaterThanOrEqual(0);
    expect(lanes.indexOf('constraint')).toBeLessThan(lanes.indexOf('modifier'));
    expect(lanes[lanes.length - 1], 'what sets a param first is drawn at the bottom').toBe(
      'channel',
    );
    expect(el('object-layer-order-hint')?.textContent).toBe('top of the list is applied last');
  });
});

describe('ObjectLayerSurfacePanel — a click emits the row pick and writes nothing', () => {
  it('clicking a material channel row emits lane=channel, its paramPath and the channel node id', () => {
    const picks: LayerRowPick[] = [];
    show(boxWithMaterialChannel(), BOX_ID, (p) => picks.push(p));
    const afterShow = useDagStore.getState().state; // the hydrated state, before the click
    act(() => el('object-layer-row-channel')!.click());
    expect(picks).toHaveLength(1);
    expect(picks[0]).toEqual({
      lane: 'channel',
      objectId: BOX_ID,
      rowNodeId: 'ch_metal',
      paramPath: 'material.base.metalness',
    });
    // Pure view: the click performed no store mutation (same state reference as before the click).
    expect(useDagStore.getState().state).toBe(afterShow);
  });

  it('clicking a structural (constraint) row emits lane=constraint, the node id, paramPath null', () => {
    const picks: LayerRowPick[] = [];
    const m = buildCrateMockup(buildDefaultDagState());
    const crateId = (m.crate as { node: string }).node;
    show(m.state, crateId, (p) => picks.push(p));
    act(() => el('object-layer-row-constraint')!.click());
    expect(picks).toHaveLength(1);
    expect(picks[0].lane).toBe('constraint');
    expect(picks[0].objectId).toBe(crateId);
    expect(picks[0].rowNodeId).not.toBeNull(); // routes by node
    expect(picks[0].paramPath).toBeNull(); // structural rows carry no param path
  });
});

describe('ObjectLayerSurfacePanel — a mountable citizen, no shell imports', () => {
  it('imports no shell file (Layout / NPanel / chat / drawer)', () => {
    const src = readFileSync(join(__dirname, 'ObjectLayerSurfacePanel.tsx'), 'utf8');
    const importLines = src.split('\n').filter((l) => l.trimStart().startsWith('import'));
    const shellHit = importLines.find((l) => /Layout|NPanel|\/chat|[Dd]rawer/.test(l));
    expect(shellHit ?? null).toBeNull();
  });
});
