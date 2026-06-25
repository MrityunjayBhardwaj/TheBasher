// LayerTimeline — the Compositor's layer timeline (spine 1c.3a): an AE-style
// outline column (one row per layer: twirl, name, visibility/solo/lock) beside a
// track area (each layer's time bar on a frame ruler, with the playhead). Rows
// render FRONT-on-top (the `layers` list is back→front; AE shows front first).
//
// Bars are draggable (3b): the left/right handles trim inPoint/outPoint, the body
// slides startFrame, a locked layer ignores the gesture, and rows reorder by drag.
// 3c folds the dopesheet IN: a twirl opens per-layer property rows (opacity +
// rotation) whose values keyframe via the SAME free-floating [[V57]] channels +
// ParamDiamond the 3D inspector uses (H104 — wire the affordance once), with the
// channel's keyframes drawn as diamonds on the comp ruler. Geometry + the drag
// math live in videoTimelineGeometry (H95: one place for the constants the e2e
// mirrors). Edits go through setParam ops (V1), one atomic per drag.
//
// REF: docs/COMPOSITOR-DESIGN.md §7; vyapti V1 (ops) + V34 + V50 (shared timeline
//      geometry) + V57 (keyframe channels); hetvabhasa H95 + H104; issue #237.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDagStore } from '../../core/dag/store';
import { useTimeStore, FRAMES_PER_SECOND } from '../stores/timeStore';
import type { NodeId, Op } from '../../core/dag/types';
import type { CompositionParams } from '../../nodes/Composition';
import { ParamDiamond } from '../ParamDiamond';
import { useAnimatableField, useAnimatableVec2Field } from '../animate/useAnimatableField';
import {
  buildAddLayerEffectOps,
  buildReorderLayerOps,
  collectChannelKeyframes,
  collectLayerEffects,
  collectLayerRows,
  type LayerEffectRow,
  type LayerRow,
} from './videoLayers';
import { buildRemoveEffectOps, buildToggleEffectMuteOp } from '../operatorStack';
import {
  BAR_TRIM_HANDLE_PX,
  OUTLINE_WIDTH_PX,
  ROW_HEIGHT_PX,
  RULER_HEIGHT_PX,
  applyBarDrag,
  barPercent,
  compFrameToSeconds,
  frameToPercent,
  globalFrameToCompFrame,
  layerBarSpan,
  xDeltaToFrameDelta,
  xToCompFrame,
  type BarDragMode,
  type LayerBarParams,
} from './videoTimelineGeometry';

const RULER_TICKS = 4; // → ticks at 0, ¼, ½, ¾, end
/** Movement (CSS px) past which a press becomes a drag, not a click-to-select. */
const DRAG_THRESHOLD_PX = 3;

/** A keyframeable scalar property of a layer, shown as a twirl-down dopesheet row.
 *  `paramPath` is the channel target path; `get` reads the authored base from the
 *  row. (Vec2 position/scale rows — needing a vector read path — land in 3c-ii.) */
interface LayerProp {
  key: string;
  label: string;
  paramPath: string;
  step: number;
  get: (r: LayerRow) => number;
}

const LAYER_PROPS: readonly LayerProp[] = [
  { key: 'opacity', label: 'Opacity', paramPath: 'opacity', step: 0.05, get: (r) => r.opacity },
  {
    key: 'rotation',
    label: 'Rotation',
    paramPath: 'transform.rotation',
    step: 1,
    get: (r) => r.rotation,
  },
];

/** A keyframeable Vec2 property of a layer (2D transform position/scale), shown as
 *  a twirl-down row with TWO axis fields + ONE diamond keying the whole vector
 *  (the NPanel VectorField precedent). `paramPath` is the channel target path. */
interface LayerVec2Prop {
  key: string;
  label: string;
  paramPath: string;
  step: number;
  get: (r: LayerRow) => readonly [number, number];
}

const LAYER_VEC2_PROPS: readonly LayerVec2Prop[] = [
  {
    key: 'position',
    label: 'Position',
    paramPath: 'transform.position',
    step: 1,
    get: (r) => r.position,
  },
  { key: 'scale', label: 'Scale', paramPath: 'transform.scale', step: 0.05, get: (r) => r.scale },
];

/** A keyframeable scalar param of an EFFECT node, shown as a sub-row under the
 *  effect's twirl. `paramPath` targets the effect node directly (free-floating
 *  [[V57]] channel); `get` reads the authored value off the effect row. */
interface EffectProp {
  key: string;
  label: string;
  paramPath: string;
  step: number;
  get: (e: LayerEffectRow) => number;
}

const EFFECT_PROPS: readonly EffectProp[] = [
  {
    key: 'brightness',
    label: 'Brightness',
    paramPath: 'brightness',
    step: 0.05,
    get: (e) => e.brightness,
  },
  { key: 'contrast', label: 'Contrast', paramPath: 'contrast', step: 0.05, get: (e) => e.contrast },
  {
    key: 'saturation',
    label: 'Saturation',
    paramPath: 'saturation',
    step: 0.05,
    get: (e) => e.saturation,
  },
];

