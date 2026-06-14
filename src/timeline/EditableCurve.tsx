// EditableCurve — the reze-studio-style graph editor for an authored Number /
// Vec3 KeyframeChannel (UX-BACKLOG #11 slice 2).
//
// Renders the channel's REAL cubic-bézier curve(s) — sampled THROUGH the shared
// `keyframeInterp` core, the SAME math the evaluator/renderer use, so the curve
// drawn is the curve played (the H40 display-side rule: never a divergent sample
// path). Per-axis colors, a value gutter + frame ruler + grid, draggable
// keyframe dots (time + value), bézier-handle display for the selected key, and
// a red playhead. Handle DRAG lands in slice 2b.
//
// SVG (not canvas): Basher channels hold tens of keys, not reze's thousands, so
// SVG gives the same visual with trivial pointer hit-testing AND preserves the
// `curve-track-N` polyline testids the p163/p7.12/p3 e2e read.
//
// REF: UX-BACKLOG #11; src/nodes/keyframeInterp.ts (shared sampler); vyapti V49.

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useDagStore } from '../core/dag/store';
import { sampleScalarKeyframes, type ScalarKey } from '../nodes/keyframeInterp';
import { useTimelineSelection } from './timelineSelection';

// reze palette — rotation channels read R/G/B, translation/scale read
// orange/teal/purple; a scalar channel reads a single accent.
const ROT_COLORS = ['#e25555', '#44bb55', '#4477dd'];
const TRS_COLORS = ['#e2a055', '#55bba0', '#7755dd'];
const SCALAR_COLOR = '#9aa0ff';
const GRID_MINOR = '#161620';
const GRID_MAJOR = '#2c2c44';
const AXIS_LINE = '#222233';
const RULER_TEXT = '#9ca3af';
const PLAYHEAD = '#d83838';
const HANDLE_LINE = 'rgba(156,163,175,0.5)';

const LABEL_W = 40; // left value gutter
const RULER_H = 16; // top frame ruler
const PAD_Y = 10; // vertical breathing room inside the plot
const FPS = 60;

type Handle = { time: number; value: number | readonly number[] };
interface RawKey {
  time: number;
  value: number | readonly number[];
  easing: 'linear' | 'cubic';
  inHandle?: Handle;
  outHandle?: Handle;
}

function isVec3Channel(type: string): boolean {
  return type === 'KeyframeChannelVec3';
}

function axisColors(type: string, paramPath: string): string[] {
  if (!isVec3Channel(type)) return [SCALAR_COLOR];
  return paramPath.toLowerCase().includes('rotation') ? ROT_COLORS : TRS_COLORS;
}

/** Project a raw keyframe onto ONE scalar axis (vec channels) — the per-axis
 *  curve the evaluator produces (the shared time-handle is preserved, so the
 *  x→s solve matches segmentVec3 exactly). */
function projectAxis(k: RawKey, axis: number, isVec: boolean): ScalarKey {
  const v = isVec ? (k.value as readonly number[])[axis] : (k.value as number);
  const proj = (h: Handle | undefined): { time: number; value: number } | undefined =>
    h
      ? { time: h.time, value: isVec ? (h.value as readonly number[])[axis] : (h.value as number) }
      : undefined;
  return {
    time: k.time,
    value: v,
    easing: k.easing,
    inHandle: proj(k.inHandle),
    outHandle: proj(k.outHandle),
  };
}

interface Domain {
  min: number;
  max: number;
}

