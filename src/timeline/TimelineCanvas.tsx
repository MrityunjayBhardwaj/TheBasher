// TimelineCanvas — canvas-2D replacement for the SVG Dopesheet. STATIC
// LAYER ONLY (P6 W9 C3).
//
// WHY this exists: the old Dopesheet (src/timeline/Dopesheet.tsx) renders
// one absolutely-positioned <div> per keyframe diamond. A realistic scene
// (8+ channels x 20+ keyframes) puts hundreds of DOM nodes in the timeline
// and re-lays-them-out on every seconds-subscriber tick during a scrub —
// the D-W9 perf bottleneck. This component paints the same picture onto a
// single <canvas>, and (in C4) advances the playhead via an rAF loop that
// touches NO React state, so a 240-frame scrub holds 60fps.
//
// C3 SCOPE — the STATIC layer only:
//   - the visible <canvas> + an offscreen cache canvas holding the
//     rendered rows + grid + diamonds (the D-W9-3 "cached static layer"
//     C4's rAF strip-restore will drawImage() back from)
//   - dpr-capped backing store (D-W9-10, mirrors Viewport.tsx [1,2] cap)
//   - the React-observable mirror-attr contract (D-W9-4)
// The rAF playhead loop is C4 — DELIBERATELY ABSENT here. C3 proves the
// static path in isolation so the diamond/dpr/mirror concerns are settled
// before the perf-critical hot path lands on top of them.
//
// MOUNT STATUS: TimelineCanvas is intentionally NOT mounted anywhere in
// C3 — TimelineDrawer still renders <Dopesheet/>. The drawer swap + the
// Dopesheet delete + e2e + the 240-frame perf benchmark are all C5. The
// dead-code window is exactly C3 -> C4 -> C5 (one wave, one PR). C3
// rendering correctness is verified by the C2 pure-geometry suite + this
// file's React-observable contract test only; pixel correctness is
// deferred to C5 e2e (mirror-attr asserts) + the manual scrub gate.
//
// V8 file-rooted: reads useDagStore + useTimelineSelection + useTimeStore
// for STATIC needs only. Dispatches ZERO Ops — no dispatchAtomic, no
// dispatch(), no setParam. It is a pure projection, exactly as Dopesheet
// was (Dopesheet.tsx:7-9).
//
// REF: D-W9-2, D-W9-3 (static half), D-W9-4, D-W9-5, D-W9-7, D-W9-10;
//      memory/project_p6_w9_plan.md C3; checker FLAG-1.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDagStore } from '../core/dag/store';
import type { Node } from '../core/dag/types';
import { useTimeStore } from '../app/stores/timeStore';
import { useTimelineSelection } from './timelineSelection';
import { keyframeToRect, cullVisibleKeyframes } from './timelineCanvasGeometry';

/**
 * Imperative canvas palette — the exact hex constants the 2D context
 * paints with. A 2D canvas has no Tailwind token pairs, so these are the
 * surface C5's contrast revision (contrastMatrix R9) asserts ≥ WCAG-AA
 * against CANVAS_BG via the existing wcag.ts helper. Exported so C5
 * imports the literal contract rather than duplicating the hexes.
 *
 * Chosen to track the Dopesheet's Tailwind tokens this canvas replaces:
 *   - DIAMOND        ← `bg-fg`        (inactive keyframe)
 *   - ACTIVE_DIAMOND ← `bg-accent`    (selected keyframe / channel ring)
 *   - PLAYHEAD       ← `bg-accent`    (the C4 playhead line)
 *   - ROW_LINE       ← `border-line`  (channel row separators + grid)
 *   - LABEL_TEXT     ← `text-mute`    (channel name labels)
 *   - CANVAS_BG      ← `bg-bg`        (the surface background)
 */
export const PALETTE = {
  CANVAS_BG: '#0a0a0a',
  DIAMOND: '#e5e5e5',
  ACTIVE_DIAMOND: '#7c8cff',
  PLAYHEAD: '#7c8cff',
  ROW_LINE: '#2a2a2a',
  LABEL_TEXT: '#9a9a9a',
} as const;

