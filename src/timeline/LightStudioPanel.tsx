// LightStudioPanel — the 2D Light-Studio surface (epic #201, slice #206), a third
// tab in the timeline drawer beside the Dopesheet and Curve Editor. It is a
// lat-long (equirectangular) flattening of the rig sphere around the lights' aim
// centre: each rig light (an AreaLight aimed by a Track-To) draws as a puck at the
// canvas point its world position maps to (`studioLightPanelXY`, the placement
// core's inverse). Dragging a puck writes the light's position back through
// `resolveStudioLightTransform(panelXY, radius, target)` — one pure resolver feeds
// both the puck's position and the authored move, so panel == viewport (V37). The
// drag preserves the light's RADIUS (its shell of the rig sphere); only azimuth /
// elevation change. Orientation is NOT touched here — the light keeps aiming at
// the centre via its own Track-To (V60).
//
// V8 file-rooted: pure projection over the DAG; the drag mutates the DAG only
// through a setParam Op (V1). Selection is a UI store. Geometry mapping lives in
// studioPanelGeometry (H95 — one source shared with the e2e).
//
// REF: docs/OPERATORS-AND-LIGHTING-DESIGN.md §7.3; src/app/studioLightRig.ts
//      (enumerate + rig centre); src/app/resolveStudioLightTransform.ts
//      (the placement core + its inverse); vyapti V60/V37; hetvabhasa H95.

import { useMemo, useRef } from 'react';
import { useDagStore } from '../core/dag/store';
import { useTimeStore } from '../app/stores/timeStore';
import { useSelectionStore } from '../app/stores/selectionStore';
import { createEvaluatorCache } from '../core/dag/evaluator';
import { enumerateStudioLights, resolveRigTarget, type StudioLightEntry } from '../app/studioLightRig';
import { resolveStudioLightTransform, studioLightPanelXY } from '../app/resolveStudioLightTransform';
import { panelXYToFraction, fractionToPanelXY } from './studioPanelGeometry';

type Vec3 = [number, number, number];

/** The in-flight puck drag: which light, the frozen radius + rig centre captured
 *  at grab time, and the pointer that owns it (capture-scoped). */
interface PuckDrag {
  readonly nodeId: string;
  readonly radius: number;
  readonly target: Vec3;
  readonly pointerId: number;
}

export function LightStudioPanel() {
  const nodes = useDagStore((s) => s.state.nodes);
  const seconds = useTimeStore((s) => s.seconds);
  const primaryNodeId = useSelectionStore((s) => s.primaryNodeId);
  const select = useSelectionStore((s) => s.select);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<PuckDrag | null>(null);

  const { lights, target } = useMemo(() => {
    const state = useDagStore.getState().state;
    const ctx = {
      time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
    };
    // A FRESH cache per recompute — the EvaluatorCache is a manual-invalidation
    // Map (not auto-cleared on DAG mutation), so a memoized-once cache would feed
    // a STALE aim-node world transform after the node moves. The memo re-runs on
    // every nodes/seconds change, so a clean cache here is both correct and cheap
    // (the panel is reactive, not per-frame).
    const cache = createEvaluatorCache();
    return {
      lights: enumerateStudioLights(nodes),
      target: resolveRigTarget(state, ctx, cache),
    };
  }, [nodes, seconds]);

  // Pointer fraction within the canvas rect (0..1 from the left / top edge).
  function fractionAt(e: React.PointerEvent): { leftFrac: number; topFrac: number } {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      leftFrac: (e.clientX - rect.left) / Math.max(rect.width, 1),
      topFrac: (e.clientY - rect.top) / Math.max(rect.height, 1),
    };
  }

  function onPuckDown(e: React.PointerEvent, light: StudioLightEntry) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    // Freeze the radius + rig centre at grab time so the drag slides the light
    // around its own shell of the sphere (azimuth/elevation only).
    const { radius } = studioLightPanelXY(light.position, target);
    dragRef.current = { nodeId: light.nodeId, radius, target, pointerId: e.pointerId };
    select(light.nodeId);
  }

  function onPuckMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const { leftFrac, topFrac } = fractionAt(e);
    const panelXY = fractionToPanelXY(leftFrac, topFrac);
    const { position } = resolveStudioLightTransform(panelXY, d.radius, d.target);
    // One pure resolver → the authored position; the light re-aims via its
    // Track-To, so panel == viewport (V37). Consecutive same-path setParams
    // coalesce into one undo entry (the EditableCurve drag pattern).
    useDagStore
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: d.nodeId, paramPath: 'position', value: position }],
        'user',
        'place studio light',
      );
  }

  function onPuckUp(e: React.PointerEvent) {
    const d = dragRef.current;
    if (d && e.pointerId === d.pointerId) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
  }

  return (
    <div data-testid="light-studio-panel" className="relative h-full w-full bg-bg text-fg">
      {/* The lat-long canvas (the sphere unwrap). Equator + centre meridian give
          the director a sense of front (+Z, centre) / up (+Y, top). */}
      <div
        ref={canvasRef}
        data-testid="light-studio-canvas"
        className="absolute inset-3 rounded border border-line"
      >
        {/* equator (v = 0.5) */}
        <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-line" />
        {/* centre meridian (u = 0.5 → +Z, the camera-facing front) */}
        <div className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-line" />

        {/* axis hints */}
        <span className="pointer-events-none absolute left-1 top-1 text-[9px] text-mute">+Y (up)</span>
        <span className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 text-[9px] text-mute">
          front (+Z) · azimuth →
        </span>

        {lights.map((light) => {
          const { panelXY } = studioLightPanelXY(light.position, target);
          const { leftFrac, topFrac } = panelXYToFraction(panelXY);
          const selected = light.nodeId === primaryNodeId;
          return (
            <button
              key={light.nodeId}
              type="button"
              data-testid={`light-studio-puck-${light.nodeId}`}
              data-selected={selected}
              aria-label={`Studio light ${light.name}`}
              title={light.name}
              onPointerDown={(e) => onPuckDown(e, light)}
              onPointerMove={onPuckMove}
              onPointerUp={onPuckUp}
              // Keyboard activation (Enter/Space) fires click, not pointer events
              // — keep selection reachable without a pointer (a11y).
              onClick={() => select(light.nodeId)}
              style={{ left: `${leftFrac * 100}%`, top: `${topFrac * 100}%`, touchAction: 'none' }}
              className={`absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:cursor-grabbing ${
                selected
                  ? 'border-accent bg-accent'
                  : 'border-line bg-fg hover:border-accent'
              }`}
            />
          );
        })}
      </div>

      {lights.length === 0 ? (
        <div
          data-testid="light-studio-empty"
          className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-mute"
        >
          No rig lights yet — add an area light aimed at the rig (a Track-To) to place it here.
        </div>
      ) : null}
    </div>
  );
}
