// TimelineCanvas — canvas-2D replacement for the SVG Dopesheet. STATIC
// LAYER (P6 W9 C3) + IMPERATIVE rAF PLAYHEAD (P6 W9 C4).
//
// WHY this exists: the old Dopesheet (src/timeline/Dopesheet.tsx) renders
// one absolutely-positioned <div> per keyframe diamond. A realistic scene
// (8+ channels x 20+ keyframes) puts hundreds of DOM nodes in the timeline
// and re-lays-them-out on every seconds-subscriber tick during a scrub —
// the D-W9 perf bottleneck. This component paints the same picture onto a
// single <canvas>, and (C4) advances the playhead via an rAF loop that
// touches NO React state, so a 240-frame scrub holds 60fps.
//
// C3 SCOPE — the STATIC layer:
//   - the visible <canvas> + an offscreen cache canvas holding the
//     rendered rows + grid + diamonds (the D-W9-3 "cached static layer"
//     C4's rAF strip-restore drawImage()'s back from)
//   - dpr-capped backing store (D-W9-10, mirrors Viewport.tsx [1,2] cap)
//   - the React-observable mirror-attr contract (D-W9-4)
//
// C4 SCOPE — the IMPERATIVE rAF PLAYHEAD (the perf-critical hot path):
//   - a self-rescheduling requestAnimationFrame loop, started on mount
//     once the offscreen cache exists, cancelAnimationFrame'd on unmount.
//   - EACH frame reads `useViewportStore.getState().currentFrameRef.current`
//     AND `useTimeStore.getState().seconds` via getState() INSIDE the
//     loop body — NEVER closure-captured (D-W9-3 / context-memo §3
//     stale-closure mitigation). dims/dpr/offscreen/duration come from
//     refs the C3 layout/draw effects keep current, never from render
//     scope. The ONLY things the closure binds are stable refs.
//   - IDLE STRATEGY (LOCKED — do NOT re-decide; see plan C4 §129):
//     compute the new playhead x; if it is unchanged from the last drawn
//     x, EARLY-OUT but KEEP the rAF registered (do NOT cancel/re-arm).
//     Re-arming would need a wake signal wired from timeStore.play/scrub
//     — extra cross-store coupling. A single getState() read + compare
//     per idle frame is cheaper than that coupling and matches Clock.tsx's
//     own "loop runs even when paused, just no-ops" precedent
//     (Clock.tsx:9-11, :22-32).
//   - ON CHANGE: playheadStripRect (C2) at the OLD x → drawImage from the
//     C3 offscreen cache into that strip (restores the EXACT static pixels
//     — diamonds included — under the old line; that is the entire point
//     of the cache) → stroke the playhead line at the NEW x with
//     PALETTE.PLAYHEAD, DRAWN LAST / on top (D-W9-3). Then write
//     data-playhead-px = new x and data-frame = currentFrameRef.current.
//   - NO React render in this path — that is the whole escape-hatch
//     thesis: static geometry is NOT re-rendered 60x/sec, only the
//     playhead pixels + two data-attrs move.
//
// MOUNT STATUS: TimelineCanvas is intentionally NOT mounted anywhere in
// C3/C4 — TimelineDrawer still renders <Dopesheet/>. The drawer swap + the
// Dopesheet delete + e2e + the 240-frame perf benchmark are all C5. The
// dead-code window is exactly C3 -> C4 -> C5 (one wave, one PR). C4
// rAF-loop correctness is verified by C5 e2e (mirror-attr asserts:
// data-playhead-px monotonic, data-rendered-keyframes constant under
// scrub) + the C5 240-frame perf gate + the C5 manual scrub gate; jsdom
// cannot run rAF+canvas meaningfully, so C4 ships NO new test file
// (asserting it in vitest would be H32-style fake instrumentation).
//
// V8 file-rooted: reads useDagStore + useTimelineSelection + useTimeStore
// + useViewportStore (the currentFrameRef escape hatch, read-only) for
// STATIC + playhead needs only. Dispatches ZERO Ops — no dispatchAtomic,
// no dispatch(), no setParam. It is a pure projection, exactly as
// Dopesheet was (Dopesheet.tsx:7-9).
//
// REF: D-W9-2, D-W9-3 (static + hot path), D-W9-4, D-W9-5, D-W9-7,
//      D-W9-9, D-W9-10; memory/project_p6_w9_plan.md C3+C4;
//      checker FLAG-1; stale-closure pre-mortem (plan C4 §139).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDagStore } from '../core/dag/store';
import type { Node } from '../core/dag/types';
import { useTimeStore } from '../app/stores/timeStore';
import { useViewportStore } from '../app/stores/viewportStore';
import { useTimelineSelection } from './timelineSelection';
import { useSelectionStore } from '../app/stores/selectionStore';
import {
  cullVisibleKeyframes,
  playheadStripRect,
  PLAYHEAD_STRIP_HALF_WIDTH_PX,
} from './timelineCanvasGeometry';
import {
  frameToX,
  xToFrame,
  visibleFrames,
  zoomAtFrame,
  panByPixels,
  DEFAULT_VIEW,
  MIN_ZOOM,
  type TimelineView,
} from './timelineView';
import { useTimelineViewStore } from './timelineViewStore';
import { appendSelectionClipRows, type ChannelRow } from './clipChannelRows';
import { dispatchRetimeKeyframe, dispatchBakeThenRetime } from '../app/animate/dispatchMutator';
import { parseClipRowId, assetRefForChild, type ClipRowComponent } from '../app/animate/bakeOnEdit';

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
  // reze dope-strip diamond: neutral cool-grey base (rgb(170,170,195)),
  // alpha-modulated at paint time for the selected/unselected intensity.
  DIAMOND: '#aaaac3',
  // reze selected-key blue (the dope-strip + curve-key selection colour).
  ACTIVE_DIAMOND: '#5aa0f0',
  // reze playhead red (was the basher accent blue — now matches the curve
  // editor's red playhead so the two surfaces read as one timeline).
  PLAYHEAD: '#d83838',
  ROW_LINE: '#2a2a2a',
  LABEL_TEXT: '#9ca3af',
} as const;