/** Row height (CSS px) — mirrors Dopesheet's `h-6` channel rows (24px). */
const ROW_HEIGHT_PX = 24;
/** Diamond box (CSS px) — mirrors Dopesheet's 8x8 diamond. */
const DIAMOND_PX = 8;
/** Left gutter (CSS px) for channel labels — mirrors Dopesheet's `w-32`. */
const LABEL_GUTTER_PX = 128;

/** devicePixelRatio capped to [1,2] — copied verbatim from the
 *  Viewport.tsx convention (it passes `dpr={[1,2]}` to R3F's Canvas;
 *  D-W9-10). High-DPI gets crisp text/diamonds; we never pay >2x fill. */
function cappedDpr(): number {
  const raw =
    typeof window !== 'undefined' && window.devicePixelRatio
      ? window.devicePixelRatio
      : 1;
  return Math.min(Math.max(raw, 1), 2);
}

const CHANNEL_TYPES = new Set([
  'KeyframeChannelNumber',
  'KeyframeChannelVec3',
  'KeyframeChannelQuat',
  'KeyframeChannelColor',
]);

interface ChannelRow {
  channelId: string;
  name: string;
  keyframes: ReadonlyArray<{ time: number }>;
}

/**
 * Flatten the DAG's AnimationLayers + orphan channels into the ordered
 * channel-row list the canvas paints, one row per channel. This is the
 * canvas-side equivalent of Dopesheet's collectLayers/collectOrphanChannels
 * (Dopesheet.tsx:259-311) — same selection rules (layer-wired channels
 * first, then unwired), reduced to only what the static layer draws
 * (id + label + keyframe times; mute/solo chrome is C5's drawer concern,
 * not the canvas). Exported so C5 e2e fixtures + any future agent
 * automation can assert the row contract without DOM scraping.
 */
export function collectChannelRows(
  nodes: Record<string, Node>,
): ChannelRow[] {
  const rows: ChannelRow[] = [];
  const claimed = new Set<string>();

  const toRow = (node: Node): ChannelRow => {
    const params = (node.params ?? {}) as {
      name?: string;
      paramPath?: string;
      keyframes?: Array<{ time: number }>;
    };
    return {
      channelId: node.id,
      name: params.name || params.paramPath || '',
      keyframes: (params.keyframes ?? [])
        .slice()
        .sort((a, b) => a.time - b.time),
    };
  };

  // Layer-wired channels first, in layer declaration order.
  for (const node of Object.values(nodes)) {
    if (node.type !== 'AnimationLayer') continue;
    const animation = (node.inputs as Record<string, unknown>).animation;
    const refs = Array.isArray(animation)
      ? animation
      : animation
        ? [animation]
        : [];
    for (const ref of refs) {
      const channelId = (ref as { node: string }).node;
      const channelNode = nodes[channelId];
      if (!channelNode || !CHANNEL_TYPES.has(channelNode.type)) continue;
      if (claimed.has(channelId)) continue;
      claimed.add(channelId);
      rows.push(toRow(channelNode));
    }
  }
  // Then unwired (orphan) channels.
  for (const node of Object.values(nodes)) {
    if (!CHANNEL_TYPES.has(node.type)) continue;
    if (claimed.has(node.id)) continue;
    claimed.add(node.id);
    rows.push(toRow(node));
  }
  return rows;
}

interface Dims {
  cssW: number;
  cssH: number;
}

/**
 * Paint the full static layer (bg + grid + row separators + labels +
 * diamonds) into `ctx`, which the caller has already `scale(dpr,dpr)`'d
 * so all coordinates here are CSS px (matches C2 geometry's CSS-px
 * contract). Returns the number of diamonds actually drawn (= the culled
 * count = the `data-rendered-keyframes` mirror attr, D-W9-4).
 *
 * Exported + context-injected (not store-reading) so it is unit-testable
 * against a stub 2D context WITHOUT mocking real pixel output — the H32
 * trap the W9 plan forbids is faking pixel *correctness*; asserting which
 * draw calls fire + the returned cull count is a real contract, not a
 * faked render.
 */
