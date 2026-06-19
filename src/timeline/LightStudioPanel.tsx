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
import { buildAddStudioLightOps } from '../app/addStudioLight';
import { importEnvironmentHdri } from '../app/asset/importEnvironmentHdri';
import { useAssetErrorStore } from '../app/stores/assetErrorStore';
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

  function onAddLight() {
    const state = useDagStore.getState().state;
    const result = buildAddStudioLightOps(state, target);
    if (!result) {
      useAssetErrorStore.getState().report('light-studio:add', 'Cannot add a light — no scene.');
      return;
    }
    useDagStore.getState().dispatchAtomic(result.ops, 'user', 'add studio light');
    select(result.lightId); // select the new light so its params show immediately
  }

  const selectedLight = lights.find((l) => l.nodeId === primaryNodeId) ?? null;

  return (
    <div data-testid="light-studio-panel" className="flex h-full w-full bg-bg text-fg">
      {/* Left rail — add + light list + the selected light's params / tex. */}
      <div className="flex w-48 shrink-0 flex-col border-r border-line text-xs">
        <button
          type="button"
          data-testid="light-studio-add"
          onClick={onAddLight}
          className="m-2 rounded border border-line bg-bg-2 px-2 py-1 text-fg hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          + Light
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {lights.map((light) => (
            <button
              key={light.nodeId}
              type="button"
              data-testid={`light-studio-row-${light.nodeId}`}
              data-selected={light.nodeId === primaryNodeId}
              onClick={() => select(light.nodeId)}
              className={`flex w-full items-center gap-1.5 px-3 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                light.nodeId === primaryNodeId ? 'bg-line text-fg' : 'text-mute hover:bg-line/40 hover:text-fg'
              }`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${light.tex ? 'bg-accent' : 'bg-fg'}`} />
              <span className="truncate">{light.name}</span>
            </button>
          ))}
        </div>
        {selectedLight ? <StudioLightControls light={selectedLight} /> : null}
      </div>

      {/* Right region — the lat-long canvas (the sphere unwrap). Equator + centre
          meridian give the director a sense of front (+Z, centre) / up (+Y, top). */}
      <div className="relative flex-1">
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
          No rig lights yet — add a key light with “+ Light”, then drag it into place.
        </div>
      ) : null}
      </div>
    </div>
  );
}

const FIELD =
  'w-20 rounded border border-border bg-muted px-1.5 py-0.5 text-right text-[10px] text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';
const BTN =
  'rounded border border-border bg-muted px-2 py-0.5 text-[10px] text-fg/80 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

/** The selected rig light's emission params + the emitter-texture picker. A `tex`
 *  turns the light into a STUDIO light (the §1.5 pair, V61); clearing it (tex='',
 *  falsy) returns it to a plain area light. Every field is a setParam Op, so it
 *  saves/undoes and is animatable from the dopesheet for free (V57). */
function StudioLightControls({ light }: { light: StudioLightEntry }) {
  const nodeId = light.nodeId;
  const params = useDagStore((s) => s.state.nodes[nodeId]?.params) as
    | { intensity?: number; color?: string; width?: number; height?: number; tex?: string }
    | undefined;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const intensity = params?.intensity ?? 5;
  const color = params?.color ?? '#ffffff';
  const width = params?.width ?? 2;
  const height = params?.height ?? 2;
  const tex = params?.tex;

  const setParam = (paramPath: string, value: unknown, label: string) =>
    useDagStore.getState().dispatchAtomic([{ type: 'setParam', nodeId, paramPath, value }], 'user', label);

  const onNumber = (paramPath: string, raw: string, label: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) setParam(paramPath, n, label);
  };

  const onImport = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const assetRef = await importEnvironmentHdri(bytes, file.name);
      setParam('tex', assetRef, 'set studio light texture');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      useAssetErrorStore.getState().report(`${nodeId}:tex`, `Light texture import failed: ${msg}`);
    }
  };

  return (
    <div
      data-testid={`light-studio-controls-${nodeId}`}
      className="flex flex-col gap-1 border-t border-line p-2 text-[11px] text-fg/80"
    >
      <label className="flex items-center justify-between gap-2">
        <span className="font-mono text-fg/60">intensity</span>
        <input
          type="number"
          step={0.5}
          min={0}
          value={intensity}
          data-testid={`light-intensity-${nodeId}`}
          onChange={(e) => onNumber('intensity', e.target.value, 'set light intensity')}
          className={FIELD}
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="font-mono text-fg/60">color</span>
        <input
          type="color"
          value={color}
          data-testid={`light-color-${nodeId}`}
          onChange={(e) => setParam('color', e.target.value, 'set light color')}
          className="h-5 w-8 rounded border border-border bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="font-mono text-fg/60">width</span>
        <input
          type="number"
          step={0.25}
          min={0.01}
          value={width}
          data-testid={`light-width-${nodeId}`}
          onChange={(e) => onNumber('width', e.target.value, 'set light width')}
          className={FIELD}
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="font-mono text-fg/60">height</span>
        <input
          type="number"
          step={0.25}
          min={0.01}
          value={height}
          data-testid={`light-height-${nodeId}`}
          onChange={(e) => onNumber('height', e.target.value, 'set light height')}
          className={FIELD}
        />
      </label>

      {/* Emitter texture — the studio look (V61). Import sets `tex`; clear returns
          the light to a plain area light. */}
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[10px] text-fg/40" data-testid={`light-tex-state-${nodeId}`}>
          {tex ? 'textured' : '— no texture'}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            data-testid={`light-tex-import-${nodeId}`}
            onClick={() => fileInputRef.current?.click()}
            className={BTN}
          >
            {tex ? 'replace' : 'texture…'}
          </button>
          {tex ? (
            <button
              type="button"
              data-testid={`light-tex-clear-${nodeId}`}
              onClick={() => setParam('tex', '', 'clear light texture')}
              className={BTN}
            >
              clear
            </button>
          ) : null}
        </span>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".hdr,.exr,image/vnd.radiance,image/x-exr"
        aria-label="studio light emitter texture"
        data-testid={`light-tex-file-${nodeId}`}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onImport(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