// ── reze-studio chrome (decorative; NOT contrast-gated like PALETTE) ─────
// The frame ruler + grid colours mirror EditableCurve's so the dopesheet and
// the curve editor are visually ONE surface (the unify goal). Kept OUTSIDE
// PALETTE because PALETTE's exact 6-key set + WCAG gate is a pinned contract
// (TimelineCanvas.test.tsx + contrastMatrix.test.ts); these are subtle
// decorative lines/labels, not interactive affordances.
const RULER_BG = '#101018';
const RULER_TICK_MAJOR = '#3a3a48';
const RULER_TICK_MINOR = '#2a2a34';
const GRID_COL_MAJOR = '#2c2c44';
const GRID_COL_MINOR = '#161620';
const DIAMOND_OUTLINE = '#ffffff';

/** Frame ruler band height (CSS px) — reze's 17px top ruler. */
const RULER_H = 17;
/** Row height (CSS px) — one channel row in the dopesheet. */
const ROW_HEIGHT_PX = 24;
/** Diamond box (CSS px) — reze's 45° diamond (~5px half-diagonal). */
const DIAMOND_PX = 10;
/** Edge inset (CSS px) reserved each side of the track so a terminal keyframe
 *  lands flush. Baked into frameToX so default-view geometry === keyframeToRect
 *  (the e2e-safety parity invariant — see timelineView.ts). */
const DIAMOND_INSET_PX = Math.max(4, DIAMOND_PX / 2);
/** Left gutter (CSS px) for channel labels. reze's gutter is 36px because it
 *  holds value-axis NUMBERS for one object's curves; Basher's dopesheet is
 *  multi-channel and must show readable channel NAMES, so it's wider. The
 *  unified curve/value gutter is reconciled at the unify slice. */
const LABEL_GUTTER_PX = 84;
const FPS = 60;
/** Half-width (CSS px) of the playhead's red glow — the rAF strip-restore must
 *  cover this so the glow leaves no trail. reze's glow is ~28px wide → 14 each
 *  side + AA slack. */
const PLAYHEAD_GLOW_HALF_PX = 16;
/** Playhead triangle-head half-width (CSS px), sitting in the ruler band. */
const PLAYHEAD_HEAD_HALF_PX = 5;

/** Adaptive frame step for ruler labels / grid columns so labels never crowd.
 *  Driven by the VISIBLE span (not the whole timeline) so zooming in reveals
 *  finer ticks, mirroring reze. */
function rulerFrameStep(visibleSpanFrames: number): number {
  const s = visibleSpanFrames;
  return s > 240 ? 60 : s > 60 ? 30 : s > 30 ? 10 : s > 10 ? 5 : 1;
}

/** devicePixelRatio capped to [1,2] — copied verbatim from the
 *  Viewport.tsx convention (it passes `dpr={[1,2]}` to R3F's Canvas;
 *  D-W9-10). High-DPI gets crisp text/diamonds; we never pay >2x fill. */
function cappedDpr(): number {
  const raw =
    typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
  return Math.min(Math.max(raw, 1), 2);
}

const CHANNEL_TYPES = new Set([
  'KeyframeChannelNumber',
  'KeyframeChannelVec3',
  'KeyframeChannelQuat',
  'KeyframeChannelColor',
]);