/** A row in the rendered timeline: a layer, one of its open property rows, one of
 *  its effect rows, one of an open effect's param sub-rows, or its "add effect" row. */
type VisualRow =
  | { kind: 'layer'; row: LayerRow; layerIndex: number }
  | { kind: 'prop'; row: LayerRow; layerIndex: number; prop: LayerProp }
  | { kind: 'vec2-prop'; row: LayerRow; layerIndex: number; prop: LayerVec2Prop }
  | { kind: 'effect'; row: LayerRow; layerIndex: number; effect: LayerEffectRow }
  | {
      kind: 'effect-prop';
      row: LayerRow;
      layerIndex: number;
      effect: LayerEffectRow;
      prop: EffectProp;
    }
  | { kind: 'effect-add'; row: LayerRow; layerIndex: number };

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function setLayerParam(layerId: NodeId, paramPath: string, value: unknown, label: string): void {
  useDagStore
    .getState()
    .dispatchAtomic([{ type: 'setParam', nodeId: layerId, paramPath, value }], 'user', label);
}

/** Add a video effect onto a layer's source edge (V58 stack, top), one atomic. */
function addLayerEffect(layerId: NodeId, effectType: string): void {
  const ops = buildAddLayerEffectOps(useDagStore.getState().state, layerId, effectType);
  if (ops.length) useDagStore.getState().dispatchAtomic(ops, 'user', `add ${effectType}`);
}

/** Remove an effect, splicing the Image chain closed (one atomic). */
function removeEffect(effectId: NodeId): void {
  const ops = buildRemoveEffectOps(useDagStore.getState().state, effectId);
  if (ops?.length) useDagStore.getState().dispatchAtomic(ops, 'user', 'remove effect');
}

/** Toggle an effect's mute (the V58 stack bypass). */
function toggleEffectMute(effectId: NodeId): void {
  const op = buildToggleEffectMuteOp(useDagStore.getState().state, effectId);
  if (op) useDagStore.getState().dispatchAtomic([op], 'user', 'toggle effect mute');
}

/** An in-flight bar drag — the start anchor + the layer's params at grab time. */
interface BarDrag {
  layerId: NodeId;
  mode: BarDragMode;
  startClientX: number;
  trackWidthPx: number;
  totalFrames: number;
  srcFrames: number;
  orig: LayerBarParams;
  moved: boolean;
}

const DRAG_LABELS: Record<BarDragMode, string> = {
  'trim-left': 'trim layer in-point',
  'trim-right': 'trim layer out-point',
  slide: 'slide layer in time',
};