export function paintStaticLayer(
  ctx: CanvasRenderingContext2D,
  rows: ChannelRow[],
  dims: Dims,
  durationSeconds: number,
  activeChannelId: string | null,
): number {
  const { cssW, cssH } = dims;
  ctx.clearRect(0, 0, cssW, cssH);

  // Background.
  ctx.fillStyle = PALETTE.CANVAS_BG;
  ctx.fillRect(0, 0, cssW, cssH);

  const trackWidth = Math.max(cssW - LABEL_GUTTER_PX, 0);

  // Visible seconds range = the whole track for C3 (no zoom yet; zoom is
  // a later wave). Culling still runs so the mirror attr is honest and
  // C5's culling e2e has a real code path to exercise.
  const visibleStartSec = 0;
  const visibleEndSec = durationSeconds;

  let rendered = 0;
  ctx.lineWidth = 1;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const rowTop = r * ROW_HEIGHT_PX;

    // Active-channel row tint (mirrors Dopesheet's `bg-accent/10`).
    if (activeChannelId !== null && row.channelId === activeChannelId) {
      ctx.fillStyle = PALETTE.ACTIVE_DIAMOND;
      ctx.globalAlpha = 0.1;
      ctx.fillRect(0, rowTop, cssW, ROW_HEIGHT_PX);
      ctx.globalAlpha = 1;
    }

    // Row separator line.
    ctx.strokeStyle = PALETTE.ROW_LINE;
    ctx.beginPath();
    ctx.moveTo(0, rowTop + ROW_HEIGHT_PX + 0.5);
    ctx.lineTo(cssW, rowTop + ROW_HEIGHT_PX + 0.5);
    ctx.stroke();

    // Channel label.
    ctx.fillStyle = PALETTE.LABEL_TEXT;
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      row.name,
      6,
      rowTop + ROW_HEIGHT_PX / 2,
      LABEL_GUTTER_PX - 8,
    );

    // Diamonds — geometry comes from C2 (consumed, NOT re-derived inline;
    // re-deriving was the D-W9-4 anti-pattern). Cull first so the count
    // is the honest rendered count.
    const culled = cullVisibleKeyframes(
      row.keyframes.map((k) => ({ timeSeconds: k.time })),
      visibleStartSec,
      visibleEndSec,
    );
    const isActiveRow =
      activeChannelId !== null && row.channelId === activeChannelId;
    ctx.fillStyle = isActiveRow
      ? PALETTE.ACTIVE_DIAMOND
      : PALETTE.DIAMOND;

    for (const { index } of culled) {
      const t = row.keyframes[index].time;
      // C2 keyframeToRect maps time -> CSS-px rect; offset x by the label
      // gutter so diamonds sit in the track area, not under the labels.
      const rect = keyframeToRect(
        t,
        r,
        durationSeconds,
        trackWidth,
        ROW_HEIGHT_PX,
        DIAMOND_PX,
      );
      const cx = LABEL_GUTTER_PX + rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      // Rotated (45°) square = diamond, mirroring Dopesheet's
      // `rotate-45` 8x8 box.
      ctx.beginPath();
      ctx.moveTo(cx, cy - DIAMOND_PX / 2);
      ctx.lineTo(cx + DIAMOND_PX / 2, cy);
      ctx.lineTo(cx, cy + DIAMOND_PX / 2);
      ctx.lineTo(cx - DIAMOND_PX / 2, cy);
      ctx.closePath();
      ctx.fill();
      rendered++;
    }
  }

  return rendered;
}

