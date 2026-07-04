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

  it('surfaces a free-floating camera channel as an orphan row (#190)', () => {
    // A camera channel targets the camera node DIRECTLY with NO AnimationLayer
    // wrapper (dispatchCameraFirstKey) — the camera is wired via scene.camera,
    // outside the layer machinery. It must still appear in the dopesheet, which
    // it does via the orphan-channel path. Falsifiable: restrict collection to
    // layer-wired channels → the camera row vanishes (silent-empty dopesheet).
    const camFov = makeChannel('n_camera_fov_channel', 'fov', [0, 1]);
    const rows = collectChannelRows({ n_camera_fov_channel: camFov });
    expect(rows.map((r) => r.channelId)).toEqual(['n_camera_fov_channel']);
    // No target node present in the map → the label falls back to the bare
    // paramPath (the orphan-row contract). Qualification kicks in only when the
    // target resolves (next test).
    expect(rows[0].name).toBe('fov');
  });

  it('qualifies a bare direct-channel label with its target identity (#194 dopesheet)', () => {
    // dispatchDirectFirstKey sets name === paramPath ("position"). Post-#199 the
    // camera, the box, every node animates via free-floating channels in ONE flat
    // list — so two "position" rows are indistinguishable until qualified by owner.
    const node = (id: string, type: string, params: Record<string, unknown>) =>
      ({ id, type, inputs: {}, params }) as unknown as Node;
    const ch = (id: string, target: string) =>
      node(id, 'KeyframeChannelVec3', {
        name: 'position',
        paramPath: 'position',
        target,
        keyframes: [{ time: 0 }],
      });
    const rows = collectChannelRows({
      n_camera: node('n_camera', 'PerspectiveCamera', { fov: 45 }),
      n_box: node('n_box', 'BoxMesh', {}),
      cam_pos_ch: ch('cam_pos_ch', 'n_camera'),
      box_pos_ch: ch('box_pos_ch', 'n_box'),
    });
    const byId = Object.fromEntries(rows.map((r) => [r.channelId, r.name]));
    // The two "position" channels are now distinguishable by their owner — the
    // SAME identity the outliner shows (V34); no meta/params.name → the id.
    expect(byId.cam_pos_ch).toBe('n_camera — position');
    expect(byId.box_pos_ch).toBe('n_box — position');
  });

  it('leaves an already-qualified channel name untouched (baked-clip convention)', () => {
    // A baked bone channel carries a descriptive name (name !== paramPath); it
    // must NOT be re-qualified into "Skeleton — bone_1 — position".
    const baked = {
      id: 'n_baked',
      type: 'KeyframeChannelVec3',
      inputs: {},
      params: {
        name: 'bone_1 — position',
        paramPath: 'position',
        target: 'n_skel',
        keyframes: [{ time: 0 }],
      },
    } as unknown as Node;
    const skel = {
      id: 'n_skel',
      type: 'GltfSkeleton',
      inputs: {},
      params: { name: 'Skeleton' },
    } as unknown as Node;
    const rows = collectChannelRows({ n_skel: skel, n_baked: baked });
    expect(rows.find((r) => r.channelId === 'n_baked')?.name).toBe('bone_1 — position');
  });

  it('carries the channel mute flag onto the row (#263)', () => {
    // A channel whose `mute` param is set surfaces `mute: true` on its row so
    // the dopesheet can dim it; an un-muted channel is explicitly `false`.
    const muted = {
      id: 'chm',
      type: 'KeyframeChannelNumber',
      inputs: {},
      params: { name: 'x', paramPath: 'x', mute: true, keyframes: [{ time: 0 }] },
    } as unknown as Node;
    const rows = collectChannelRows({ chm: muted, chp: makeChannel('chp', 'y', [0]) });
    expect(rows.find((r) => r.channelId === 'chm')?.mute).toBe(true);
    expect(rows.find((r) => r.channelId === 'chp')?.mute).toBe(false);
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

  it('dims a muted row — its diamonds fill at a reduced alpha (#263)', () => {
    // A capturing stub records the globalAlpha in force at each fill(). Only
    // diamonds use fill() (bg / active-tint / ruler use fillRect), so the
    // captured alphas are the per-diamond alphas.
    const alphaAtFill: number[] = [];
    let alpha = 1;
    const ctx = {
      clearRect() {},
      fillRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      stroke() {},
      fillText() {},
      fill() {
        alphaAtFill.push(alpha);
      },
      set fillStyle(_v: string) {},
      set strokeStyle(_v: string) {},
      set lineWidth(_v: number) {},
      set font(_v: string) {},
      set textBaseline(_v: string) {},
      set globalAlpha(v: number) {
        alpha = v;
      },
    } as unknown as CanvasRenderingContext2D;

    const mutedRows = collectChannelRows({
      chm: {
        id: 'chm',
        type: 'KeyframeChannelNumber',
        inputs: {},
        params: { name: 'x', paramPath: 'x', mute: true, keyframes: [{ time: 0 }] },
      } as unknown as Node,
    });
    paintStaticLayer(ctx, mutedRows, { cssW: 400, cssH: 100 }, 10, null);
    // The muted diamond fills BELOW the normal 0.82 unselected alpha.
    expect(alphaAtFill.length).toBeGreaterThan(0);
    expect(alphaAtFill.every((a) => a > 0 && a < 0.82)).toBe(true);

    // Control: an identical UNMUTED channel never fills below 0.82.
    alphaAtFill.length = 0;
    alpha = 1;
    const plainRows = collectChannelRows({ chp: makeChannel('chp', 'x', [0]) });
    paintStaticLayer(ctx, plainRows, { cssW: 400, cssH: 100 }, 10, null);
    expect(alphaAtFill.every((a) => a >= 0.82)).toBe(true);
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