export function LayerTimeline({ compId, comp }: { compId: NodeId; comp: CompositionParams }) {
  const rows = useDagStore((s) => collectLayerRows(s.state, compId));
  const dagState = useDagStore((s) => s.state);
  const frame = useTimeStore((s) => s.frame);
  const [selectedId, setSelectedId] = useState<NodeId | null>(null);
  const [openRows, setOpenRows] = useState<ReadonlySet<NodeId>>(() => new Set());
  const toggleTwirl = useCallback((id: NodeId) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // Per-effect twirl (the AE "Effect Controls" expand): an open effect shows its
  // keyframeable param sub-rows (Brightness/Contrast/Saturation).
  const [openEffects, setOpenEffects] = useState<ReadonlySet<NodeId>>(() => new Set());
  const toggleEffectTwirl = useCallback((id: NodeId) => {
    setOpenEffects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const totalFrames = Math.max(1, comp.durationFrames ?? 150);
  const fps = comp.fps ?? 30;
  // The global playhead (60fps seconds) mapped into this comp's frame space
  // (the SAME shared map the viewer + transport readout use — H95).
  const playheadFrame = globalFrameToCompFrame(frame, FRAMES_PER_SECOND, fps, totalFrames);
  const playheadPct = frameToPercent(playheadFrame, totalFrames);

  // Bar drag (3b): the track element (for measuring px width), the live drag, a
  // preview of the dragged layer's params, and a flag to swallow the trailing
  // click so a drag never also selects.
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<BarDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [preview, setPreview] = useState<{ layerId: NodeId; params: LayerBarParams } | null>(null);

  const onWindowMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const deltaPx = e.clientX - d.startClientX;
    if (Math.abs(deltaPx) > DRAG_THRESHOLD_PX) d.moved = true;
    const deltaFrames = xDeltaToFrameDelta(deltaPx, d.trackWidthPx, d.totalFrames);
    setPreview({
      layerId: d.layerId,
      params: applyBarDrag(d.orig, d.srcFrames, d.mode, deltaFrames),
    });
  }, []);

  const onWindowUp = useCallback(
    (e: PointerEvent) => {
      window.removeEventListener('pointermove', onWindowMove);
      window.removeEventListener('pointerup', onWindowUp);
      const d = dragRef.current;
      dragRef.current = null;
      setPreview(null);
      if (!d) return;
      if (!d.moved) return; // a click, not a drag → selection handled by onClick
      suppressClickRef.current = true;
      const deltaFrames = xDeltaToFrameDelta(
        e.clientX - d.startClientX,
        d.trackWidthPx,
        d.totalFrames,
      );
      const next = applyBarDrag(d.orig, d.srcFrames, d.mode, deltaFrames);
      const ops: Op[] = [];
      if (next.startFrame !== d.orig.startFrame)
        ops.push({
          type: 'setParam',
          nodeId: d.layerId,
          paramPath: 'startFrame',
          value: next.startFrame,
        });
      if (next.inPoint !== d.orig.inPoint)
        ops.push({
          type: 'setParam',
          nodeId: d.layerId,
          paramPath: 'inPoint',
          value: next.inPoint,
        });
      if (next.outPoint !== d.orig.outPoint)
        ops.push({
          type: 'setParam',
          nodeId: d.layerId,
          paramPath: 'outPoint',
          value: next.outPoint,
        });
      if (ops.length) useDagStore.getState().dispatchAtomic(ops, 'user', DRAG_LABELS[d.mode]);
    },
    [onWindowMove],
  );

  // Stop listening if the timeline unmounts mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onWindowMove);
      window.removeEventListener('pointerup', onWindowUp);
    };
  }, [onWindowMove, onWindowUp]);

  const onBarPointerDown = useCallback(
    (e: React.PointerEvent, row: LayerRow, mode: BarDragMode) => {
      if (row.locked) return; // lock gates drag (the L toggle)
      const track = trackRef.current;
      if (!track) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        layerId: row.id,
        mode,
        startClientX: e.clientX,
        trackWidthPx: track.getBoundingClientRect().width,
        totalFrames,
        srcFrames: row.srcFrames,
        orig: { startFrame: row.startFrame, inPoint: row.inPoint, outPoint: row.outPoint },
        moved: false,
      };
      setPreview(null);
      window.addEventListener('pointermove', onWindowMove);
      window.addEventListener('pointerup', onWindowUp);
    },
    [totalFrames, onWindowMove, onWindowUp],
  );

  const onRowClick = useCallback((id: NodeId) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return; // the press was a drag, not a select
    }
    setSelectedId(id);
  }, []);

  // Ruler scrub (transport): press/drag anywhere on the frame ruler to move the
  // GLOBAL playhead. The pointer x (relative to the track) → comp frame → global
  // seconds via the SHARED map (H95), so the press lands on the frame the playhead
  // draws and the composite redraws there. Measures the live track width (the bars
  // are laid out in %; a pointer arrives in px).
  const scrubToClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const compFrame = xToCompFrame(clientX - rect.left, rect.width, totalFrames);
      useTimeStore.getState().setTime(compFrameToSeconds(compFrame, fps));
    },
    [totalFrames, fps],
  );
  const onScrubMove = useCallback((e: PointerEvent) => scrubToClientX(e.clientX), [scrubToClientX]);
  const onScrubUp = useCallback(() => {
    window.removeEventListener('pointermove', onScrubMove);
    window.removeEventListener('pointerup', onScrubUp);
  }, [onScrubMove]);
  const onRulerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      scrubToClientX(e.clientX);
      window.addEventListener('pointermove', onScrubMove);
      window.addEventListener('pointerup', onScrubUp);
    },
    [scrubToClientX, onScrubMove, onScrubUp],
  );
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onScrubMove);
      window.removeEventListener('pointerup', onScrubUp);
    };
  }, [onScrubMove, onScrubUp]);

  // Row drag (3b-ii): drag an outline row vertically to reorder comp.layers. Rows
  // render front-on-top (display index 0 = top/front). With twirls open, the rows
  // aren't uniform layers — every VISUAL row is still ROW_HEIGHT, so a drop maps to
  // a visual slot whose owning layer (`visualMap`) is the reorder target; the
  // dropped layer index converts to a raw index (back→front) for the op.
  const rowsRef = useRef<HTMLDivElement>(null);
  const visualRowsRef = useRef<VisualRow[]>([]);
  const rowDragRef = useRef<{
    layerId: NodeId;
    containerTop: number;
    visualMap: number[]; // visual-row index → owning layer's display index
    layerCount: number;
    moved: boolean;
  } | null>(null);
  const [rowDragId, setRowDragId] = useState<NodeId | null>(null);
  const [dropDisplay, setDropDisplay] = useState<number | null>(null);

  const dropIndexAt = (clientY: number, top: number, visualCount: number) =>
    clamp(Math.floor((clientY - top) / ROW_HEIGHT_PX), 0, visualCount - 1);

  const onRowWindowMove = useCallback((e: PointerEvent) => {
    const d = rowDragRef.current;
    if (!d) return;
    d.moved = true;
    setDropDisplay(dropIndexAt(e.clientY, d.containerTop, d.visualMap.length));
  }, []);

  const onRowWindowUp = useCallback(
    (e: PointerEvent) => {
      window.removeEventListener('pointermove', onRowWindowMove);
      window.removeEventListener('pointerup', onRowWindowUp);
      const d = rowDragRef.current;
      rowDragRef.current = null;
      setRowDragId(null);
      setDropDisplay(null);
      if (!d || !d.moved) return;
      suppressClickRef.current = true;
      const visualIdx = dropIndexAt(e.clientY, d.containerTop, d.visualMap.length);
      const targetLayer = d.visualMap[visualIdx]; // which layer the drop slot belongs to
      const rawTo = d.layerCount - 1 - targetLayer; // display (front-on-top) → raw (back→front)
      const ops = buildReorderLayerOps(useDagStore.getState().state, compId, d.layerId, rawTo);
      if (ops.length) useDagStore.getState().dispatchAtomic(ops, 'user', 'reorder layer');
    },
    [compId, onRowWindowMove],
  );

  const onRowPointerDown = useCallback(
    (e: React.PointerEvent, row: LayerRow) => {
      if (row.locked) return; // lock gates reorder
      if ((e.target as HTMLElement).closest('button')) return; // a toggle, not a drag-grab
      const container = rowsRef.current;
      if (!container) return;
      const visual = visualRowsRef.current;
      rowDragRef.current = {
        layerId: row.id,
        containerTop: container.getBoundingClientRect().top,
        visualMap: visual.map((v) => v.layerIndex),
        layerCount: rows.length,
        moved: false,
      };
      setRowDragId(row.id);
      window.addEventListener('pointermove', onRowWindowMove);
      window.addEventListener('pointerup', onRowWindowUp);
    },
    [rows.length, onRowWindowMove, onRowWindowUp],
  );

  // Stop listening if the timeline unmounts mid row-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onRowWindowMove);
      window.removeEventListener('pointerup', onRowWindowUp);
    };
  }, [onRowWindowMove, onRowWindowUp]);

  // Front-on-top: the layers list is back→front; reverse for display. A twirl-open
  // layer expands into its property rows (the dopesheet folding in). `visualRows`
  // is the ONE ordered list both columns render, so outline + track stay aligned.
  const display = [...rows].reverse();
  const visualRows: VisualRow[] = [];
  display.forEach((row, layerIndex) => {
    visualRows.push({ kind: 'layer', row, layerIndex });
    if (openRows.has(row.id)) {
      for (const prop of LAYER_PROPS) visualRows.push({ kind: 'prop', row, layerIndex, prop });
      for (const prop of LAYER_VEC2_PROPS)
        visualRows.push({ kind: 'vec2-prop', row, layerIndex, prop });
      // The layer's effect stack (V58 on the Image socket) + an add-effect row. An
      // open effect expands into its keyframeable param sub-rows (2b).
      for (const effect of collectLayerEffects(dagState, row.id)) {
        visualRows.push({ kind: 'effect', row, layerIndex, effect });
        if (openEffects.has(effect.nodeId)) {
          for (const prop of EFFECT_PROPS)
            visualRows.push({ kind: 'effect-prop', row, layerIndex, effect, prop });
        }
      }
      visualRows.push({ kind: 'effect-add', row, layerIndex });
    }
  });
  visualRowsRef.current = visualRows;

  return (
    <div
      data-testid="layer-timeline"
      className="flex flex-1 overflow-auto"
      style={{ minHeight: 0 }}
    >
      {/* Outline column (left): layer names + toggles. */}
      <div
        className="flex shrink-0 flex-col border-r border-line bg-bg"
        style={{ width: OUTLINE_WIDTH_PX }}
      >
        <div
          className="flex items-center border-b border-line px-2 text-[10px] uppercase tracking-wide text-mute"
          style={{ height: RULER_HEIGHT_PX }}
        >
          Layers
        </div>
        <div ref={rowsRef} className="relative">
          {visualRows.map((v) => {
            if (v.kind === 'layer') {
              return (
                <OutlineRow
                  key={v.row.id}
                  row={v.row}
                  open={openRows.has(v.row.id)}
                  selected={v.row.id === selectedId}
                  dragging={v.row.id === rowDragId}
                  onSelect={() => onRowClick(v.row.id)}
                  onToggleTwirl={() => toggleTwirl(v.row.id)}
                  onPointerDownDrag={(e) => onRowPointerDown(e, v.row)}
                />
              );
            }
            if (v.kind === 'prop') {
              return (
                <OutlinePropRow
                  key={`${v.row.id}-${v.prop.key}`}
                  layerId={v.row.id}
                  prop={v.prop}
                  base={v.prop.get(v.row)}
                />
              );
            }
            if (v.kind === 'vec2-prop') {
              return (
                <OutlineVec2PropRow
                  key={`${v.row.id}-${v.prop.key}`}
                  layerId={v.row.id}
                  prop={v.prop}
                  base={v.prop.get(v.row)}
                />
              );
            }
            if (v.kind === 'effect') {
              return (
                <OutlineEffectRow
                  key={v.effect.nodeId}
                  effect={v.effect}
                  open={openEffects.has(v.effect.nodeId)}
                  onToggleTwirl={() => toggleEffectTwirl(v.effect.nodeId)}
                />
              );
            }
            if (v.kind === 'effect-prop') {
              return (
                <OutlineEffectPropRow
                  key={`${v.effect.nodeId}-${v.prop.key}`}
                  effect={v.effect}
                  prop={v.prop}
                />
              );
            }
            return <OutlineAddEffectRow key={`${v.row.id}-add-fx`} layerId={v.row.id} />;
          })}
          {/* Drop indicator — where a dragged row would land. */}
          {dropDisplay !== null && (
            <div
              data-testid="layer-row-drop-indicator"
              className="pointer-events-none absolute left-0 right-0 h-0.5 bg-accent"
              style={{ top: dropDisplay * ROW_HEIGHT_PX }}
            />
          )}
        </div>
      </div>

      {/* Track column (right): the coordinate space for bars + ruler + playhead. */}
      <div ref={trackRef} className="relative flex-1 bg-bg-2" style={{ minWidth: 0 }}>
        {/* Frame ruler — press/drag to scrub the playhead (transport). */}
        <div
          data-testid="layer-timeline-ruler"
          onPointerDown={onRulerPointerDown}
          className="relative cursor-ew-resize border-b border-line"
          style={{ height: RULER_HEIGHT_PX }}
        >
          {Array.from({ length: RULER_TICKS + 1 }, (_, i) => {
            const tickFrame = Math.round((totalFrames * i) / RULER_TICKS);
            return (
              <span
                key={i}
                className="absolute top-1/2 -translate-y-1/2 px-1 text-[10px] text-mute"
                style={{ left: `${frameToPercent(tickFrame, totalFrames)}%` }}
              >
                {tickFrame}
              </span>
            );
          })}
        </div>
        {/* Layer bars + (when open) keyframe rows. */}
        <div>
          {visualRows.map((v) => {
            if (v.kind === 'prop' || v.kind === 'vec2-prop') {
              return (
                <TrackKeyframeRow
                  key={`${v.row.id}-${v.prop.key}`}
                  nodeId={v.row.id}
                  paramPath={v.prop.paramPath}
                  testid={`layer-keyframe-${v.row.id}-${v.prop.key}`}
                  totalFrames={totalFrames}
                  fps={fps}
                />
              );
            }
            // An open effect's param sub-row draws its channel keyframes on the ruler.
            if (v.kind === 'effect-prop') {
              return (
                <TrackKeyframeRow
                  key={`${v.effect.nodeId}-${v.prop.key}`}
                  nodeId={v.effect.nodeId}
                  paramPath={v.prop.paramPath}
                  testid={`layer-effect-keyframe-${v.effect.nodeId}-${v.prop.key}`}
                  totalFrames={totalFrames}
                  fps={fps}
                />
              );
            }
            // Effect header + add-effect rows have no track content — an empty row
            // keeps both columns aligned.
            if (v.kind === 'effect') {
              return <TrackSpacerRow key={`${v.effect.nodeId}-track`} />;
            }
            if (v.kind === 'effect-add') {
              return <TrackSpacerRow key={`${v.row.id}-add-fx-track`} />;
            }
            // While dragging this layer, render from the live preview params.
            const shown =
              preview && preview.layerId === v.row.id ? { ...v.row, ...preview.params } : v.row;
            return (
              <TrackRow
                key={v.row.id}
                row={shown}
                totalFrames={totalFrames}
                selected={v.row.id === selectedId}
                onSelect={() => onRowClick(v.row.id)}
                onPointerDownMode={(e, mode) => onBarPointerDown(e, v.row, mode)}
              />
            );
          })}
        </div>
        {/* Playhead — spans the rows below the ruler. */}
        <div
          data-testid="layer-timeline-playhead"
          className="pointer-events-none absolute w-px bg-accent"
          style={{ top: RULER_HEIGHT_PX, bottom: 0, left: `${playheadPct}%` }}
        />
      </div>
    </div>
  );
}

