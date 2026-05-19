// TimelineCanvas — LIGHT contract test (P6 W9 C3).
//
// happy-dom (the vitest env) returns `null` from canvas.getContext('2d')
// — there is NO real 2D canvas here. Drawing CORRECTNESS is therefore
// proven elsewhere by design:
//   - geometry math      → src/timeline/timelineCanvasGeometry.test.ts (C2)
//   - pixels under scrub  → C5 e2e mirror-attr asserts + manual gate
//
// This file asserts ONLY what React makes observable without a GPU:
//   1. the host renders with its testid + role + initial mirror attrs
//   2. the offscreen-null path still publishes honest mirror attrs
//      (cull count is computable without a 2D context)
//   3. ResizeObserver is wired on mount and disconnected on unmount
//   4. the pure exports (collectChannelRows / paintStaticLayer / PALETTE)
//      honour their contracts
//
// It deliberately does NOT mock a 2D context to fake-test pixel drawing —
// that is the H32 trap the W9 plan explicitly forbids. paintStaticLayer
// is exercised against a *recording stub* that asserts which draw calls
// fire + the returned cull count (a real contract), never faked pixels.
//
// No React Testing Library (W2 acceptance gate #15 — no new deps); the
// component is mounted via react-dom/client, which is already a prod dep.
//
// REF: memory/project_p6_w9_plan.md C3; hetvabhasa H32.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Explicit React import: the classic JSX runtime is in scope for this
// test transform, so `<TimelineCanvas/>` needs `React` defined (the
// app's automatic react-jsx runtime is a tsconfig.app setting that does
// not reach the vitest .test.tsx transform here).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TimelineCanvas, collectChannelRows, paintStaticLayer, PALETTE } from './TimelineCanvas';
import { useDagStore } from '../core/dag/store';
import { useTimelineSelection } from './timelineSelection';
import type { Node } from '../core/dag/types';

// --- helpers ---------------------------------------------------------

function makeChannel(id: string, name: string, times: number[]): Node {
  return {
    id,
    type: 'KeyframeChannelNumber',
    inputs: {},
    params: { name, paramPath: name, keyframes: times.map((t) => ({ time: t })) },
  } as unknown as Node;
}

function makeLayer(id: string, channelIds: string[]): Node {
  return {
    id,
    type: 'AnimationLayer',
    inputs: { animation: channelIds.map((n) => ({ node: n })) },
    params: { name: 'Layer' },
  } as unknown as Node;
}