export function EditableCurve({
  channelId,
  channelType,
  paramPath,
  keyframes,
  duration,
  seconds,
}: {
  channelId: string;
  channelType: string;
  paramPath: string;
  keyframes: RawKey[];
  duration: number;
  seconds: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 600, h: 200 });
  const activeKeyframe = useTimelineSelection((s) => s.activeKeyframeId);
  const setActiveKeyframe = useTimelineSelection((s) => s.setActiveKeyframe);
  // Live drag preview: a keyframes override shown while the pointer is down; the
  // store commit happens once on release (reze's mutate-then-commit).
  const [draft, setDraft] = useState<RawKey[] | null>(null);
  const dragRef = useRef<{
    kind: 'key' | 'in' | 'out';
    index: number;
    axis: number;
    pointerId: number;
  } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const r = host.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const isVec = isVec3Channel(channelType);
  const axes = useMemo(() => (isVec ? [0, 1, 2] : [0]), [isVec]);
  const colors = axisColors(channelType, paramPath);
  const keys = draft ?? keyframes;

  const { w, h } = size;
  const plotX0 = LABEL_W;
  const plotX1 = w;
  const plotY0 = RULER_H;
  const plotY1 = h;
  const dur = Math.max(duration, 0.0001);

  // Value domain over every axis's keyframe values + handle extents, padded.
  const domain: Domain = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    const visit = (v: number) => {
      if (v < min) min = v;
      if (v > max) max = v;
    };
    for (const k of keys) {
      for (const a of axes) {
        const sk = projectAxis(k, a, isVec);
        visit(sk.value);
        if (sk.outHandle) visit(sk.value + sk.outHandle.value);
        if (sk.inHandle) visit(sk.value + sk.inHandle.value);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 };
    if (Math.abs(max - min) < 1e-6) return { min: min - 1, max: max + 1 };
    const pad = (max - min) * 0.12;
    return { min: min - pad, max: max + pad };
  }, [keys, axes, isVec]);

  const timeToX = (t: number) => plotX0 + (t / dur) * (plotX1 - plotX0);
  const xToTime = (x: number) => ((x - plotX0) / Math.max(plotX1 - plotX0, 1)) * dur;
  const valueToY = (v: number) =>
    plotY1 - PAD_Y - ((v - domain.min) / (domain.max - domain.min)) * (plotY1 - plotY0 - 2 * PAD_Y);
  const yToValue = (y: number) =>
    domain.min +
    ((plotY1 - PAD_Y - y) / Math.max(plotY1 - plotY0 - 2 * PAD_Y, 1)) * (domain.max - domain.min);

  // Per-axis sampled polylines (real bézier via the shared core).
  const polylines = useMemo(() => {
    const steps = Math.max(8, Math.round(plotX1 - plotX0) >> 1);
    return axes.map((a) => {
      const sk = keys.map((k) => projectAxis(k, a, isVec)).sort((p, q) => p.time - q.time);
      const pts: string[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * dur;
        pts.push(`${timeToX(t).toFixed(2)},${valueToY(sampleScalarKeyframes(sk, t)).toFixed(2)}`);
      }
      return pts.join(' ');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, axes, isVec, dur, domain, w, h]);

  // Gridlines / ruler ticks every N frames so labels don't crowd.
  const totalFrames = Math.max(1, Math.round(dur * FPS));
  const frameStep = totalFrames > 240 ? 60 : totalFrames > 60 ? 30 : 10;
  const frameTicks: number[] = [];
  for (let f = 0; f <= totalFrames; f += frameStep) frameTicks.push(f);
  const valueTicks = niceTicks(domain.min, domain.max, 4);

  function commit(next: RawKey[]) {
    useDagStore
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: channelId, paramPath: 'keyframes', value: next }],
        'user',
        'edit curve',
      );
  }

  // keyframes arrives pre-sorted from CurveEditor, so the array index IS the
  // time order — neighbors are index±1 (no reference findIndex needed).
  function startDrag(
    e: React.PointerEvent,
    index: number,
    kind: 'key' | 'in' | 'out',
    axis: number,
  ) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { kind, index, axis, pointerId: e.pointerId };
    setDraft(keyframes.map((k) => ({ ...k })));
    setActiveKeyframe({ channelId, time: keyframes[index].time });
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || !draft) return;
    const rect = hostRef.current!.getBoundingClientRect();
    // The <svg> coordinate system is w×h units but CSS stretches it to the
    // container, so convert client pixels → svg units by the live scale (the
    // two can differ in the window before the ResizeObserver commits size).
    const px = (e.clientX - rect.left) * (w / Math.max(rect.width, 1));
    const py = (e.clientY - rect.top) * (h / Math.max(rect.height, 1));
    const k = draft[d.index];
    const spanLeft = d.index > 0 ? k.time - draft[d.index - 1].time : dur / 4;
    const spanRight = d.index < draft.length - 1 ? draft[d.index + 1].time - k.time : dur / 4;

    let next: RawKey[];
    if (d.kind === 'key') {
      // Move the key: time clamped strictly between neighbors (order can't flip);
      // value of the grabbed AXIS drags freely (other components untouched).
      const lo = d.index > 0 ? draft[d.index - 1].time + 1e-3 : 0;
      const hi = d.index < draft.length - 1 ? draft[d.index + 1].time - 1e-3 : dur;
      const nextTime = Math.min(Math.max(xToTime(px), lo), hi);
      const nextVal = yToValue(py);
      next = draft.map((kk, i) =>
        i !== d.index
          ? kk
          : isVec
            ? {
                ...kk,
                time: nextTime,
                value: setAxis(kk.value as readonly number[], d.axis, nextVal),
              }
            : { ...kk, time: nextTime, value: nextVal },
      );
    } else {
      // Drag a bézier handle: x → time offset (clamped to its half-segment so the
      // curve stays a function of time, V49), y → value offset on this axis.
      const kvAxis = isVec ? (k.value as readonly number[])[d.axis] : (k.value as number);
      const span = d.kind === 'out' ? spanRight : spanLeft;
      let offT = xToTime(px) - k.time;
      offT =
        d.kind === 'out'
          ? Math.min(Math.max(offT, 1e-3), span - 1e-3)
          : Math.max(Math.min(offT, -1e-3), -(span - 1e-3));
      const offV = yToValue(py) - kvAxis;
      const base = fullHandle(k, d.kind, isVec, span);
      const handle: Handle = isVec
        ? { time: offT, value: setAxis(base.value as readonly number[], d.axis, offV) }
        : { time: offT, value: offV };
      next = draft.map((kk, i) =>
        i !== d.index
          ? kk
          : d.kind === 'out'
            ? { ...kk, outHandle: handle }
            : { ...kk, inHandle: handle },
      );
    }
    setDraft(next);
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = dragRef.current;
    if (d && draft) {
      commit(draft.slice().sort((a, b) => a.time - b.time));
    }
    dragRef.current = null;
    setDraft(null);
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }

  const activeIndex =
    activeKeyframe && activeKeyframe.channelId === channelId
      ? keys.findIndex((k) => Math.abs(k.time - activeKeyframe.time) <= 0.5 / FPS + 1e-9)
      : -1;

  return (
    <div
      ref={hostRef}
      data-testid="curve-editor"
      className="relative h-full w-full bg-bg"
      style={{ touchAction: 'none' }}
    >
      <div className="pointer-events-none absolute left-12 top-1 z-10 text-[10px] text-mute">
        {channelType.replace('KeyframeChannel', '')} — {paramPath || '(no path)'}
      </div>
      <svg
        className="absolute inset-0"
        width={w}
        height={h}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* grid — value rows */}
        {valueTicks.map((v, i) => (
          <g key={`vt-${i}`}>
            <line
              x1={plotX0}
              y1={valueToY(v)}
              x2={plotX1}
              y2={valueToY(v)}
              stroke={Math.abs(v) < 1e-9 ? GRID_MAJOR : GRID_MINOR}
              strokeWidth={1}
            />
            <text
              x={LABEL_W - 4}
              y={valueToY(v) + 3}
              textAnchor="end"
              fontSize={9}
              fill={RULER_TEXT}
              fontFamily="ui-monospace, monospace"
            >
              {formatValue(v)}
            </text>
          </g>
        ))}
        {/* grid — frame columns + ruler labels */}
        {frameTicks.map((f, i) => {
          const x = timeToX(f / FPS);
          return (
            <g key={`ft-${i}`}>
              <line x1={x} y1={plotY0} x2={x} y2={plotY1} stroke={GRID_MINOR} strokeWidth={1} />
              <text
                x={x + 2}
                y={11}
                fontSize={9}
                fill={RULER_TEXT}
                fontFamily="ui-monospace, monospace"
              >
                {f}
              </text>
            </g>
          );
        })}
        {/* axis frame */}
        <line x1={plotX0} y1={plotY0} x2={plotX0} y2={plotY1} stroke={AXIS_LINE} strokeWidth={1} />
        <line x1={plotX0} y1={plotY0} x2={plotX1} y2={plotY0} stroke={AXIS_LINE} strokeWidth={1} />

        {/* curves */}
        {polylines.map((pts, ti) => (
          <polyline
            key={`tk-${ti}`}
            data-testid={`curve-track-${ti}`}
            fill="none"
            stroke={colors[ti % colors.length]}
            strokeWidth={isVec ? 1.4 : 2}
            points={pts}
          />
        ))}

        {/* bézier-handle display for the selected keyframe (drag lands 2b) */}
        {activeIndex >= 0 &&
          axes.map((a) => {
            const k = keys[activeIndex];
            const sk = projectAxis(k, a, isVec);
            const span = neighborSpan(keys, activeIndex, dur);
            const kx = timeToX(k.time);
            const ky = valueToY(sk.value);
            const segs: ReactElement[] = [];
            const out = sk.outHandle ?? autoHandle(span, 'out');
            const inn = sk.inHandle ?? autoHandle(span, 'in');
            const ox = timeToX(k.time + out.time);
            const oy = valueToY(sk.value + out.value);
            const ix = timeToX(k.time + inn.time);
            const iy = valueToY(sk.value + inn.value);
            segs.push(
              <line
                key={`ho-${a}`}
                x1={kx}
                y1={ky}
                x2={ox}
                y2={oy}
                stroke={HANDLE_LINE}
                strokeWidth={1}
              />,
              <line
                key={`hi-${a}`}
                x1={kx}
                y1={ky}
                x2={ix}
                y2={iy}
                stroke={HANDLE_LINE}
                strokeWidth={1}
              />,
              <circle
                key={`hoc-${a}`}
                data-testid={`curve-handle-out-${a}`}
                cx={ox}
                cy={oy}
                r={3}
                fill="var(--bg)"
                stroke={colors[a % colors.length]}
                strokeWidth={1.2}
                style={{ cursor: 'grab' }}
                onPointerDown={(e) => startDrag(e, activeIndex, 'out', a)}
              />,
              <circle
                key={`hic-${a}`}
                data-testid={`curve-handle-in-${a}`}
                cx={ix}
                cy={iy}
                r={3}
                fill="var(--bg)"
                stroke={colors[a % colors.length]}
                strokeWidth={1.2}
                style={{ cursor: 'grab' }}
                onPointerDown={(e) => startDrag(e, activeIndex, 'in', a)}
              />,
            );
            return <g key={`h-${a}`}>{segs}</g>;
          })}

        {/* keyframe dots (draggable) */}
        {keys.map((k, i) =>
          axes.map((a) => {
            const sk = projectAxis(k, a, isVec);
            const selected = i === activeIndex;
            return (
              <circle
                key={`kf-${i}-${a}`}
                data-testid={`curve-key-${i}-${a}`}
                cx={timeToX(k.time)}
                cy={valueToY(sk.value)}
                r={selected ? 4.5 : 3.5}
                fill={selected ? '#9ca3af' : colors[a % colors.length]}
                stroke={selected ? colors[a % colors.length] : 'none'}
                strokeWidth={selected ? 1.5 : 0}
                style={{ cursor: 'grab' }}
                onPointerDown={(e) => startDrag(e, i, 'key', a)}
              />
            );
          }),
        )}

        {/* playhead */}
        <line
          data-testid="curve-playhead"
          x1={timeToX(Math.min(seconds, dur))}
          y1={plotY0}
          x2={timeToX(Math.min(seconds, dur))}
          y2={plotY1}
          stroke={PLAYHEAD}
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}