function OutlineRow({
  row,
  open,
  selected,
  dragging,
  onSelect,
  onToggleTwirl,
  onPointerDownDrag,
}: {
  row: LayerRow;
  open: boolean;
  selected: boolean;
  dragging: boolean;
  onSelect: () => void;
  onToggleTwirl: () => void;
  onPointerDownDrag: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      data-testid={`layer-row-${row.id}`}
      data-selected={selected}
      data-dragging={dragging}
      onClick={onSelect}
      onPointerDown={onPointerDownDrag}
      className={`flex items-center gap-1 border-b border-line px-1.5 text-[11px] ${
        row.locked ? '' : 'cursor-grab active:cursor-grabbing'
      } ${dragging ? 'opacity-50' : ''} ${selected ? 'bg-accent/15' : 'hover:bg-muted/30'}`}
      style={{ height: ROW_HEIGHT_PX }}
    >
      {/* Twirl — opens the layer's keyframe property rows (the dopesheet, 3c). */}
      <button
        type="button"
        data-testid={`layer-twirl-${row.id}`}
        data-open={open}
        aria-label={open ? 'Collapse layer properties' : 'Expand layer properties'}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          onToggleTwirl();
        }}
        className="w-3 select-none text-center text-mute hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {open ? '▾' : '▸'}
      </button>
      <span className="flex-1 truncate text-fg" title={row.name}>
        {row.name}
      </span>
      <ToggleButton
        testId={`layer-vis-${row.id}`}
        label="Toggle visibility"
        active={row.enabled}
        glyph={row.enabled ? '◉' : '◌'}
        onToggle={() => setLayerParam(row.id, 'enabled', !row.enabled, 'toggle layer visibility')}
      />
      <ToggleButton
        testId={`layer-solo-${row.id}`}
        label="Toggle solo"
        active={row.solo}
        glyph="S"
        onToggle={() => setLayerParam(row.id, 'solo', !row.solo, 'toggle layer solo')}
      />
      <ToggleButton
        testId={`layer-lock-${row.id}`}
        label="Toggle lock"
        active={row.locked}
        glyph="L"
        onToggle={() => setLayerParam(row.id, 'locked', !row.locked, 'toggle layer lock')}
      />
    </div>
  );
}