// Tell React this is an act() environment so react-dom/client batches
// effects deterministically and the act() warnings stay silent (no RTL
// to set this for us).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Scoped in-place reset of the stores this component reads (the C1
  // established pattern — never reassign refs, mutate state in place).
  useDagStore.setState((s) => ({ ...s, state: { ...s.state, nodes: {} } }));
  useTimelineSelection.setState({ activeChannelId: null, activeKeyframeId: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function seed(nodes: Record<string, Node>) {
  useDagStore.setState((s) => ({ ...s, state: { ...s.state, nodes } }));
}

// --- pure export: collectChannelRows ---------------------------------

describe('collectChannelRows', () => {
  it('returns layer-wired channels first, then orphans, sorted by time', () => {
    const ch1 = makeChannel('ch1', 'pos.x', [2, 0.5, 1]);
    const ch2 = makeChannel('ch2', 'pos.y', [0]);
    const orphan = makeChannel('orphan', 'rot.z', [3]);
    const layer = makeLayer('L1', ['ch1', 'ch2']);
    const rows = collectChannelRows({ L1: layer, ch1, ch2, orphan });
    expect(rows.map((r) => r.channelId)).toEqual(['ch1', 'ch2', 'orphan']);
    // keyframes sorted ascending by time.
    expect(rows[0].keyframes.map((k) => k.time)).toEqual([0.5, 1, 2]);
  });

  it('does not double-count a channel referenced by multiple layers', () => {
    const ch1 = makeChannel('ch1', 'a', [0]);
    const L1 = makeLayer('L1', ['ch1']);
    const L2 = makeLayer('L2', ['ch1']);
    const rows = collectChannelRows({ L1, L2, ch1 });
    expect(rows.map((r) => r.channelId)).toEqual(['ch1']);
  });

  it('ignores non-channel node types', () => {
    const mesh = { id: 'm', type: 'BoxMesh', inputs: {}, params: {} } as unknown as Node;
    expect(collectChannelRows({ m: mesh })).toEqual([]);
  });
});

// --- pure export: paintStaticLayer (recording stub, NOT faked pixels) -

describe('paintStaticLayer', () => {
  // A recording stub: captures which draw verbs fired. This asserts the
  // draw CONTRACT (calls happen, cull count returned), not pixel output.
  function recordingCtx() {
    const calls: string[] = [];
    const rec =
      (name: string) =>
      (..._a: unknown[]) => {
        calls.push(name);
      };
    return {
      calls,
      ctx: {
        clearRect: rec('clearRect'),
        fillRect: rec('fillRect'),
        beginPath: rec('beginPath'),
        moveTo: rec('moveTo'),
        lineTo: rec('lineTo'),
        closePath: rec('closePath'),
        fill: rec('fill'),
        stroke: rec('stroke'),
        fillText: rec('fillText'),
        set fillStyle(_v: string) {},
        set strokeStyle(_v: string) {},
        set lineWidth(_v: number) {},
        set globalAlpha(_v: number) {},
        set font(_v: string) {},
        set textBaseline(_v: string) {},
      } as unknown as CanvasRenderingContext2D,
    };
  }

  it('returns the culled keyframe count and clears+fills the bg', () => {
    const { ctx, calls } = recordingCtx();
    const rows = collectChannelRows({
      ch1: makeChannel('ch1', 'x', [0, 1, 2]),
    });
    const n = paintStaticLayer(ctx, rows, { cssW: 400, cssH: 100 }, 10, null);
    expect(n).toBe(3);
    expect(calls).toContain('clearRect');
    expect(calls).toContain('fillRect');
    // 3 diamonds → 3 fill() calls at minimum.
    expect(calls.filter((c) => c === 'fill').length).toBeGreaterThanOrEqual(3);
  });

  it('culls keyframes outside [0, duration] — honest rendered count', () => {
    const { ctx } = recordingCtx();
    const rows = collectChannelRows({
      ch1: makeChannel('ch1', 'x', [-1, 0, 5, 100]),
    });
    // duration 10 → only times 0 and 5 are in range.
    const n = paintStaticLayer(ctx, rows, { cssW: 400, cssH: 100 }, 10, null);
    expect(n).toBe(2);
  });

  it('does not throw on zero-size dims or zero duration', () => {
    const { ctx } = recordingCtx();
    const rows = collectChannelRows({ ch1: makeChannel('ch1', 'x', [0]) });
    expect(() => paintStaticLayer(ctx, rows, { cssW: 0, cssH: 0 }, 0, null)).not.toThrow();
  });
});

// --- PALETTE contract ------------------------------------------------

describe('PALETTE', () => {
  it('exposes the exact keys C5 contrast-checks, all valid hex', () => {
    const keys = Object.keys(PALETTE).sort();
    expect(keys).toEqual(
      ['ACTIVE_DIAMOND', 'CANVAS_BG', 'DIAMOND', 'LABEL_TEXT', 'PLAYHEAD', 'ROW_LINE'].sort(),
    );
    for (const v of Object.values(PALETTE)) {
      expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

// --- React-observable contract (mounted via react-dom/client) --------

describe('TimelineCanvas host contract', () => {
  it('renders the host with testid, role, and initial mirror attrs', () => {
    seed({});
    act(() => root.render(<TimelineCanvas duration={5} />));
    const host = container.querySelector('[data-testid="timeline-canvas"]') as HTMLDivElement;
    expect(host).not.toBeNull();
    expect(host.getAttribute('role')).toBe('img');
    expect(host.getAttribute('aria-label')).toBe('Animation dopesheet — 0 channels');
    // C4: data-playhead-px / data-frame are written by the rAF loop, but
    // C3's dims-INDEPENDENT data effect seeds a sane '0' pre-tick (the
    // happy-dom 0x0 getBoundingClientRect means the pixel effect + the
    // rAF body may never run in jsdom, so a test reading these pre-tick
    // must see '0', never null). This is the C4 carry-contract.
    expect(host.getAttribute('data-playhead-px')).toBe('0');
    expect(host.getAttribute('data-frame')).toBe('0');
    expect(host.querySelector('canvas')).not.toBeNull();
  });

  it('publishes honest mirror attrs even when no 2D context exists', () => {
    // happy-dom returns null for getContext('2d'); the offscreen-null
    // branch must still write a correct cull count + counts.
    seed({
      L1: makeLayer('L1', ['ch1', 'ch2']),
      ch1: makeChannel('ch1', 'x', [0, 1, 2]),
      ch2: makeChannel('ch2', 'y', [0, 99]), // 99 culled at duration 5
    });
    act(() => root.render(<TimelineCanvas duration={5} />));
    const host = container.querySelector('[data-testid="timeline-canvas"]') as HTMLDivElement;
    expect(host.dataset.channelCount).toBe('2');
    expect(host.dataset.frameCount).toBe(String(5 * 60));
    // ch1: 0,1,2 in [0,5] = 3; ch2: 0 in, 99 out = 1 → 4 total.
    expect(host.dataset.renderedKeyframes).toBe('4');
  });

  it('wires a ResizeObserver on mount and disconnects it on unmount', () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    const RealRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = vi.fn(() => ({
      observe,
      disconnect,
      unobserve: vi.fn(),
    })) as unknown as typeof ResizeObserver;
    try {
      seed({});
      act(() => root.render(<TimelineCanvas duration={5} />));
      expect(observe).toHaveBeenCalledTimes(1);
      expect(disconnect).not.toHaveBeenCalled();
      act(() => root.unmount());
      expect(disconnect).toHaveBeenCalledTimes(1);
      // re-create the root so afterEach's unmount() is a no-op-safe call.
      root = createRoot(container);
    } finally {
      globalThis.ResizeObserver = RealRO;
    }
  });
});