// ChannelRow now lives in clipChannelRows.ts (B1) so the read-only clip-row
// flag is shared across the projector + this collector. Re-exported so
// existing importers of TimelineCanvas's row contract keep working.
export type { ChannelRow };

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
export function collectChannelRows(nodes: Record<string, Node>): ChannelRow[] {
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
      keyframes: (params.keyframes ?? []).slice().sort((a, b) => a.time - b.time),
    };
  };

  // Layer-wired channels first, in layer declaration order.
  for (const node of Object.values(nodes)) {
    if (node.type !== 'AnimationLayer') continue;
    const animation = (node.inputs as Record<string, unknown>).animation;
    const refs = Array.isArray(animation) ? animation : animation ? [animation] : [];
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
  activeKeyframe?: { channelId: string; time: number } | null,
  view: TimelineView = DEFAULT_VIEW,
): number {
  const { cssW, cssH } = dims;
  ctx.clearRect(0, 0, cssW, cssH);

  // Background.
  ctx.fillStyle = PALETTE.CANVAS_BG;
  ctx.fillRect(0, 0, cssW, cssH);

  const trackWidth = Math.max(cssW - LABEL_GUTTER_PX, 0);
  const rowsTop = RULER_H; // rows start BELOW the frame ruler.

  const totalFrames = Math.max(1, Math.round(durationSeconds * FPS));
  // Visible frame window for the shared view (zoom/scroll). At the default
  // view this is [0, totalFrames] → the cull contract (p6-w9) is preserved.
  const { startFrame, endFrame } = visibleFrames(totalFrames, view);
  const visibleStartSec = startFrame / FPS;
  const visibleEndSec = endFrame / FPS;
  const spanFrames = Math.max(endFrame - startFrame, 1);
  const frameStep = rulerFrameStep(spanFrames);

  // x for a frame on this surface (shared zoom/pan + the diamond inset baked
  // in, so default-view geometry === keyframeToRect — the parity invariant).
  const fx = (frame: number) =>
    frameToX(frame, totalFrames, view, LABEL_GUTTER_PX, trackWidth, DIAMOND_INSET_PX);

  // ── Frame-column grid (drawn first, BEHIND rows) ──────────────────────
  // Vertical lines at each ruler frame step over the VISIBLE window, so the
  // dopesheet shares the curve editor's time grid. Major (brighter) at every
  // 4th step — a light visual cadence.
  ctx.lineWidth = 1;
  const firstGrid = Math.ceil(startFrame / frameStep) * frameStep;
  for (let f = Math.max(0, firstGrid); f <= endFrame; f += frameStep) {
    const x = Math.round(fx(f)) + 0.5;
    ctx.strokeStyle = f % (frameStep * 4) === 0 ? GRID_COL_MAJOR : GRID_COL_MINOR;
    ctx.beginPath();
    ctx.moveTo(x, rowsTop);
    ctx.lineTo(x, cssH);
    ctx.stroke();
  }

  let rendered = 0;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const rowTop = rowsTop + r * ROW_HEIGHT_PX;

    // Active-channel row tint (a faint highlight on the pinned channel).
    if (activeChannelId !== null && row.channelId === activeChannelId) {
      ctx.fillStyle = PALETTE.ACTIVE_DIAMOND;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(LABEL_GUTTER_PX, rowTop, cssW - LABEL_GUTTER_PX, ROW_HEIGHT_PX);
      ctx.globalAlpha = 1;
    }

    // Row separator line.
    ctx.lineWidth = 1;
    ctx.strokeStyle = PALETTE.ROW_LINE;
    ctx.beginPath();
    ctx.moveTo(0, rowTop + ROW_HEIGHT_PX + 0.5);
    ctx.lineTo(cssW, rowTop + ROW_HEIGHT_PX + 0.5);
    ctx.stroke();

    // Channel label.
    ctx.fillStyle = PALETTE.LABEL_TEXT;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(row.name, 5, rowTop + ROW_HEIGHT_PX / 2, LABEL_GUTTER_PX - 7);

    // Diamonds — cull to the visible window first so the count is honest.
    const culled = cullVisibleKeyframes(
      row.keyframes.map((k) => ({ timeSeconds: k.time })),
      visibleStartSec,
      visibleEndSec,
    );

    for (const { index } of culled) {
      const t = row.keyframes[index].time;
      const cx = fx(t * FPS);
      const cy = rowsTop + r * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2;
      const selected =
        !!activeKeyframe &&
        activeKeyframe.channelId === row.channelId &&
        Math.abs(activeKeyframe.time - t) <= 0.5 / FPS + 1e-9;

      // reze 45° diamond: neutral cool-grey base alpha-modulated for
      // unselected, the selection blue + white outline when selected.
      ctx.beginPath();
      ctx.moveTo(cx, cy - DIAMOND_PX / 2);
      ctx.lineTo(cx + DIAMOND_PX / 2, cy);
      ctx.lineTo(cx, cy + DIAMOND_PX / 2);
      ctx.lineTo(cx - DIAMOND_PX / 2, cy);
      ctx.closePath();
      if (selected) {
        ctx.fillStyle = PALETTE.ACTIVE_DIAMOND;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = DIAMOND_OUTLINE;
        ctx.stroke();
      } else {
        ctx.fillStyle = PALETTE.DIAMOND;
        ctx.globalAlpha = 0.82;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      rendered++;
    }
  }

  // ── Frame ruler (drawn LAST, over the top band) ───────────────────────
  // A 17px band across the track with major ticks + frame labels at the
  // adaptive step and minor ticks between, so every diamond's frame is
  // legible. The label gutter's ruler corner stays bg (no ticks under it).
  ctx.fillStyle = RULER_BG;
  ctx.fillRect(LABEL_GUTTER_PX, 0, cssW - LABEL_GUTTER_PX, RULER_H);
  ctx.strokeStyle = PALETTE.ROW_LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(LABEL_GUTTER_PX, RULER_H + 0.5);
  ctx.lineTo(cssW, RULER_H + 0.5);
  ctx.stroke();

  const minorStep = Math.max(1, Math.round(frameStep / 2));
  const firstTick = Math.ceil(startFrame / minorStep) * minorStep;
  for (let f = Math.max(0, firstTick); f <= endFrame; f += minorStep) {
    const x = Math.round(fx(f)) + 0.5;
    const major = f % frameStep === 0;
    ctx.strokeStyle = major ? RULER_TICK_MAJOR : RULER_TICK_MINOR;
    ctx.beginPath();
    ctx.moveTo(x, major ? RULER_H - 8 : RULER_H - 4);
    ctx.lineTo(x, RULER_H);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = PALETTE.LABEL_TEXT;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textBaseline = 'top';
      ctx.fillText(String(f), x + 2, 1);
    }
  }

  return rendered;
}