/** A flat display handle (offset) at ±span/3 — the grab affordance shown for a
 *  selected key that carries no explicit handle yet (dragging it makes it real). */
function autoHandle(span: number, which: 'in' | 'out'): { time: number; value: number } {
  return { time: which === 'out' ? span / 3 : -span / 3, value: 0 };
}

/** Span to the relevant neighbor (for handle length), defaulting to dur/4. */
function neighborSpan(keys: RawKey[], index: number, dur: number): number {
  const left = index > 0 ? keys[index].time - keys[index - 1].time : dur / 4;
  const right = index < keys.length - 1 ? keys[index + 1].time - keys[index].time : dur / 4;
  return Math.max(Math.min(left, right) || dur / 4, 1e-3);
}

/** Return a new value tuple with one axis replaced (vec keyframe edits). */
function setAxis(vec: readonly number[], axis: number, value: number): number[] {
  const out = [...vec];
  out[axis] = value;
  return out;
}

/** The full (Vec3 or scalar) handle to seed a handle drag from: the explicit
 *  handle if present, else a flat auto handle so the non-dragged axes keep a
 *  sensible offset (0) instead of jumping. */
function fullHandle(
  k: RawKey,
  which: 'in' | 'out',
  isVec: boolean,
  span: number,
): { time: number; value: number | number[] } {
  const ex = which === 'out' ? k.outHandle : k.inHandle;
  if (ex) {
    return {
      time: ex.time,
      value: isVec ? [...(ex.value as readonly number[])] : (ex.value as number),
    };
  }
  const t = which === 'out' ? span / 3 : -span / 3;
  return { time: t, value: isVec ? [0, 0, 0] : 0 };
}

/** Human value-axis labels — short integers/decimals depending on magnitude. */
function formatValue(v: number): string {
  if (Math.abs(v) >= 100) return Math.round(v).toString();
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** ~n evenly spaced "nice" tick values spanning [min,max]. */
function niceTicks(min: number, max: number, n: number): number[] {
  const range = max - min;
  if (range <= 0) return [min];
  const raw = range / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}
