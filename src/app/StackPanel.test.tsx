// #1817 — the stack panel on the mockup's Crate scene, rendered and clicked: every edit from #1816
// goes through it, a refused one says why, and the tree reads as the mockup does.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import type { NodeRef } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildCrateMockup, type CrateMockup } from '../test-utils/crateMockup';
import { StackPanel } from './StackPanel';
import { useSelectionStore } from './stores/selectionStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

let container: HTMLDivElement;
let root: Root;
let m: CrateMockup;
const dag = () => useDagStore.getState().state;
const el = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = (id: string) => {
  const target = el(id);
  if (!target) throw new Error(`no ${id} on the panel`);
  act(() => target.click());
};

function show(output: NodeRef, state: DagState = m.state) {
  act(() => useDagStore.getState().hydrate(state));
  act(() => root.render(<StackPanel output={output} testIdPrefix="s" />));
}

beforeEach(() => {
  m = buildCrateMockup(buildDefaultDagState());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => useSelectionStore.getState().select(null));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('reading the Crate', () => {
  it('draws both lanes, the blend, its routes and the shared Follow Path once in full', () => {
    show(m.crate);
    for (const id of ['mirror', 'array', 'bevel', 'blend', 'aimA', 'aimB', 'follow', m.lag]) {
      expect(el(`s-row-${id}`), id).not.toBeNull();
    }
    expect(el('s-row-blend')?.textContent).toContain('[3 inputs]');
    expect(el('s-overridden-blend-factor')?.textContent).toBe('factor 0.5 → overridden by input');
    expect(el(`s-row-${m.lag}`)?.textContent).toContain('3 instances');
    expect(el('s-same-blend:bMatrix/follow')?.textContent).toContain('Follow Path = same node');
  });

  it('a closed group still says how many rows it holds', () => {
    show(m.crate);
    click('s-toggle-blend:aMatrix');
    expect(el('s-row-follow')).toBeNull();
    expect(el('s-count-blend:aMatrix')?.textContent).toMatch(/· 6 nodes/);
  });

  it('a "same as" row opens what the full row sits in, and selects it', () => {
    show(m.crate);
    click('s-toggle-blend:aMatrix');
    click('s-jump-blend:bMatrix/follow');
    expect(el('s-row-follow')).not.toBeNull();
    expect(useSelectionStore.getState().selectedNodeId).toBe('follow');
  });

  it('a blended step reads as one row with its influence', () => {
    show(m.barrel);
    expect(el('s-influence-barrelAim')?.textContent).toContain('influence 0.5');
    expect(el('s-row-barrelAim_influence_out')).toBeNull();
  });

  it('a template opens in place and says that an edit inside reaches every instance', () => {
    show(m.crate);
    expect(el(`s-template-notice-${m.lag}`)).toBeNull();
    click(`s-toggle-${m.lag}:inside`);
    expect(el(`s-template-notice-${m.lag}`)?.textContent).toContain('all 3 instances');
  });
});

describe('what the stack reaches through a name', () => {
  it('shows it without its edits, and "go to" opens the object it belongs to', () => {
    show(m.crate);
    const rail = (dag().nodes.follow.params as { curve: string }).curve;
    const curve = (dag().nodes[rail].inputs.data as NodeRef).node;
    const railRow = container.querySelector(`[data-row-key="${rail}"]`) as HTMLElement;
    const curveRow = container.querySelector(`[data-row-key="${curve}"]`) as HTMLElement;
    expect(railRow.getAttribute('draggable')).toBe('false');
    expect(curveRow.querySelector('[data-testid^="s-remove-"]')).toBeNull();
    expect(curveRow.querySelector('[data-testid^="s-up-"]')).toBeNull();
    const goTo = railRow.querySelector('[data-testid^="s-goto-"]') as HTMLElement;
    act(() => goTo.click());
    expect(useSelectionStore.getState().selectedNodeId).toBe(rail);
    // What the Crate owns keeps its edits.
    expect(el('s-row-mirror')?.querySelector('[data-testid="s-remove-mirror"]')).not.toBeNull();
  });
});

describe('editing through the panel', () => {
  it('mute writes the bypass, and the button says so', () => {
    show(m.crate);
    click('s-mute-mirror');
    expect((dag().nodes.mirror.params as { muted?: boolean }).muted).toBe(true);
    expect(el('s-mute-mirror')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('a refused edit says why and changes nothing', () => {
    show(m.crate);
    const before = dag();
    click('s-remove-follow');
    expect(el('s-notice')?.textContent).toMatch(/also read by aimB/);
    expect(dag()).toBe(before);
  });

  it('▼ moves a row down its run, by one undo', () => {
    show(m.crate);
    click('s-down-mirror');
    expect((dag().nodes[m.crate.node].inputs.data as NodeRef).node).toBe('array');
    expect((dag().nodes.array.inputs.target as NodeRef).node).toBe('mirror');
    act(() => useDagStore.getState().undo());
    expect((dag().nodes[m.crate.node].inputs.data as NodeRef).node).toBe('mirror');
  });

  it('+ offers what fits on top of the row, and adds the one picked, leaving the selection', () => {
    show(m.crate);
    act(() => useSelectionStore.getState().select(m.crate.node));
    click('s-add-remap');
    expect(el('s-offer-Clamp')).not.toBeNull();
    expect(el('s-offer-BoxData')).toBeNull(); // no main input: it can't sit on a row
    click('s-offer-Clamp');
    const added = (dag().nodes[m.lag].inputs.in as NodeRef).node;
    expect(dag().nodes[added].type).toBe('Clamp');
    expect((dag().nodes[added].inputs.in as NodeRef).node).toBe('remap');
    expect(useSelectionStore.getState().selectedNodeId).toBe(m.crate.node);
  });

  it('dragging a row onto another moves it there', () => {
    show(m.crate);
    const noise = el('s-row-noise')!;
    const remap = el('s-row-remap')!;
    act(() => {
      noise.dispatchEvent(new Event('dragstart', { bubbles: true }));
    });
    act(() => {
      remap.dispatchEvent(new Event('drop', { bubbles: true }));
    });
    expect((dag().nodes[m.lag].inputs.in as NodeRef).node).toBe('noise');
    expect((dag().nodes.noise.inputs.t as NodeRef | undefined)?.node).toBe('remap');
  });

  it('make unique gives the instance its own template', () => {
    show(m.crate);
    click(`s-unique-${m.lag}`);
    expect(dag().nodes[m.lag].type).toBe('template.Lag_2');
  });

  it('the routes of a list move up and down', () => {
    const scene = m.state.outputs.scene!;
    show(scene);
    const before = (dag().nodes[scene.node].inputs.children as NodeRef[]).map((r) => r.node);
    click(`s-route-down-${scene.node}:children[0]`);
    const after = (dag().nodes[scene.node].inputs.children as NodeRef[]).map((r) => r.node);
    expect(after).toEqual([before[1], before[0], ...before.slice(2)]);
  });
});