export function TimelineCanvas({ duration }: { duration: number }) {
  const nodes = useDagStore((s) => s.state.nodes);
  const activeChannelId = useTimelineSelection((s) => s.activeChannelId);
  const activeKeyframeId = useTimelineSelection((s) => s.activeKeyframeId);
  // Shared zoom/pan view (read by the curve editor too — seamless tab switch).
  const view = useTimelineViewStore((s) => s.view);
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

  // ── C4 rAF-loop input refs ────────────────────────────────────────────
  // The rAF callback (below) must NEVER close over render-scope vars
  // (the D-W9-3 / context-memo §3 stale-closure trap: a callback created
  // on first render would forever see the first render's dims/dpr/duration
  // even after a resize). Every mutable input the loop needs is therefore
  // routed through a ref these next two effects keep current; the loop
  // reads `*.current` only. `offscreenRef` (C3, declared above) is the
  // same pattern — it is the cache the strip-restore drawImage()'s from.
  // `currentFrameRef`/`seconds` are NOT mirrored here — those are read
  // straight off the stores via getState() inside the loop (single source
  // of truth, zero staleness window by construction).
  const dimsRef = useRef<Dims>(dims);
  const dprRef = useRef<number>(dpr);
  const durationRef = useRef<number>(0);
  // Last playhead x actually drawn — the idle-guard comparand. -1 = never
  // drawn yet, so the first tick always paints.
  const lastPlayheadXRef = useRef<number>(-1);

  // ── P7.1 keyframe drag (D-W9-7) gesture state ─────────────────────────
  // dragRef is the SOLE source of truth for the in-flight drag gesture
  // (D-04 ownership): NOT timeStore (playhead projection, V20
  // single-writer), NOT timelineSelection (durable selection, not a
  // per-frame gesture), NOT the DAG (touched ONCE, at pointerup). `fromTime`
  // is the EXACT stored sample float read off the live DAG at pointerdown
  // (the D-03 discriminator). `canvasLeft` is read ONCE at pointerdown —
  // calling getBoundingClientRect in the rAF tick is the K13 perf footgun.
  const dragRef = useRef<null | {
    channelId: string;
    rowIndex: number;
    fromTime: number;
    pointerClientX: number;
    canvasLeft: number;
    // P7.12 D2 — set ONLY when the dragged row is a read-only imported clip row
    // (B2's `clip:` namespace). Its presence routes endDrag through the
    // copy-on-write bake-then-retime composite instead of the plain retime
    // (the channel does not exist yet — the bake creates it). null = a real
    // baked/authored channel drag (the existing path).
    clipRow?: { assetRef: string; childName: string; component: ClipRowComponent };
  }>(null);
  // The ghost block's OWN idle-guard comparand — a SIBLING of
  // lastPlayheadXRef, never the playhead's. -1 = no ghost / cleared, so
  // the next tick after a commit restores cleanly under the stale ghost.
  const lastGhostXRef = useRef<number>(-1);

  // Ruler-scrub gesture: pointer-down in the frame ruler band scrubs time
  // (the playhead follows seconds via setTime — the timeStore chokepoint that
  // also mirrors currentFrameRef). A SIBLING of dragRef: a ruler scrub never
  // touches the DAG, only timeStore. `true` while a scrub pointer is captured.
  const scrubbingRef = useRef(false);

  // P7.12 B2 — when a GltfChild (imported bone) is selected, append its
  // read-only clip rows so its embedded animation is visible in the dopesheet
  // without a bake. Suppressed once the bone is baked (FLAG-3 single-row-set).
  // Pure: appendSelectionClipRows is a function of (baseRows, nodes, selection).
  const primaryNodeId = useSelectionStore((s) => s.primaryNodeId);
  const rows = useMemo(
    () =>
      appendSelectionClipRows({
        baseRows: collectChannelRows(nodes),
        nodes,
        selectedNodeId: primaryNodeId,
      }),
    [nodes, primaryNodeId],
  );

  // P7.12 B2 — selection → active row. `setActiveChannel` had no production
  // caller before this (research-flagged): selecting a channel row was a
  // click-only affordance. Wire it for the imported-bone path so selecting a
  // GltfChild in the viewport/NPanel surfaces its clip curve in the editor
  // below WITHOUT a manual row click. We set the FIRST clip row (the bone's
  // position component) active, and only when the current active channel is not
  // already one of this bone's clip rows (so a user's manual component click is
  // not stomped on every render).
  const setActiveChannel = useTimelineSelection((s) => s.setActiveChannel);
  useEffect(() => {
    const clipRows = rows.filter((r) => r.readOnly && r.channelId.startsWith('clip:'));
    if (clipRows.length === 0) return;
    const alreadyActive = clipRows.some((r) => r.channelId === activeChannelId);
    if (!alreadyActive) setActiveChannel(clipRows[0].channelId);
  }, [rows, activeChannelId, setActiveChannel]);

  // P6 W10 UIR c-3 — the data-rendered-keyframes mirror attr (D-W9-4 data
  // contract) is the canvas's visual-correctness surrogate. The JSX used
  // to hard-code `0` and let the effect overwrite it post-mount; a static
  // DOM reader (SSR / first-commit / a test reading before effects flush)
  // saw a false `0`. Derive the real culled total from the SAME cull the
  // effect uses so the pre-first-paint attribute already matches. NOT a
  // pixel test (H30 / D-W9-4) — the mirror-attr value IS the contract.
  const renderedKeyframeTotal = useMemo(() => {
    const totalFrames = Math.max(1, Math.round(durationSeconds * FPS));
    const { startFrame, endFrame } = visibleFrames(totalFrames, view);
    const s0 = startFrame / FPS;
    const s1 = endFrame / FPS;
    return rows.reduce(
      (n, row) =>
        n +
        cullVisibleKeyframes(
          row.keyframes.map((k) => ({ timeSeconds: k.time })),
          s0,
          s1,
        ).length,
      0,
    );
  }, [rows, durationSeconds, view]);

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
    // Same value as the JSX init (renderedKeyframeTotal) — the effect
    // re-publishes it on every rows/duration change; the JSX init makes
    // the pre-first-paint DOM already correct (c-3).
    host.dataset.renderedKeyframes = String(renderedKeyframeTotal);
    host.dataset.channelCount = String(rows.length);
    host.dataset.frameCount = String(Math.max(0, Math.round(durationSeconds * 60)));
    // C4 carry: data-playhead-px / data-frame are written by the rAF loop
    // (inherently draw-tied — they describe pixel position, not DAG data).
    // But seed a sane initial value here, on the dims-INDEPENDENT data
    // path (C3 split this effect out precisely because happy-dom's
    // getBoundingClientRect is 0x0, so the pixel effect may never run in
    // tests). `??=` so the rAF loop's later writes are never clobbered by
    // a re-run of this DAG-keyed effect — only the very first, pre-tick
    // read sees '0' instead of `null`.
    host.dataset.playheadPx ??= '0';
    host.dataset.frame ??= '0';
  }, [rows, durationSeconds]);

  // Keep the rAF-loop input refs current. Runs on every commit (no dep
  // array) so dims/dpr/duration the loop reads are always the latest
  // React values WITHOUT the loop closing over them. Cheap: three
  // pointer writes per commit, no DOM, no store.
  useEffect(() => {
    dimsRef.current = dims;
    dprRef.current = dpr;
    durationRef.current = durationSeconds;
  });

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
    paintStaticLayer(offCtx, rows, dims, durationSeconds, activeChannelId, activeKeyframeId, view);

    visCtx.setTransform(1, 0, 0, 1, 0, 0);
    visCtx.clearRect(0, 0, backingW, backingH);
    visCtx.drawImage(offscreen, 0, 0);
    // The static layer was just fully repainted (it overwrites the whole
    // visible canvas, playhead included). Force the next rAF tick to
    // re-stroke the playhead even if x is unchanged — otherwise the idle
    // guard would skip and the playhead would stay erased after a DAG /
    // resize repaint. -1 = "no valid last-drawn x", same sentinel as init.
    lastPlayheadXRef.current = -1;
    // P7.1: the static layer was just fully repainted (a DAG commit — the
    // retime landing — or a resize). Any drag ghost pixels were
    // overwritten by this repaint; reset the ghost idle-guard so the next
    // tick does not "restore" under a stale ghost x that no longer exists.
    lastGhostXRef.current = -1;
  }, [nodes, activeChannelId, activeKeyframeId, durationSeconds, dims, dpr, rows, view]);

  // ── C4: the imperative rAF playhead loop (the perf-critical hot path) ──
  //
  // The D-W9-3 escape hatch and the actual 60fps fix. Self-reschedules
  // via requestAnimationFrame; mount-once ([] deps) because it closes
  // over NOTHING from render scope — every mutable input is read fresh
  // each tick via getState() (the stores) or `*.current` (the C3-synced
  // refs). That is the entire stale-closure mitigation: there is no
  // render-scope variable for the closure to freeze.
  //
  // Lifecycle (krama, hot path ≤16.6ms): rAF tick → getState()/ref reads
  // (no React) → secondsToX (C2 pure) → idle compare → [on change] strip
  // restore (drawImage from C3 offscreen) → stroke playhead LAST → two
  // data-attr writes. Unmount → cancelAnimationFrame (leak guard).
  useEffect(() => {
    let rafId = 0;

    function tick() {
      const host = hostRef.current;
      const visible = canvasRef.current;
      const offscreen = offscreenRef.current;
      const { cssW, cssH } = dimsRef.current;

      // Nothing to paint onto / restore from yet (pre-layout, or the C3
      // effect has not built the offscreen cache). Stay registered — the
      // cache appears asynchronously after the first layout pass; killing
      // the loop here would need a re-arm signal we deliberately avoid.
      if (host && visible && offscreen && cssW > 0 && cssH > 0) {
        const visCtx = visible.getContext('2d');
        if (visCtx) {
          // Mutable inputs — read FRESH every tick. Stores via getState()
          // (NOT subscribed, NOT closure-captured: the D-W9-3 / §3
          // stale-closure mitigation, and the single source of truth so
          // ref↔store cannot diverge here). dpr/duration via the
          // C3-synced refs, never render scope.
          const seconds = useTimeStore.getState().seconds;
          const frame = useViewportStore.getState().currentFrameRef.current;
          const dprNow = dprRef.current;
          const durationNow = durationRef.current;
          // The shared zoom/pan view — read fresh via getState (single source
          // of truth, like seconds; never closure-captured) so the playhead
          // tracks zoom/pan with zero React render (V20 / the rAF bypass).
          const viewNow = useTimelineViewStore.getState().view;

          // frameToX (shared with the static layer + curve editor) maps the
          // playhead's frame through the zoom/pan view + diamond inset, so the
          // playhead lines up exactly with the diamonds at the same frame.
          const trackWidth = Math.max(cssW - LABEL_GUTTER_PX, 0);
          const totalFramesNow = Math.max(1, Math.round(durationNow * FPS));
          const newX = frameToX(
            seconds * FPS,
            totalFramesNow,
            viewNow,
            LABEL_GUTTER_PX,
            trackWidth,
            DIAMOND_INSET_PX,
          );

          // IDLE GUARD (LOCKED — plan C4 §129): unchanged x → early-out
          // but STAY registered (do NOT cancel/re-arm). Cheaper than
          // wiring a wake signal from timeStore.play/scrub; mirrors
          // Clock.tsx:9-11's "loop runs even when paused, just no-ops".
          if (newX !== lastPlayheadXRef.current) {
            const oldX = lastPlayheadXRef.current;

            // Work in BACKING pixels with the identity transform — the
            // exact convention C3 used to blit offscreen→visible
            // (visCtx.drawImage(offscreen,0,0) with setTransform identity,
            // both canvases at cssW*dpr × cssH*dpr). Matching it here
            // makes the strip-restore a pixel-perfect twin of the cache;
            // C2 geometry is CSS px, so every coord is *dprNow into
            // backing space. (Re-derives nothing — C2 still owns the
            // CSS-px math; this is only the CSS→backing scale C3 also
            // applies, kept identical so the two paths stay aligned.)
            visCtx.setTransform(1, 0, 0, 1, 0, 0);

            // 1. Restore the static pixels under the OLD playhead from
            //    the C3 offscreen cache. This is why the cache exists:
            //    drawImage copies the EXACT painted pixels back —
            //    diamonds the old line overlapped included — so the
            //    playhead never erases the static layer (proven by C5's
            //    e2e: data-rendered-keyframes constant across a scrub).
            //    Skip on the first paint (oldX < 0): nothing drawn yet.
            if (oldX >= 0) {
              // Restore a strip wide enough for the GLOW (not just the 1px
              // line), else the glow trails behind the moving playhead.
              const strip = playheadStripRect(oldX, PLAYHEAD_GLOW_HALF_PX, cssH);
              if (strip.w > 0 && strip.h > 0) {
                // 1:1 backing-px blit: src rect == dst rect, both scaled
                // CSS→backing by dprNow. The offscreen is the
                // identity-blitted twin of the visible canvas (C3), so
                // copying the same backing rect restores the exact
                // static pixels — diamonds included.
                const sx = strip.x * dprNow;
                const sy = strip.y * dprNow;
                const sw = strip.w * dprNow;
                const sh = strip.h * dprNow;
                visCtx.drawImage(offscreen, sx, sy, sw, sh, sx, sy, sw, sh);
              }
            }

            // 2. Draw the reze playhead at the NEW x — DRAWN LAST, on top
            //    of the restored static layer (D-W9-3 "playhead always
            //    drawn last"). Backing-px space (×dprNow). Order: a soft
            //    red GLOW (transparent→red→transparent horizontal gradient),
            //    then the crisp 1px line, then a triangle HEAD in the ruler.
            const bxCss = newX;
            const bx = newX * dprNow + 0.5;

            const glow = visCtx.createLinearGradient(
              (bxCss - PLAYHEAD_GLOW_HALF_PX) * dprNow,
              0,
              (bxCss + PLAYHEAD_GLOW_HALF_PX) * dprNow,
              0,
            );
            glow.addColorStop(0, 'rgba(216,56,56,0)');
            glow.addColorStop(0.5, 'rgba(216,56,56,0.22)');
            glow.addColorStop(1, 'rgba(216,56,56,0)');
            visCtx.fillStyle = glow;
            visCtx.fillRect(
              (bxCss - PLAYHEAD_GLOW_HALF_PX) * dprNow,
              0,
              PLAYHEAD_GLOW_HALF_PX * 2 * dprNow,
              cssH * dprNow,
            );

            visCtx.strokeStyle = PALETTE.PLAYHEAD;
            visCtx.lineWidth = dprNow;
            visCtx.beginPath();
            visCtx.moveTo(bx, 0);
            visCtx.lineTo(bx, cssH * dprNow);
            visCtx.stroke();

            // Triangle head pointing down, seated in the ruler band.
            visCtx.fillStyle = PALETTE.PLAYHEAD;
            visCtx.beginPath();
            visCtx.moveTo((bxCss - PLAYHEAD_HEAD_HALF_PX) * dprNow, 0);
            visCtx.lineTo((bxCss + PLAYHEAD_HEAD_HALF_PX) * dprNow, 0);
            visCtx.lineTo(bx, (PLAYHEAD_HEAD_HALF_PX + 3) * dprNow);
            visCtx.closePath();
            visCtx.fill();

            lastPlayheadXRef.current = newX;

            // 3. Publish the mirror attrs. These are draw-tied by nature
            //    (they describe the playhead's pixel position + the
            //    escape-hatch frame) so they live in the loop, NOT the
            //    C3 data effect — which only seeds the pre-tick '0'.
            if (host) {
              host.dataset.playheadPx = String(newX);
              host.dataset.frame = String(frame);
            }
          }

          // ── P7.1 LIVE GHOST (D-04 / FLAG-1) ──────────────────────────
          // A SIBLING block of the playhead idle-guard above — same rAF
          // tick, but its OWN independent guard. It MUST NOT be nested in
          // the playhead's `if (newX !== lastPlayheadXRef.current)`: a
          // PAUSED director dragging a keyframe has a moving cursor but
          // ZERO playhead delta, so gating the ghost on the playhead
          // idle-compare would FREEZE it mid-drag (FLAG-1). The ghost runs
          // on `if (dragRef.current)` + its OWN lastGhostXRef compare,
          // independent of and in ADDITION to the playhead block, and
          // AFTER it (W9 "playhead/overlay drawn last" ordering).
          const drag = dragRef.current;
          if (drag) {
            const trackWidth = Math.max(cssW - LABEL_GUTTER_PX, 0);
            // cursorX: canvas-relative px (incl. gutter). canvasLeft was read
            // ONCE at pointerdown (NO getBoundingClientRect in the hot loop —
            // the K13 perf footgun). Map through the shared zoom/pan view so
            // the ghost snaps to the cursor's frame at the current zoom.
            const cursorX = drag.pointerClientX - drag.canvasLeft;
            const ghostFrameRaw = xToFrame(
              cursorX,
              totalFramesNow,
              viewNow,
              LABEL_GUTTER_PX,
              trackWidth,
              DIAMOND_INSET_PX,
            );
            const ghostFrame =
              ghostFrameRaw < 0
                ? 0
                : ghostFrameRaw > totalFramesNow
                  ? totalFramesNow
                  : ghostFrameRaw;
            const ghostX = frameToX(
              ghostFrame,
              totalFramesNow,
              viewNow,
              LABEL_GUTTER_PX,
              trackWidth,
              DIAMOND_INSET_PX,
            );

            // The ghost's OWN idle guard, keyed to ITS driver (the
            // cursor), never the playhead's newX. An idle drag (cursor
            // not moving) adds no per-frame redraw.
            if (ghostX !== lastGhostXRef.current) {
              const oldGhostX = lastGhostXRef.current;
              const rowTop = RULER_H + drag.rowIndex * ROW_HEIGHT_PX;
              const cy = rowTop + ROW_HEIGHT_PX / 2;

              visCtx.setTransform(1, 0, 0, 1, 0, 0);

              // Restore the static pixels under the LAST ghost position
              // from the C3 offscreen cache — same drawImage mechanism +
              // strip rect the playhead uses, so the ghost never smears
              // the cached static layer (the W9 cache-restore contract).
              if (oldGhostX >= 0) {
                const strip = playheadStripRect(
                  oldGhostX,
                  PLAYHEAD_STRIP_HALF_WIDTH_PX + DIAMOND_PX,
                  cssH,
                );
                if (strip.w > 0 && strip.h > 0) {
                  const sx = strip.x * dprNow;
                  const sy = strip.y * dprNow;
                  const sw = strip.w * dprNow;
                  const sh = strip.h * dprNow;
                  visCtx.drawImage(offscreen, sx, sy, sw, sh, sx, sy, sw, sh);
                }
              }

              // Draw the ghost diamond at ghostX on the dragged row,
              // reusing PALETTE.ACTIVE_DIAMOND (the existing
              // selected-keyframe color — NO new token; B11 no-shift).
              // Drawn AFTER the playhead block (W9 overlay-last).
              const gx = ghostX * dprNow;
              const gy = cy * dprNow;
              const gh = (DIAMOND_PX / 2) * dprNow;
              visCtx.fillStyle = PALETTE.ACTIVE_DIAMOND;
              visCtx.beginPath();
              visCtx.moveTo(gx, gy - gh);
              visCtx.lineTo(gx + gh, gy);
              visCtx.lineTo(gx, gy + gh);
              visCtx.lineTo(gx - gh, gy);
              visCtx.closePath();
              visCtx.fill();

              lastGhostXRef.current = ghostX;
            }
          }
        }
      }

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, []);

  // ── Wheel zoom/pan (shared view) ──────────────────────────────────────
  // Native non-passive listener so preventDefault reliably stops page scroll
  // (React's synthetic onWheel can be passive). Ctrl/⌘+wheel = TIME zoom
  // anchored on the playhead; plain wheel = horizontal PAN. Reads everything
  // via getState() so it never goes stale (mounted once). The dopesheet has no
  // value axis, so Shift+wheel falls through to pan here (value zoom is the
  // curve editor's concern).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function onWheelNative(e: WheelEvent) {
      if (!canvas) return;
      const box = canvas.getBoundingClientRect();
      const trackWidth = Math.max(box.width - LABEL_GUTTER_PX, 0);
      const duration = useTimeStore.getState().durationSeconds;
      const total = Math.max(1, Math.round(duration * FPS));
      const current = useTimelineViewStore.getState().view;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const next = current.zoom * factor;
        if (next <= MIN_ZOOM && current.zoom <= MIN_ZOOM) return; // already fit
        const anchorFrame = useTimeStore.getState().seconds * FPS;
        useTimelineViewStore.getState().setView(zoomAtFrame(current, total, anchorFrame, next));
      } else {
        const deltaPx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        if (deltaPx === 0) return;
        const next = panByPixels(current, total, deltaPx, trackWidth);
        if (next !== current) {
          e.preventDefault();
          useTimelineViewStore.getState().setView(next);
        }
      }
    }
    canvas.addEventListener('wheel', onWheelNative, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheelNative);
  }, []);

  // ── P7.1 pointer handlers (D-04, D-06: single keyframe, horizontal) ───
  // THIN by design (Ousterhout): hit-test via pure geometry, store ONE
  // ref, call ONE seam fn. NO Mutator/Op/DAG-internal type in this file;
  // NO setState / DAG write on the move path (V20 — the hot path adds no
  // React subscription and no second time/frame writer).

  const totalFrames = Math.max(1, Math.round(durationSeconds * FPS));

  /** Canvas-relative x → seconds through the shared zoom/pan view (+ diamond
   *  inset), the inverse of the diamonds' frameToX. Clamped to [0, duration]. */
  function localXToSeconds(clientX: number, canvasLeft: number): number {
    const canvas = canvasRef.current;
    const cssW = canvas ? canvas.clientWidth : 0;
    const trackWidth = Math.max(cssW - LABEL_GUTTER_PX, 0);
    const f = xToFrame(
      clientX - canvasLeft,
      totalFrames,
      view,
      LABEL_GUTTER_PX,
      trackWidth,
      DIAMOND_INSET_PX,
    );
    const clamped = f < 0 ? 0 : f > totalFrames ? totalFrames : f;
    return clamped / FPS;
  }

  /** Ruler x → seconds — the same view-aware inverse, so a scrub lands the
   *  playhead exactly under the cursor at any zoom. Clamped to [0, duration]. */
  function rulerXToSeconds(clientX: number, box: DOMRect): number {
    return localXToSeconds(clientX, box.left);
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    const trackWidth = Math.max(box.width - LABEL_GUTTER_PX, 0);

    // Ruler-band click/drag → SCRUB time (reze's col-resize scrub). Takes
    // priority over diamond hit-testing (the ruler sits above the rows).
    if (py <= RULER_H && px >= LABEL_GUTTER_PX) {
      scrubbingRef.current = true;
      useTimeStore.getState().setTime(rulerXToSeconds(e.clientX, box));
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // Hit-test every row's every keyframe with the SAME geometry +
    // gutter offset paintStaticLayer:285-293 uses (do NOT re-derive a
    // different offset). ±DIAMOND_PX hit-slop so an 8px diamond is
    // grabbable. First match wins.
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (const kf of row.keyframes) {
        // Same view-aware frameToX the static layer paints with, so the hit
        // target tracks zoom/pan. cy mirrors the ruler-offset row center.
        const cx = frameToX(
          kf.time * FPS,
          totalFrames,
          view,
          LABEL_GUTTER_PX,
          trackWidth,
          DIAMOND_INSET_PX,
        );
        const cy = RULER_H + r * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2;
        const slop = DIAMOND_PX;
        if (
          Math.abs(px - cx) <= DIAMOND_PX / 2 + slop &&
          Math.abs(py - cy) <= DIAMOND_PX / 2 + slop
        ) {
          // P7.12 D2 — a read-only imported CLIP row (B2's `clip:` namespace)
          // has no DAG node yet; its keyframe time comes straight off the
          // projected clip row. Dragging it is the COPY-ON-WRITE trigger: store
          // the clip-row context so endDrag bakes-then-retimes (R3). The bake +
          // edit become ONE undo via dispatchBakeThenRetime.
          const clip = parseClipRowId(row.channelId);
          if (clip) {
            const assetRef = assetRefForChild(useDagStore.getState().state.nodes, clip.childName);
            if (!assetRef) continue;
            dragRef.current = {
              channelId: row.channelId,
              rowIndex: r,
              fromTime: kf.time, // the projected clip key time (exact)
              pointerClientX: e.clientX,
              canvasLeft: box.left,
              clipRow: { assetRef, childName: clip.childName, component: clip.component },
            };
            useTimelineSelection.getState().setActiveKeyframe({
              channelId: row.channelId,
              time: kf.time,
            });
            canvas.setPointerCapture(e.pointerId);
            return;
          }
          // Read the EXACT stored sample time off the LIVE DAG — this
          // float becomes fromTime, the D-03 discriminator (NOT a
          // pointerup-recomputed seconds, or removeKeyframes silently
          // no-ops and the drag duplicates the key).
          const live = useDagStore.getState().state.nodes[row.channelId];
          const liveParams = (live?.params ?? {}) as {
            keyframes?: Array<{ time: number }>;
          };
          const liveSample = (liveParams.keyframes ?? []).find((k) => k.time === kf.time);
          if (!liveSample) continue;
          dragRef.current = {
            channelId: row.channelId,
            rowIndex: r,
            fromTime: liveSample.time,
            pointerClientX: e.clientX,
            canvasLeft: box.left, // read ONCE here (perf — D-04)
          };
          useTimelineSelection.getState().setActiveKeyframe({
            channelId: row.channelId,
            time: liveSample.time,
          });
          canvas.setPointerCapture(e.pointerId);
          return;
        }
      }
    }
    // Miss: do nothing (existing behavior passes through).
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    // Ruler scrub: drive time as the cursor moves. setTime is the chokepoint
    // that also mirrors currentFrameRef, so the rAF playhead follows.
    if (scrubbingRef.current) {
      const canvas = canvasRef.current;
      if (canvas)
        useTimeStore.getState().setTime(rulerXToSeconds(e.clientX, canvas.getBoundingClientRect()));
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    // O(1): write the only mutable per-move datum. NO setState, NO DAG,
    // NO draw — the rAF loop draws the ghost (V20 hot-path discipline).
    drag.pointerClientX = e.clientX;
  }

  function endDrag(e: React.PointerEvent<HTMLCanvasElement>, commit: boolean) {
    // End a ruler scrub (no DAG commit — scrub only moved time).
    if (scrubbingRef.current) {
      scrubbingRef.current = false;
      try {
        canvasRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be gone */
      }
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    const canvas = canvasRef.current;
    try {
      canvas?.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    if (commit) {
      const toTime = localXToSeconds(drag.pointerClientX, drag.canvasLeft);
      // An unmoved click is a no-op (exact !== — same discipline as the
      // seam's fromTime match).
      if (toTime !== drag.fromTime) {
        if (drag.clipRow) {
          // P7.12 D2 — FIRST edit of a clip-backed bone: bake the clip track
          // into editable channels AND retime the dragged key, as ONE atomic
          // undo (K6). The composite re-targets the now-real baked channel by
          // its deterministic id (D1). On {ok:false} it aborted atomically.
          dispatchBakeThenRetime({
            assetRef: drag.clipRow.assetRef,
            childName: drag.clipRow.childName,
            component: drag.clipRow.component,
            fromTime: drag.fromTime,
            toTime,
          });
        } else {
          // ONE seam call → atomic composite → one undo entry. On
          // {ok:false} the seam aborted atomically; DAG already unchanged.
          dispatchRetimeKeyframe({
            channelId: drag.channelId,
            fromTime: drag.fromTime,
            toTime,
          });
        }
      }
    }
    // Force the next tick to cleanly restore under the now-stale ghost.
    // The DAG-keyed static repaint (nodes effect) re-paints the diamond
    // at its committed time and also resets this; setting -1 here covers
    // the no-commit cancel path where no repaint fires.
    lastGhostXRef.current = -1;
  }

  return (
    <div
      ref={hostRef}
      data-testid="timeline-canvas"
      role="img"
      aria-label={`Animation dopesheet — ${rows.length} channels`}
      data-frame-count={Math.max(0, Math.round(durationSeconds * 60))}
      data-channel-count={rows.length}
      data-rendered-keyframes={renderedKeyframeTotal}
      className="relative h-full w-full overflow-hidden bg-bg"
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
      />
    </div>
  );
}
