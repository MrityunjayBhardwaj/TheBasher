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
import {
  enumerateActiveProfileLights,
  resolveActiveRigCenter,
  type StudioLightEntry,
} from '../app/studioLightRig';
import {
  resolveStudioLightTransform,
  studioLightPanelXY,
} from '../app/resolveStudioLightTransform';
import { buildAddStudioLightOps } from '../app/addStudioLight';
import { resolveActiveRigNode } from '../app/resolveRigLightSources';
import {
  enumerateProfiles,
  buildAddProfileOps,
  buildSelectProfileOp,
  buildDeleteProfileOps,
  type ProfileEntry,
} from '../app/studioProfiles';
import {
  composeProfilesFile,
  parseProfilesFile,
  buildImportProfilesOps,
} from '../app/studioProfileIO';
import { downloadBlob } from '../app/downloadBlob';
import { importEnvironmentHdri } from '../app/asset/importEnvironmentHdri';
import { useAssetErrorStore } from '../app/stores/assetErrorStore';
import { useLightBrushStore } from '../app/stores/lightBrushStore';
import { panelXYToFraction, fractionToPanelXY } from './studioPanelGeometry';
import { ParamDiamond } from '../app/ParamDiamond';
import { useAnimatableField } from '../app/animate/useAnimatableField';
import { linkedDataNodeId } from '../app/resolveDataParamOwner';
import { useColorPickerInteraction } from '../app/useColorPickerInteraction';

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
  // Subscribe to the whole DAG state — its identity changes on every Op (structural
  // sharing), so the memo below recomputes on any edit; only DAG ops re-render this
  // panel (time/selection have their own stores).
  const dagState = useDagStore((s) => s.state);
  const seconds = useTimeStore((s) => s.seconds);
  const primaryNodeId = useSelectionStore((s) => s.primaryNodeId);
  const select = useSelectionStore((s) => s.select);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<PuckDrag | null>(null);

  const { lights, target, profiles, activeRigId } = useMemo(() => {
    const ctx = {
      time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
    };
    // A FRESH cache per recompute — the EvaluatorCache is a manual-invalidation
    // Map (not auto-cleared on DAG mutation), so a memoized-once cache would feed
    // a STALE aim-node world transform after the node moves. The memo re-runs on
    // every dagState/seconds change, so a clean cache here is both correct and
    // cheap (the panel is reactive, not per-frame).
    const cache = createEvaluatorCache();
    return {
      // #208 — scope to the ACTIVE profile's lights (falls back to legacy free
      // lights when no profile exists); the centre prefers the rig's explicit one.
      lights: enumerateActiveProfileLights(dagState),
      target: resolveActiveRigCenter(dagState, ctx, cache),
      profiles: enumerateProfiles(dagState),
      activeRigId: resolveActiveRigNode(dagState),
    };
  }, [dagState, seconds]);

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
    // Open a drag transaction: every per-move setParam below mutates state for the
    // live preview but DEFERS its undo entry into one buffer; onPuckUp flushes ONE
    // AtomicGroup. Mirrors the gizmo drag bracket (Gizmo.tsx startGizmoDrag). [[H131]]
    useDagStore.getState().beginInteraction();
  }

  function onPuckMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const { leftFrac, topFrac } = fractionAt(e);
    const panelXY = fractionToPanelXY(leftFrac, topFrac);
    const { position } = resolveStudioLightTransform(panelXY, d.radius, d.target);
    // One pure resolver → the authored position; the light re-aims via its
    // Track-To, so panel == viewport (V37). The open drag transaction (onPuckDown)
    // buffers these per-move dispatches into ONE undo entry flushed on onPuckUp.
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
    // Always close the transaction opened in onPuckDown — even a no-move click
    // (endInteraction self-guards on an empty buffer, so a click flushes nothing).
    useDagStore.getState().endInteraction('place studio light');
  }

  function onAddLight() {
    const state = useDagStore.getState().state;
    // #208 — wire the new light into the active profile's rig when one exists, so
    // it belongs to the profile (else the legacy scene.lights path).
    const result = buildAddStudioLightOps(state, target, activeRigId);
    if (!result) {
      useAssetErrorStore.getState().report('light-studio:add', 'Cannot add a light — no scene.');
      return;
    }
    useDagStore.getState().dispatchAtomic(result.ops, 'user', 'add studio light');
    select(result.lightId); // select the new light so its params show immediately
  }

  function onAddProfile() {
    const state = useDagStore.getState().state;
    // Name profiles "Profile N" by count (BLS convention); the user can rename via
    // the light list — kept simple for v1.
    const name = `Profile ${profiles.length + 1}`;
    const result = buildAddProfileOps(state, name, target);
    if (!result) {
      useAssetErrorStore
        .getState()
        .report('light-studio:profile', 'Cannot add a profile — no scene.');
      return;
    }
    useDagStore.getState().dispatchAtomic(result.ops, 'user', 'add light profile');
  }

  function onSelectProfile(name: string) {
    const op = buildSelectProfileOp(useDagStore.getState().state, name);
    if (op) useDagStore.getState().dispatchAtomic([op], 'user', 'switch light profile');
  }

  function onDeleteProfile(rigId: string) {
    const ops = buildDeleteProfileOps(useDagStore.getState().state, rigId);
    if (ops) useDagStore.getState().dispatchAtomic(ops, 'user', 'delete light profile');
  }

  function onExportProfiles() {
    const file = composeProfilesFile(useDagStore.getState().state); // all profiles
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'light-profiles.json');
  }

  async function onImportProfiles(file: File) {
    try {
      const parsed = parseProfilesFile(JSON.parse(await file.text()));
      const result = buildImportProfilesOps(useDagStore.getState().state, parsed);
      if (result.ops.length === 0) {
        useAssetErrorStore
          .getState()
          .report('light-studio:import', 'No profiles found in the file.');
        return;
      }
      useDagStore.getState().dispatchAtomic(result.ops, 'user', 'import light profiles');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      useAssetErrorStore.getState().report('light-studio:import', `Profile import failed: ${msg}`);
    }
  }

  const selectedLight = lights.find((l) => l.nodeId === primaryNodeId) ?? null;

  return (
    <div data-testid="light-studio-panel" className="flex h-full w-full flex-col bg-bg text-fg">
      {/* #208 — the Profiles bar (BLS "Profiles"): switch the live profile, add a
          new one, delete the current. Grounded in BLS light_profiles.py / gui.py. */}
      <ProfilesBar
        profiles={profiles}
        onAdd={onAddProfile}
        onSelect={onSelectProfile}
        onDelete={onDeleteProfile}
        onExport={onExportProfiles}
        onImport={onImportProfiles}
      />

      <div className="flex min-h-0 flex-1">
        {/* Left rail — add + light list + the selected light's params / tex. */}
        <div className="flex w-48 shrink-0 flex-col border-r border-border text-xs">
          <button
            type="button"
            data-testid="light-studio-add"
            onClick={onAddLight}
            className="m-2 rounded border border-border bg-bg-2 px-2 py-1 text-fg hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            + Light
          </button>
          <LightBrushControls hasSelectedLight={selectedLight !== null} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {lights.map((light) => (
              <button
                key={light.nodeId}
                type="button"
                data-testid={`light-studio-row-${light.nodeId}`}
                data-selected={light.nodeId === primaryNodeId}
                onClick={() => select(light.nodeId)}
                className={`flex w-full items-center gap-1.5 px-3 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                  light.nodeId === primaryNodeId
                    ? 'bg-muted text-fg'
                    : 'text-fg-dim hover:bg-muted/40 hover:text-fg'
                }`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${light.tex ? 'bg-accent' : 'bg-fg'}`}
                />
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
            className="absolute inset-3 rounded border border-border"
          >
            {/* equator (v = 0.5) */}
            <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border" />
            {/* centre meridian (u = 0.5 → +Z, the camera-facing front) */}
            <div className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-border" />

            {/* axis hints */}
            <span className="pointer-events-none absolute left-1 top-1 text-[9px] text-fg-dim">
              +Y (up)
            </span>
            <span className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 text-[9px] text-fg-dim">
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
                  style={{
                    left: `${leftFrac * 100}%`,
                    top: `${topFrac * 100}%`,
                    touchAction: 'none',
                  }}
                  className={`absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:cursor-grabbing ${
                    selected ? 'border-accent bg-accent' : 'border-border bg-fg hover:border-accent'
                  }`}
                />
              );
            })}
          </div>

          {lights.length === 0 ? (
            <div
              data-testid="light-studio-empty"
              className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-fg-dim"
            >
              No rig lights yet — add a key light with “+ Light”, then drag it into place.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The Profiles bar (#208, §7.5) — the BLS "Profiles" panel grounded onto Basher's
 *  substrate (LightRig + LightProfileSelect). A switcher picks the live profile
 *  (one setParam → keyframeable, V57); "+ Profile" adds one; "Delete" removes the
 *  current profile and its lights. Empty until the first profile is created. */
function ProfilesBar({
  profiles,
  onAdd,
  onSelect,
  onDelete,
  onExport,
  onImport,
}: {
  profiles: ProfileEntry[];
  onAdd: () => void;
  onSelect: (name: string) => void;
  onDelete: (rigId: string) => void;
  onExport: () => void;
  onImport: (file: File) => void;
}) {
  const active = profiles.find((p) => p.active) ?? null;
  const importRef = useRef<HTMLInputElement>(null);
  return (
    <div
      data-testid="light-studio-profiles-bar"
      className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-[11px]"
    >
      <span className="font-mono text-fg/50">Profiles</span>
      {profiles.length > 0 ? (
        <select
          data-testid="light-studio-profile-select"
          value={active?.name ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          className="min-w-0 flex-1 rounded border border-border bg-muted px-1.5 py-0.5 text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {profiles.map((p) => (
            <option key={p.rigId} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="flex-1 text-fg/40">none — add one to start a lighting setup</span>
      )}
      <button
        type="button"
        data-testid="light-studio-profile-add"
        onClick={onAdd}
        className="rounded border border-border bg-bg-2 px-2 py-0.5 text-fg hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        + Profile
      </button>
      {active ? (
        <button
          type="button"
          data-testid="light-studio-profile-delete"
          onClick={() => onDelete(active.rigId)}
          className="rounded border border-border bg-muted px-2 py-0.5 text-fg/60 hover:border-red-500 hover:text-red-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          Delete
        </button>
      ) : null}

      {/* Import/Export — the portable .bls-style JSON (V63). Export writes ALL
          profiles; import rebuilds them (de-duping names). */}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      {profiles.length > 0 ? (
        <button
          type="button"
          data-testid="light-studio-profiles-export"
          onClick={onExport}
          className="rounded border border-border bg-muted px-2 py-0.5 text-fg/60 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          Export
        </button>
      ) : null}
      <button
        type="button"
        data-testid="light-studio-profiles-import"
        onClick={() => importRef.current?.click()}
        className="rounded border border-border bg-muted px-2 py-0.5 text-fg/60 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        Import
      </button>
      <input
        ref={importRef}
        type="file"
        accept="application/json,.json"
        aria-label="import light profiles"
        data-testid="light-studio-profiles-import-file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImport(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/** The Light Brush modal toggle (#207, §7.4): while active, clicking a scene mesh
 *  in the viewport paints the SELECTED rig light onto the rig sphere at the hit.
 *  Mode picks the brush direction (reflect = highlight, normal = straight key). */
function LightBrushControls({ hasSelectedLight }: { hasSelectedLight: boolean }) {
  const active = useLightBrushStore((s) => s.active);
  const mode = useLightBrushStore((s) => s.mode);
  const toggle = useLightBrushStore((s) => s.toggleActive);
  const setMode = useLightBrushStore((s) => s.setMode);

  return (
    <div className="flex flex-col gap-1 px-2 pb-2 text-[11px]">
      <button
        type="button"
        data-testid="light-studio-brush-toggle"
        aria-pressed={active}
        onClick={toggle}
        className={`rounded border px-2 py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
          active
            ? 'border-accent bg-accent/15 text-accent'
            : 'border-border bg-bg-2 text-fg hover:border-accent hover:text-accent'
        }`}
      >
        {active ? '✎ Brushing…' : '✎ Brush'}
      </button>
      {active ? (
        <>
          <span className="flex items-center gap-1">
            {(['reflect', 'normal'] as const).map((m) => (
              <button
                key={m}
                type="button"
                data-testid={`light-studio-brush-mode-${m}`}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded border px-1 py-0.5 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                  mode === m
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-border bg-muted text-fg/80 hover:text-accent'
                }`}
              >
                {m === 'reflect' ? 'highlight' : 'normal'}
              </button>
            ))}
          </span>
          <span data-testid="light-studio-brush-hint" className="text-[10px] text-fg-dim">
            {hasSelectedLight
              ? 'Click the model to place the selected light.'
              : 'Select a light, then click the model.'}
          </span>
        </>
      ) : null}
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
  // #386 C3 — post-split `nodeId` is the Object (the pose); the SHADING it edits
  // (intensity/color/width/height/tex) lives on the LightData it poses. Resolve the owning
  // node and route EVERY shading read, write, and animatable binding to it — an unrouted
  // read shows the default (below), an unrouted write is a REPORTABLE no-op (#423), and an
  // unrouted diamond authors a DEAD channel. `linkedDataNodeId` returns null for a still-
  // fused light, so `?? nodeId` keeps one code path for both (coexistence). testids stay
  // keyed to `nodeId` (the row id) for e2e stability; only the TARGET moves.
  const dataId = useDagStore((s) => linkedDataNodeId(s.state, nodeId));
  const shadingId = dataId ?? nodeId;
  const params = useDagStore((s) => s.state.nodes[shadingId]?.params) as
    | { intensity?: number; color?: string; width?: number; height?: number; tex?: string }
    | undefined;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const intensity = params?.intensity ?? 5;
  const color = params?.color ?? '#ffffff';
  const width = params?.width ?? 2;
  const height = params?.height ?? 2;
  const tex = params?.tex;

  const setParam = (paramPath: string, value: unknown, label: string) =>
    useDagStore
      .getState()
      .dispatchAtomic([{ type: 'setParam', nodeId: shadingId, paramPath, value }], 'user', label);

  // Animatable-field spines (diamond + Auto-Key + evaluated read — the H104
  // affordance the inspector material rows use), so a director keyframes a light's
  // emission straight from the Light Studio. These RENDER via seam A
  // (DirectChannelsLightR overlays the light's channels per frame). The diamond is
  // rendered per field below; the hook owns the read-side + edit routing.
  const intensityField = useAnimatableField(shadingId, 'intensity', intensity, (v) =>
    setParam('intensity', v, 'set light intensity'),
  );
  const widthField = useAnimatableField(shadingId, 'width', width, (v) =>
    setParam('width', v, 'set light width'),
  );
  const heightField = useAnimatableField(shadingId, 'height', height, (v) =>
    setParam('height', v, 'set light height'),
  );
  const colorField = useAnimatableField(shadingId, 'color', color, (v) =>
    setParam('color', v, 'set light color'),
  );
  // Coalesce a colour-picker drag into ONE undo entry (V84/H131) — same machinery
  // as the puck drag; open on the first onChange tick, flush on blur.
  const colorPicker = useColorPickerInteraction('light');

  const onNumberEdit = (field: { onEdit: (n: number) => void }, raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) field.onEdit(n);
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
      className="flex flex-col gap-1 border-t border-border p-2 text-[11px] text-fg/80"
    >
      <label className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          <ParamDiamond
            nodeId={shadingId}
            paramPath="intensity"
            value={intensity}
            testid={`studio-diamond-${nodeId}-intensity`}
          />
          <span className="font-mono text-fg/60">intensity</span>
        </span>
        <input
          type="number"
          step={0.5}
          min={0}
          value={intensityField.effective}
          readOnly={intensityField.readOnly}
          data-readonly-while-playing={intensityField.readOnly || undefined}
          data-testid={`light-intensity-${nodeId}`}
          onChange={(e) => onNumberEdit(intensityField, e.target.value)}
          className={FIELD}
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          <ParamDiamond
            nodeId={shadingId}
            paramPath="color"
            value={color}
            testid={`studio-diamond-${nodeId}-color`}
          />
          <span className="font-mono text-fg/60">color</span>
        </span>
        <input
          type="color"
          value={colorField.effective}
          data-testid={`light-color-${nodeId}`}
          onChange={(e) => {
            colorPicker.onPickStart();
            colorField.onEdit(e.target.value);
          }}
          onBlur={colorPicker.onPickEnd}
          className="h-5 w-8 rounded border border-border bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          <ParamDiamond
            nodeId={shadingId}
            paramPath="width"
            value={width}
            testid={`studio-diamond-${nodeId}-width`}
          />
          <span className="font-mono text-fg/60">width</span>
        </span>
        <input
          type="number"
          step={0.25}
          min={0.01}
          value={widthField.effective}
          readOnly={widthField.readOnly}
          data-readonly-while-playing={widthField.readOnly || undefined}
          data-testid={`light-width-${nodeId}`}
          onChange={(e) => onNumberEdit(widthField, e.target.value)}
          className={FIELD}
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          <ParamDiamond
            nodeId={shadingId}
            paramPath="height"
            value={height}
            testid={`studio-diamond-${nodeId}-height`}
          />
          <span className="font-mono text-fg/60">height</span>
        </span>
        <input
          type="number"
          step={0.25}
          min={0.01}
          value={heightField.effective}
          readOnly={heightField.readOnly}
          data-readonly-while-playing={heightField.readOnly || undefined}
          data-testid={`light-height-${nodeId}`}
          onChange={(e) => onNumberEdit(heightField, e.target.value)}
          className={FIELD}
        />
      </label>

      {/* Emitter texture — the studio look (V61). Import sets `tex`; clear returns
          the light to a plain area light. */}
      <div className="mt-1 flex items-center justify-between gap-2">
        <span
          className="truncate font-mono text-[10px] text-fg/40"
          data-testid={`light-tex-state-${nodeId}`}
        >
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