export function TimelineCanvas({ duration }: { duration: number }) {
  const nodes = useDagStore((s) => s.state.nodes);
  const activeChannelId = useTimelineSelection((s) => s.activeChannelId);
  // Read (do not subscribe-render on) durationSeconds as a fallback when
  // the prop is absent; the prop is the contract Dopesheet had, kept
  // identical so the C5 drawer swap is a one-line import change.
  const storeDuration = useTimeStore((s) => s.durationSeconds);
  const durationSeconds = duration > 0 ? duration : storeDuration;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Offscreen static-layer cache. Owned solely by the diamond effect
  // (single writer of the static layer). C4's rAF loop will only READ it
  // via drawImage to restore the static pixels under the moving playhead.
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);

  const [dims, setDims] = useState<Dims>({ cssW: 0, cssH: 0 });
  const [dpr, setDpr] = useState<number>(() => cappedDpr());

  const rows = collectChannelRows(nodes);

  // Measure the host + observe resize (drawer is resizable 200–480px,
  // D-W9-10). useLayoutEffect so the first paint has real dims, not 0x0.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const measure = () => {
      const rect = host.getBoundingClientRect();
      const nextDpr = cappedDpr();
      setDims((prev) =>
        prev.cssW === rect.width && prev.cssH === rect.height
          ? prev
          : { cssW: rect.width, cssH: rect.height },
      );
      setDpr((prev) => (prev === nextDpr ? prev : nextDpr));
    };

    measure();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(host);
    }
    return () => {
      observer?.disconnect();
    };
  }, []);

  // Mirror attrs (D-W9-4) are the React-observable DATA contract — they
  // describe the DAG-derived picture, NOT a pixel side-effect, so they
  // publish independently of canvas dims/dpr (a 0x0 host before its first
  // layout pass, or a no-2D-context env, must still expose an honest
  // count). The cull count here equals the painted count because C3 has
  // no zoom — visible range == [0, duration] — so the data contract and
  // the pixel contract agree by construction. NOT data-playhead-px (C4).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const total = rows.reduce(
      (n, row) =>
        n +
        cullVisibleKeyframes(
          row.keyframes.map((k) => ({ timeSeconds: k.time })),
          0,
          durationSeconds,
        ).length,
      0,
    );
    host.dataset.renderedKeyframes = String(total);
    host.dataset.channelCount = String(rows.length);
    host.dataset.frameCount = String(
      Math.max(0, Math.round(durationSeconds * 60)),
    );
  }, [rows, durationSeconds]);

  // Build + populate the offscreen static cache, then blit it to the
  // visible canvas. Keyed on every input that changes the static picture
  // (D-W9-3). dims/dpr are React state in the dep array → this effect
  // re-runs on resize/dpr change, so the closure can never go stale on
  // the declarative path (the rAF stale-closure risk is C4's, handled
  // there via getState()/refs — NOT pre-built here). This effect owns
  // PIXELS only; the attr contract is the effect above.
  useEffect(() => {
    const visible = canvasRef.current;
    if (!visible) return;
    if (dims.cssW <= 0 || dims.cssH <= 0) return;

    const backingW = Math.round(dims.cssW * dpr);
    const backingH = Math.round(dims.cssH * dpr);

    // Visible canvas: backing store at dpr, CSS size unscaled.
    visible.width = backingW;
    visible.height = backingH;
    visible.style.width = `${dims.cssW}px`;
    visible.style.height = `${dims.cssH}px`;

    // Offscreen cache: same backing dims (C4 drawImage 1:1 restore).
    let offscreen = offscreenRef.current;
    if (!offscreen) {
      offscreen = document.createElement('canvas');
      offscreenRef.current = offscreen;
    }
    offscreen.width = backingW;
    offscreen.height = backingH;

    const offCtx = offscreen.getContext('2d');
    const visCtx = visible.getContext('2d');
    // happy-dom (test env) returns null for getContext('2d'); guard so the
    // contract test mounts cleanly. Real browsers always return a context.
    // The mirror-attr data contract is the effect above — it does NOT
    // depend on a 2D context — so a null context here only skips PIXELS,
    // never the observable contract.
    if (!offCtx || !visCtx) return;

    // Draw the static layer into the OFFSCREEN cache (CSS-px coords after
    // scale), then blit offscreen → visible. C4's rAF loop restores from
    // this same offscreen, so the static layer must live there first.
    offCtx.setTransform(1, 0, 0, 1, 0, 0);
    offCtx.scale(dpr, dpr);
    paintStaticLayer(offCtx, rows, dims, durationSeconds, activeChannelId);

    visCtx.setTransform(1, 0, 0, 1, 0, 0);
    visCtx.clearRect(0, 0, backingW, backingH);
    visCtx.drawImage(offscreen, 0, 0);
  }, [nodes, activeChannelId, durationSeconds, dims, dpr, rows]);

  return (
    <div
      ref={hostRef}
      data-testid="timeline-canvas"
      role="img"
      aria-label={`Animation dopesheet — ${rows.length} channels`}
      data-frame-count={Math.max(0, Math.round(durationSeconds * 60))}
      data-channel-count={rows.length}
      data-rendered-keyframes={0}
      className="relative h-full w-full overflow-hidden bg-bg"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
