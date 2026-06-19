// LightStudioPanel — the 2D Light-Studio surface (epic #201, slice #206), a third
// tab in the timeline drawer beside the Dopesheet and Curve Editor. It is a
// lat-long (equirectangular) flattening of the rig sphere around the lights' aim
// centre: each rig light (an AreaLight aimed by a Track-To) draws as a puck at the
// canvas point its world position maps to (`studioLightPanelXY`, the placement
// core's inverse). Dragging a puck (increment 3) writes the light's position back
// through `resolveStudioLightTransform` — one pure resolver feeds both the puck's
// position and the authored move, so panel == viewport (V37).
//
// Increment 2 (this commit) is READ-ONLY: project + draw the pucks, click to
// select. Drag-to-place and the per-light params + tex picker land next.
//
// V8 file-rooted: pure projection over the DAG; selection is a UI store (V1 — the
// DAG never mutates from selection). Geometry mapping lives in studioPanelGeometry
// (H95 — one source shared with the e2e).
//
// REF: docs/OPERATORS-AND-LIGHTING-DESIGN.md §7.3; src/app/studioLightRig.ts
//      (enumerate + rig centre); src/app/resolveStudioLightTransform.ts
//      (studioLightPanelXY); vyapti V60/V37; hetvabhasa H95.

import { useMemo } from 'react';
import { useDagStore } from '../core/dag/store';
import { useTimeStore } from '../app/stores/timeStore';
import { useSelectionStore } from '../app/stores/selectionStore';
import { createEvaluatorCache } from '../core/dag/evaluator';
import { enumerateStudioLights, resolveRigTarget } from '../app/studioLightRig';
import { studioLightPanelXY } from '../app/resolveStudioLightTransform';
import { panelXYToFraction } from './studioPanelGeometry';

export function LightStudioPanel() {
  const nodes = useDagStore((s) => s.state.nodes);
  const seconds = useTimeStore((s) => s.seconds);
  const primaryNodeId = useSelectionStore((s) => s.primaryNodeId);
  const select = useSelectionStore((s) => s.select);

  // A stable cache so the rig-target resolve (which walks the evaluator for an
  // aim-node's world position) hits while the DAG is unchanged.
  const cache = useMemo(() => createEvaluatorCache(), []);

  const { lights, target } = useMemo(() => {
    const state = useDagStore.getState().state;
    const ctx = {
      time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
    };
    return {
      lights: enumerateStudioLights(nodes),
      target: resolveRigTarget(state, ctx, cache),
    };
  }, [nodes, seconds, cache]);

  return (
    <div data-testid="light-studio-panel" className="relative h-full w-full bg-bg text-fg">
      {/* The lat-long canvas (the sphere unwrap). Equator + centre meridian give
          the director a sense of front (+Z, centre) / up (+Y, top). */}
      <div data-testid="light-studio-canvas" className="absolute inset-3 rounded border border-line">
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
              onClick={() => select(light.nodeId)}
              style={{ left: `${leftFrac * 100}%`, top: `${topFrac * 100}%` }}
              className={`absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
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