function ToggleButton({
  testId,
  label,
  active,
  glyph,
  onToggle,
}: {
  testId: string;
  label: string;
  active: boolean;
  glyph: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active}
      aria-label={label}
      aria-pressed={active}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`flex h-4 w-4 items-center justify-center rounded text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        active ? 'text-accent' : 'text-fg/40 hover:text-fg'
      }`}
    >
      {glyph}
    </button>
  );
}

/** Round to 2 decimals as a display string (drops float noise on the readout). */
function round2(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** An open twirl-down property row in the OUTLINE column: an indented label, an
 *  editable value field routed through the [[V57]] animatable seam (auto-keys when
 *  animated), and the inspector ParamDiamond keying at the playhead (H104). */
function OutlinePropRow({
  layerId,
  prop,
  base,
}: {
  layerId: NodeId;
  prop: LayerProp;
  base: number;
}) {
  const { effective, readOnly, onEdit } = useAnimatableField<number>(
    layerId,
    prop.paramPath,
    base,
    (next) => setLayerParam(layerId, prop.paramPath, next, `set ${prop.label}`),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = parseFloat(draft);
    if (Number.isFinite(n)) onEdit(n);
    setDraft(null);
  };
  return (
    <div
      data-testid={`layer-prop-row-${layerId}-${prop.key}`}
      className="flex items-center gap-1 border-b border-line pl-1 pr-1.5 text-[11px]"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <span className="w-3" aria-hidden /> {/* twirl gutter */}
      <span className="flex-1 truncate pl-4 text-mute" title={prop.label}>
        {prop.label}
      </span>
      <input
        type="number"
        step={prop.step}
        value={draft ?? round2(effective)}
        readOnly={readOnly}
        data-testid={`layer-prop-input-${layerId}-${prop.key}`}
        onFocus={() => setDraft(round2(effective))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-14 rounded border border-line bg-bg-2 px-1 text-right text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
      <ParamDiamond
        nodeId={layerId}
        paramPath={prop.paramPath}
        value={base}
        testid={`layer-prop-diamond-${layerId}-${prop.key}`}
      />
    </div>
  );
}

/** An open twirl-down Vec2 property row in the OUTLINE column (Position / Scale):
 *  an indented label, TWO axis fields (X, Y), and ONE inspector ParamDiamond keying
 *  the WHOLE vector at the playhead (the NPanel VectorField precedent; H104). Routed
 *  through the Vec2 animatable seam — keys a KeyframeChannelVec2 targeting the Layer
 *  node directly ([[V57]]). An edit to either axis writes the whole [x,y]. */
function OutlineVec2PropRow({
  layerId,
  prop,
  base,
}: {
  layerId: NodeId;
  prop: LayerVec2Prop;
  base: readonly [number, number];
}) {
  const { effective, readOnly, onEdit } = useAnimatableVec2Field(
    layerId,
    prop.paramPath,
    base,
    (next) => setLayerParam(layerId, prop.paramPath, next, `set ${prop.label}`),
  );
  // A per-axis local draft; committing applies the WHOLE vector (the other axis
  // taken from `effective`) through the single-write seam.
  const [draft, setDraft] = useState<{ axis: 0 | 1; text: string } | null>(null);
  const commitAxis = (axis: 0 | 1) => {
    if (!draft || draft.axis !== axis) return;
    const n = parseFloat(draft.text);
    if (Number.isFinite(n)) {
      const next: [number, number] = [effective[0], effective[1]];
      next[axis] = n;
      onEdit(next);
    }
    setDraft(null);
  };
  const axisField = (axis: 0 | 1, label: string) => (
    <input
      type="number"
      step={prop.step}
      aria-label={`${prop.label} ${label}`}
      value={draft?.axis === axis ? draft.text : round2(effective[axis])}
      readOnly={readOnly}
      data-testid={`layer-prop-input-${layerId}-${prop.key}-${label.toLowerCase()}`}
      onFocus={() => setDraft({ axis, text: round2(effective[axis]) })}
      onChange={(e) => setDraft({ axis, text: e.target.value })}
      onBlur={() => commitAxis(axis)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commitAxis(axis);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="w-10 rounded border border-line bg-bg-2 px-1 text-right text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    />
  );
  return (
    <div
      data-testid={`layer-prop-row-${layerId}-${prop.key}`}
      className="flex items-center gap-1 border-b border-line pl-1 pr-1.5 text-[11px]"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <span className="w-3" aria-hidden /> {/* twirl gutter */}
      <span className="flex-1 truncate pl-4 text-mute" title={prop.label}>
        {prop.label}
      </span>
      {axisField(0, 'X')}
      {axisField(1, 'Y')}
      <ParamDiamond
        nodeId={layerId}
        paramPath={prop.paramPath}
        value={base}
        testid={`layer-prop-diamond-${layerId}-${prop.key}`}
      />
    </div>
  );
}

/** An effect row in the OUTLINE column (a member of the layer's V58 Image-effect
 *  stack): a twirl that opens its keyframeable param sub-rows, a mute toggle, the
 *  effect name, and a remove ✕. The params (Brightness/Contrast/Saturation) live in
 *  the twirl-down sub-rows (OutlineEffectPropRow) so each can be keyframed (2b). */
function OutlineEffectRow({
  effect,
  open,
  onToggleTwirl,
}: {
  effect: LayerEffectRow;
  open: boolean;
  onToggleTwirl: () => void;
}) {
  return (
    <div
      data-testid={`layer-effect-row-${effect.nodeId}`}
      data-muted={effect.muted}
      className="flex items-center gap-1 border-b border-line pl-1 pr-1.5 text-[11px]"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <button
        type="button"
        data-testid={`layer-effect-twirl-${effect.nodeId}`}
        data-open={open}
        aria-label={open ? 'Collapse effect params' : 'Expand effect params'}
        aria-expanded={open}
        onClick={onToggleTwirl}
        className="w-3 select-none text-center text-mute hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {open ? '▾' : '▸'}
      </button>
      <ToggleButton
        testId={`layer-effect-mute-${effect.nodeId}`}
        label="Toggle effect mute"
        active={!effect.muted}
        glyph={effect.muted ? '⊘' : '◉'}
        onToggle={() => toggleEffectMute(effect.nodeId)}
      />
      <span className="flex-1 truncate pl-1 text-mute" title={effect.type}>
        {effect.type}
      </span>
      <button
        type="button"
        data-testid={`layer-effect-remove-${effect.nodeId}`}
        aria-label="Remove effect"
        onClick={() => removeEffect(effect.nodeId)}
        className="flex h-4 w-4 items-center justify-center rounded text-[10px] text-fg/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        ✕
      </button>
    </div>
  );
}

/** An open effect's keyframeable param sub-row in the OUTLINE column: an indented
 *  label, an editable field routed through the [[V57]] animatable seam, and the
 *  inspector ParamDiamond keying at the playhead — targeting the EFFECT node
 *  directly (H104: a custom control wires the affordance or its params can't
 *  animate). The diamond testid is distinct from the layer-prop scheme (H95). */
function OutlineEffectPropRow({ effect, prop }: { effect: LayerEffectRow; prop: EffectProp }) {
  const base = prop.get(effect);
  const { effective, readOnly, onEdit } = useAnimatableField<number>(
    effect.nodeId,
    prop.paramPath,
    base,
    (next) => setLayerParam(effect.nodeId, prop.paramPath, next, `set ${prop.label}`),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = parseFloat(draft);
    if (Number.isFinite(n)) onEdit(n);
    setDraft(null);
  };
  return (
    <div
      data-testid={`layer-effect-prop-row-${effect.nodeId}-${prop.key}`}
      className="flex items-center gap-1 border-b border-line pl-1 pr-1.5 text-[11px]"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <span className="w-3" aria-hidden /> {/* twirl gutter */}
      <span className="flex-1 truncate pl-8 text-mute" title={prop.label}>
        {prop.label}
      </span>
      <input
        type="number"
        step={prop.step}
        value={draft ?? round2(effective)}
        readOnly={readOnly}
        data-testid={`layer-effect-prop-input-${effect.nodeId}-${prop.key}`}
        onFocus={() => setDraft(round2(effective))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-14 rounded border border-line bg-bg-2 px-1 text-right text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
      <ParamDiamond
        nodeId={effect.nodeId}
        paramPath={prop.paramPath}
        value={base}
        testid={`layer-effect-diamond-${effect.nodeId}-${prop.key}`}
      />
    </div>
  );
}

/** The "+ Color Correct" add-effect row at the bottom of a layer's twirl-down. */
function OutlineAddEffectRow({ layerId }: { layerId: NodeId }) {
  return (
    <div
      className="flex items-center gap-1 border-b border-line pl-1 pr-1.5"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <span className="w-3" aria-hidden /> {/* twirl gutter */}
      <button
        type="button"
        data-testid={`layer-add-effect-${layerId}`}
        onClick={() => addLayerEffect(layerId, 'ColorCorrect')}
        className="rounded px-1 text-[11px] text-accent hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        + Color Correct
      </button>
    </div>
  );
}

/** An empty TRACK-column row, keeping the two columns row-aligned for outline rows
 *  that have no track content yet (effect rows; effect keyframes land in 2b). */
function TrackSpacerRow() {
  return <div className="border-b border-line bg-bg" style={{ height: ROW_HEIGHT_PX }} />;
}

/** The TRACK half of an open property row (a layer prop OR an effect param): the
 *  channel's keyframes drawn as diamonds on the comp ruler (keyframe seconds → comp
 *  frame → percent). The channel target is `(nodeId, paramPath)` — the Layer node
 *  for layer props, the effect node for effect params. Read-only; drag-to-retime is
 *  a follow-up. */
function TrackKeyframeRow({
  nodeId,
  paramPath,
  testid,
  totalFrames,
  fps,
}: {
  nodeId: NodeId;
  paramPath: string;
  testid: string;
  totalFrames: number;
  fps: number;
}) {
  const times = useDagStore((s) => collectChannelKeyframes(s.state, nodeId, paramPath));
  return (
    <div className="relative border-b border-line bg-bg" style={{ height: ROW_HEIGHT_PX }}>
      {times.map((t, i) => (
        <span
          key={i}
          data-testid={testid}
          aria-hidden
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 select-none text-[10px] leading-none text-accent"
          style={{ left: `${frameToPercent(t * fps, totalFrames)}%` }}
        >
          ◆
        </span>
      ))}
    </div>
  );
}

function TrackRow({
  row,
  totalFrames,
  selected,
  onSelect,
  onPointerDownMode,
}: {
  row: LayerRow;
  totalFrames: number;
  selected: boolean;
  onSelect: () => void;
  onPointerDownMode: (e: React.PointerEvent, mode: BarDragMode) => void;
}) {
  const span = layerBarSpan(row, row.srcFrames);
  const { leftPct, widthPct } = barPercent(span, totalFrames);
  // A locked layer is a plain select target — no drag handles, no grab cursor.
  const draggable = !row.locked;
  return (
    <div
      className="relative border-b border-line"
      style={{ height: ROW_HEIGHT_PX, opacity: row.enabled ? 1 : 0.4 }}
    >
      <div
        role="button"
        tabIndex={0}
        data-testid={`layer-bar-${row.id}`}
        data-locked={row.locked}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        title={row.name}
        className={`absolute top-1/2 flex -translate-y-1/2 overflow-hidden rounded ${
          selected ? 'bg-accent' : 'bg-accent-dim'
        } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
        style={{ left: `${leftPct}%`, width: `${widthPct}%`, height: ROW_HEIGHT_PX - 10 }}
      >
        {draggable && (
          <div
            data-testid={`layer-handle-trim-left-${row.id}`}
            aria-hidden
            onPointerDown={(e) => onPointerDownMode(e, 'trim-left')}
            className="h-full shrink-0 cursor-ew-resize"
            style={{ width: BAR_TRIM_HANDLE_PX }}
          />
        )}
        <div
          data-testid={`layer-handle-slide-${row.id}`}
          aria-hidden
          onPointerDown={draggable ? (e) => onPointerDownMode(e, 'slide') : undefined}
          className={`h-full flex-1 ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
        />
        {draggable && (
          <div
            data-testid={`layer-handle-trim-right-${row.id}`}
            aria-hidden
            onPointerDown={(e) => onPointerDownMode(e, 'trim-right')}
            className="h-full shrink-0 cursor-ew-resize"
            style={{ width: BAR_TRIM_HANDLE_PX }}
          />
        )}
      </div>
    </div>
  );
}
