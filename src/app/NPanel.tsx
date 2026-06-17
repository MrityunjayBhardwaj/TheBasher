// NPanel — canonical Inspector. Right-column property editor for the
// primary selection.
//
// History (P6 W2.6 — "Inspector → NPanel" merge):
//   The original D-UX-8 had NPanel as the canonical Inspector with
//   Inspector.tsx scheduled for deletion. A mid-W1 correction reversed
//   that: at the time, NPanel was a viewport overlay with mode/snap/grid
//   toggles, and Inspector was a docked property editor — the two had
//   no overlap and merging would have lost surface area.
//
//   By W2 the picture had changed: TopToolbar absorbed mode + snap
//   controls (gizmo group, snap on/off), so NPanel's mode/snap sections
//   were already redundant. The grid/axis toggles will move into W7's
//   FloatingViewportToolbar — their natural home is near the viewport,
//   not bolted to selection chrome. That left NPanel with nothing
//   unique. Meanwhile Inspector and NPanel both rendered selection
//   summaries, so the user reasserted the original D-UX-8: NPanel
//   becomes the Inspector, Inspector.tsx is deleted.
//
// What this component is NOW:
//   - Mounts in the grid `inspector` slot (right column).
//   - Renders property cards for the primary selection (numeric scalars,
//     Vec3 with axis-coded scrub labels, string params, CostPreview for
//     ComfyUIWorkflow nodes).
//   - testids preserved as `inspector-*` so the existing P0/P2/P3/P5 e2e
//     suite passes through the merge unchanged.
//
// V1 + V8: dispatches setParam Ops only. UI projection store reads only.
// No DAG mutation outside the dispatch path. `controlled value` prop is
// the load-bearing contract here — uncontrolled `defaultValue` would
// silently desync the moment a param changes outside the input (Cmd+Z,
// agent ops, drag-scrub on the gizmo).
//
// REF: docs/UI-SPEC.md §5.8 (D-UX-8 NPanel canonical Inspector — restored
// post-W2 after observing that NPanel/TopToolbar overlap eliminated
// NPanel's unique value); THESIS.md §15; krama K2 (acceptance #5: edit →
// viewport in <16ms because dispatch is sync + zustand subscribers
// re-render before next frame).

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  attachMapFromFile,
  MATERIAL_MAP_SLOTS,
  type MaterialMapSlot,
} from './material/attachMapFromFile';
import { CLEARED_MAP, isClearedMap } from './material/gltfMapOverlay';
import { getStorage } from './boot';
import { useAssetErrorStore } from './stores/assetErrorStore';
import type { BakedTextureRef, InlineMaterialSpec } from '../nodes/types';
import { useDagStore } from '../core/dag/store';
import { useGltfMaterialStore } from './asset/gltfMaterialStore';
import type { GltfMaterialSlot } from './asset/readGltfMaterials';
import { getNodeType } from '../core/dag/registry';
import type { NodeRef } from '../core/dag/types';
import { countOverrideSlots } from './resolveOverrideSlots';
import { useTimeStore } from './stores/timeStore';
import {
  dispatchApplyTransform,
  isTransformAnimated,
  type ApplyMask,
} from './animate/dispatchApplyTransform';
import { ParamDiamond } from './ParamDiamond';
import { autoKeyCommit, routeAnimatedGrab } from './animate/autoKeyCommit';
import { useDragScrub } from './dragScrub';
import {
  formatSectionLabel,
  isDefaultCollapsed,
  isSectionId,
  paramToSection,
  type SectionId,
} from './inspectorSections';
import { CostPreviewConnector } from './render/CostPreviewConnector';
import { RevertImportedClipConnector } from './animate/RevertImportedClipConnector';
import { SceneEnvironmentControls } from './SceneEnvironmentControls';
import { CameraLensControls } from './CameraLensControls';
import { useInspectorSectionsStore, resolveCollapsed } from './stores/inspectorSectionsStore';
import { useChromeStore } from './stores/chromeStore';
import { useSelectionStore } from './stores/selectionStore';
import { resolveTransformParam } from './resolveTransformParam';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import {
  buildRevertedSet,
  isFieldOverridden,
  overrideDescriptor,
  readOverriddenSet,
  type OverrideDescriptor,
} from './overrideDescriptor';

// #130 (D-04) — the per-field override decorator contract threaded into the
// editable fields. `descriptor` names the set param + covered fields; `marked`
// is the live authored bit for THIS paramPath. Present only on a node type that
// carries an override set (MaterialOverride / GltfChild) AND on a covered field.
interface OverrideInfo {
  readonly descriptor: OverrideDescriptor;
  readonly marked: boolean;
}

// #130 (D-04 / K6) — editing a covered field MARKS it overridden in the SAME
// atomic as the value write (mirrors Gizmo.writeGltfChildOverride): value +
// `overridden.<field> = true` land in one dispatch (one Cmd+Z, no snap-back —
// the [[H40]]/C2 trap). Returns true iff it handled the write (covered field).
function dispatchOverrideValueEdit(
  nodeId: string,
  paramPath: string,
  value: unknown,
  info: OverrideInfo | undefined,
): boolean {
  if (!info) return false;
  useDagStore.getState().dispatchAtomic(
    [
      { type: 'setParam', nodeId, paramPath, value },
      {
        type: 'setParam',
        nodeId,
        paramPath: `${info.descriptor.setParamPath}.${paramPath}`,
        value: true,
      },
    ],
    'user',
    `edit ${paramPath} (mark overridden)`,
  );
  return true;
}

/**
 * The per-field override decorator (#130, D-04). A state dot (filled = the
 * director explicitly authored this field; hollow = inherits source) plus a
 * ✕/revert button shown only when marked. Revert clears the bit through the
 * shared `overrideSet` primitive (schema-respecting via `buildRevertedSet`) and
 * the renderer falls back to source because BOTH consumers branch on the
 * explicit bit, not value-equality ([[V28]]/R-4) — so the dormant scalar the
 * field still holds is ignored. Grounded: Blender RMB Add/Remove Override +
 * colour decorator; Houdini bold + RMB revert.
 */
function OverrideDecorator({
  nodeId,
  descriptor,
  field,
  marked,
}: {
  nodeId: string;
  descriptor: OverrideDescriptor;
  field: string;
  marked: boolean;
}) {
  const onRevert = () => {
    const sel = useDagStore.getState().state.nodes[nodeId];
    const current = readOverriddenSet(
      sel?.params as Record<string, unknown> | undefined,
      descriptor.setParamPath,
    );
    const next = buildRevertedSet(current, descriptor, field);
    useDagStore
      .getState()
      .dispatch(
        { type: 'setParam', nodeId, paramPath: descriptor.setParamPath, value: next },
        'user',
        `revert ${field} override`,
      );
  };
  return (
    <span className="flex items-center gap-0.5">
      <span
        data-testid={`inspector-override-dot-${nodeId}-${field}`}
        data-overridden={marked || undefined}
        aria-label={marked ? `${field} overridden` : `${field} inherits source`}
        title={marked ? 'Overridden — click ✕ to revert to source' : 'Inherits source'}
        className={`select-none text-[9px] leading-none ${marked ? 'text-accent' : 'text-fg/30'}`}
      >
        {marked ? '●' : '○'}
      </span>
      {marked ? (
        <button
          type="button"
          data-testid={`inspector-override-revert-${nodeId}-${field}`}
          aria-label={`Revert ${field} to source`}
          title="Revert to source"
          onClick={onRevert}
          className="select-none px-0.5 text-[10px] leading-none text-fg/40 hover:text-record focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ✕
        </button>
      ) : null}
    </span>
  );
}

// P7.3: `resolveChannel` + `autoKeyCommit` were lifted to the shared
// `./animate/autoKeyCommit` module (one Auto-Key chokepoint, callers: this
// inspector AND the viewport gizmo grab — issue #68 / D-02). #190: the diamond
// itself moved to `./ParamDiamond` so CameraLensControls can render it too — so
// NPanel now imports only the autoKey commit helpers it calls directly.

interface NumericFieldProps {
  nodeId: string;
  paramPath: string;
  label: string;
  value: number;
  overrideInfo?: OverrideInfo;
}

function NumericField({ nodeId, paramPath, label, value, overrideInfo }: NumericFieldProps) {
  const dispatch = useDagStore((s) => s.dispatch);
  const scrub = useDragScrub({
    value,
    onCommit: (next) => {
      // P7.4 D-05 (#77): animated param → re-route through the SHARED seam
      // chokepoint BEFORE the raw setParam (H36 anti-double-write). On true
      // the seam already keyed — skip BOTH the raw setParam AND the separate
      // autoKeyCommit. On false (un-animated) the existing path runs
      // unchanged (matrix rows 1-2: the AutoKey-ON first-key composite).
      if (routeAnimatedGrab(nodeId, paramPath, next)) return;
      // #130 (D-04 / K6): a covered override field marks itself overridden in
      // the same atomic as the value. Non-override fields keep the single setParam.
      if (!dispatchOverrideValueEdit(nodeId, paramPath, next, overrideInfo)) {
        dispatch(
          { type: 'setParam', nodeId, paramPath, value: next },
          'user',
          `scrub ${paramPath}`,
        );
      }
      autoKeyCommit(nodeId, paramPath, next);
    },
  });
  const display = scrub.isDragging ? scrub.previewValue : value;
  // P7.4 D-02: read-only-while-playing applies ONLY when this field is
  // displaying an evaluated value (D-03 scope: transform-only). The helper
  // returns null for scalars (D-03 whitelist guard), so NumericField never
  // shows an evaluated value → `evaluated` is always false here, and
  // `readOnly` is byte-equivalent to today's editable scalar field. The
  // attribute exists for defensive parity with VectorComponent — if a
  // future scalar transform param is added (none today), the seam covers it.
  const playing = useTimeStore((s) => s.playing);
  const evaluated = false;
  const readOnly = playing && evaluated;
  return (
    <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
      <span className="flex items-center gap-1">
        <ParamDiamond nodeId={nodeId} paramPath={paramPath} value={value} />
        {overrideInfo ? (
          <OverrideDecorator
            nodeId={nodeId}
            descriptor={overrideInfo.descriptor}
            field={paramPath}
            marked={overrideInfo.marked}
          />
        ) : null}
        <span
          className="cursor-ew-resize select-none font-mono text-fg/60 hover:text-accent"
          onPointerDown={scrub.onPointerDown}
          data-testid={`inspector-scrub-${nodeId}-${paramPath}`}
          title="Drag horizontally to scrub. Shift = fine, Cmd/Ctrl = coarse."
        >
          {label}
        </span>
      </span>
      <input
        type="number"
        step="0.1"
        value={display}
        readOnly={readOnly}
        data-readonly-while-playing={readOnly || undefined}
        data-testid={`inspector-input-${nodeId}-${paramPath}`}
        className="w-24 rounded border border-border bg-muted px-2 py-0.5 text-right font-mono text-xs text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          if (Number.isNaN(next)) return;
          // P7.4 D-05 (#77): animated → SHARED seam, skip raw setParam +
          // autoKeyCommit. Un-animated → existing path unchanged.
          if (routeAnimatedGrab(nodeId, paramPath, next)) return;
          // #130 (D-04 / K6): covered override field → value + bit in one atomic.
          if (!dispatchOverrideValueEdit(nodeId, paramPath, next, overrideInfo)) {
            dispatch({ type: 'setParam', nodeId, paramPath, value: next });
          }
          autoKeyCommit(nodeId, paramPath, next);
        }}
      />
    </label>
  );
}

function VectorComponent({
  nodeId,
  paramPath,
  axisLabel,
  axisIndex,
  value,
  vec,
  readOnly,
  overrideInfo,
}: {
  nodeId: string;
  paramPath: string;
  axisLabel: string;
  axisIndex: number;
  value: number;
  vec: readonly number[];
  readOnly?: boolean;
  overrideInfo?: OverrideInfo;
}) {
  const dispatch = useDagStore((s) => s.dispatch);
  const scrub = useDragScrub({
    value,
    onCommit: (next) => {
      const newVec = [...vec] as number[];
      newVec[axisIndex] = next;
      // P7.4 D-05 (#77) + D-06 (#78): re-route the SAME displayed newVec
      // (WYSIWYK — write composition unchanged) through the SHARED seam
      // BEFORE the raw setParam. On true: seam keyed, skip both. On false
      // (un-animated): existing path unchanged.
      if (routeAnimatedGrab(nodeId, paramPath, newVec)) return;
      // #130 (D-04 / K6): editing a covered TRS component via the Inspector
      // marks it overridden in the same atomic — parity with the gizmo's
      // writeGltfChildOverride (NPanel edits previously did NOT set the bit).
      if (!dispatchOverrideValueEdit(nodeId, paramPath, newVec, overrideInfo)) {
        dispatch(
          { type: 'setParam', nodeId, paramPath, value: newVec },
          'user',
          `scrub ${paramPath}.${axisLabel}`,
        );
      }
      autoKeyCommit(nodeId, paramPath, newVec);
    },
  });
  const display = scrub.isDragging ? scrub.previewValue : value;
  return (
    <label className="flex flex-1 items-center gap-1">
      <span
        className="w-4 cursor-ew-resize select-none text-center font-mono text-[10px] uppercase text-fg/50 hover:text-accent"
        onPointerDown={scrub.onPointerDown}
        data-testid={`inspector-scrub-${nodeId}-${paramPath}-${axisLabel}`}
        title="Drag horizontally to scrub. Shift = fine, Cmd/Ctrl = coarse."
      >
        {axisLabel}
      </span>
      <input
        type="number"
        step="0.1"
        value={display}
        readOnly={readOnly}
        data-readonly-while-playing={readOnly || undefined}
        data-testid={`inspector-vec-${nodeId}-${paramPath}-${axisLabel}`}
        className="w-full rounded border border-border bg-muted px-1.5 py-0.5 text-right font-mono text-[11px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          if (Number.isNaN(next)) return;
          const newVec = [...vec] as number[];
          newVec[axisIndex] = next;
          // P7.4 D-05 (#77) + D-06 (#78): same displayed newVec through the
          // SHARED seam BEFORE the raw setParam. True → skip both;
          // false (un-animated) → existing path unchanged.
          if (routeAnimatedGrab(nodeId, paramPath, newVec)) return;
          // #130 (D-04 / K6): covered TRS component → value + bit in one atomic.
          if (!dispatchOverrideValueEdit(nodeId, paramPath, newVec, overrideInfo)) {
            dispatch({ type: 'setParam', nodeId, paramPath, value: newVec });
          }
          autoKeyCommit(nodeId, paramPath, newVec);
        }}
      />
    </label>
  );
}

function VectorField({
  nodeId,
  paramPath,
  label,
  value,
  overrideInfo,
}: {
  nodeId: string;
  paramPath: string;
  label: string;
  value: readonly number[];
  overrideInfo?: OverrideInfo;
}) {
  const dims = ['x', 'y', 'z'];
  // P7.4 D-01: field-level resolver call (NOT per-axis — one helper call
  // yields the resolved vec, then each VectorComponent reads its axis
  // index). Mirrors Gizmo.tsx:142-151 useMemo cadence: dependencies are
  // [state, selectedId/nodeId, paramPath, frame, seconds, normalized].
  // The helper returns null for non-transform paramPaths (D-03 whitelist
  // inside the helper) — un-animated transform params get the authored
  // Vec3 back via the resolver's patched-clone passthrough, so the
  // (resolved ?? value) seam is byte-identical to today's display for
  // anything not actively animated. V20: subscriber form throughout,
  // never useTimeStore.getState() in the seam.
  const frame = useTimeStore((s) => s.frame);
  const seconds = useTimeStore((s) => s.seconds);
  const normalized = useTimeStore((s) => s.normalized);
  const playing = useTimeStore((s) => s.playing);
  const dagState = useDagStore((s) => s.state);
  const resolved = useMemo(
    () =>
      resolveTransformParam(dagState, nodeId, paramPath, {
        time: { frame, seconds, normalized },
      }),
    [dagState, nodeId, paramPath, frame, seconds, normalized],
  );
  // Per-param fallback (D-01): resolved Vec3 OR authored value.
  const effectiveValue: readonly number[] = resolved ?? value;
  // D-02: read-only while playing IFF this field is showing an evaluated
  // value. `resolved !== null` means the helper returned a Vec3 (i.e. the
  // selection is a rendered transform-bearing node + paramPath is in the
  // D-03 whitelist). Un-animated material vecs, non-transform Vec3 params,
  // or unrenderable selections → resolved is null → readOnly is false →
  // editing behavior unchanged from today.
  const readOnly = playing && resolved !== null;
  return (
    <div className="flex flex-col gap-1 px-3 py-1.5 text-[11px] text-fg/80">
      <span className="flex items-center gap-1">
        <ParamDiamond nodeId={nodeId} paramPath={paramPath} value={value} />
        {overrideInfo ? (
          <OverrideDecorator
            nodeId={nodeId}
            descriptor={overrideInfo.descriptor}
            field={paramPath}
            marked={overrideInfo.marked}
          />
        ) : null}
        <span className="font-mono text-fg/60">{label}</span>
      </span>
      <div className="flex gap-1">
        {effectiveValue.slice(0, 3).map((v, i) => (
          <VectorComponent
            key={dims[i]}
            nodeId={nodeId}
            paramPath={paramPath}
            axisLabel={dims[i]}
            axisIndex={i}
            value={v}
            vec={effectiveValue}
            readOnly={readOnly}
            overrideInfo={overrideInfo}
          />
        ))}
      </div>
    </div>
  );
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/**
 * Boolean param editor (#136). Before this, every boolean param fell through to
 * the `(complex — Pro mode)` fallback and was NOT editable in the Inspector —
 * `MaterialOverride.ignoreSourceMaterial` (the #131 flatten toggle), AnimationClip
 * /LocomotionState `loop`, AnimationLayer `mute`/`solo`, RenderOutput `smaa`,
 * ScatterNode `randomYaw`. A checkbox closes that gap. V1/V8: dispatches a single
 * `setParam` Op, reads nothing else. Controlled `checked` (never `defaultChecked`)
 * so a Cmd+Z / agent op / external param change stays in sync.
 */
function BooleanField({
  nodeId,
  paramPath,
  label,
  value,
}: {
  nodeId: string;
  paramPath: string;
  label: string;
  value: boolean;
}) {
  const dispatch = useDagStore((s) => s.dispatch);
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
      <span className="font-mono text-fg/60">{label}</span>
      <input
        type="checkbox"
        checked={value}
        data-testid={`inspector-toggle-${nodeId}-${paramPath}`}
        className="h-3.5 w-3.5 accent-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onChange={(e) =>
          dispatch(
            { type: 'setParam', nodeId, paramPath, value: e.target.checked },
            'user',
            `toggle ${paramPath}`,
          )
        }
      />
    </label>
  );
}

function isInputBinding(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<NodeRef>;
  return typeof o.node === 'string' && typeof o.socket === 'string';
}

/** Render one param row. Dispatches on the value's runtime shape —
 *  number / vec3 / string / input-binding / complex. Returns null when
 *  the value is an upstream binding (those render via socket wiring
 *  in C5+, not the Inspector). */
// v0.7 Phase 4 (#198) — the swatch+hex colour field is now the shared
// `MaterialColorRow` (consumed by MaterialRows for native AND glTF). `isHex6`
// stays here — MaterialColorRow + GltfMatColorField both validate hex with it.
function isHex6(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

// v0.6 #2 (#178, W3) — the lobe-grouped OpenPBR material editor that REPLACES the
// `(complex — Pro mode)` placeholder (closes NPanel:636 for primitives; the THESIS
// §741 uniformity gate). Each scalar → a NumericField, each colour → a ColorField,
// addressing the grouped paramPath `material.<lobe>.<field>` (the primitive owns
// its material → direct setParam, D-07). Every field carries ParamDiamond + scrub
// + autoKey for FREE (shared fields). Map rows (W5) attach under base later.
interface MaterialFieldSpec {
  key: string;
  label: string;
  kind: 'number' | 'color';
}
const MATERIAL_LOBES: { lobe: string; label: string; fields: MaterialFieldSpec[] }[] = [
  {
    lobe: 'base',
    label: 'Base',
    fields: [
      { key: 'color', label: 'color', kind: 'color' },
      { key: 'metalness', label: 'metalness', kind: 'number' },
    ],
  },
  {
    lobe: 'specular',
    label: 'Specular',
    fields: [
      { key: 'roughness', label: 'roughness', kind: 'number' },
      { key: 'ior', label: 'ior', kind: 'number' },
    ],
  },
  {
    lobe: 'coat',
    label: 'Coat',
    fields: [
      { key: 'weight', label: 'weight', kind: 'number' },
      { key: 'roughness', label: 'roughness', kind: 'number' },
    ],
  },
  {
    lobe: 'transmission',
    label: 'Transmission',
    fields: [{ key: 'weight', label: 'weight', kind: 'number' }],
  },
  {
    lobe: 'emission',
    label: 'Emission',
    fields: [
      { key: 'color', label: 'color', kind: 'color' },
      { key: 'luminance', label: 'luminance', kind: 'number' },
    ],
  },
  {
    lobe: 'geometry',
    label: 'Geometry',
    fields: [{ key: 'opacity', label: 'opacity', kind: 'number' }],
  },
];

function isMaterialIR(v: unknown): v is Record<string, Record<string, unknown>> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { base?: { color?: unknown } }).base?.color === 'string'
  );
}

// v0.6 #2 (#178, W5) — one texture-map slot row: pick (file → attachMapFromFile →
// OPFS → setParam the ref) or clear (setParam null). Maps are NON-animated (D-04)
// → no ParamDiamond. A decode/persist failure surfaces via assetErrorStore (the
// MERGED feedback surface), never a silent drop.
function MapRow({
  nodeId,
  slot,
  mapRef,
}: {
  nodeId: string;
  slot: MaterialMapSlot;
  mapRef: BakedTextureRef | null;
}) {
  const dispatch = useDagStore((s) => s.dispatch);
  const inputRef = useRef<HTMLInputElement>(null);
  const paramPath = `material.maps.${slot}`;
  const onPick = async (file: File) => {
    try {
      const storage = await getStorage();
      const ref = await attachMapFromFile(storage, file, slot);
      // The setParam recording the ref runs ONLY after the async persist resolves.
      dispatch({ type: 'setParam', nodeId, paramPath, value: ref }, 'user', `attach ${slot} map`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      useAssetErrorStore.getState().report(`${nodeId}:${slot}`, `${slot} map failed: ${msg}`);
    }
  };
  return (
    <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
      <span className="font-mono text-fg/60">{slot}</span>
      <span className="flex items-center gap-1">
        <span
          className="font-mono text-[10px] text-fg/40"
          data-testid={`inspector-map-state-${nodeId}-${slot}`}
        >
          {mapRef ? '● set' : '— none'}
        </span>
        <button
          type="button"
          data-testid={`inspector-map-pick-${nodeId}-${slot}`}
          onClick={() => inputRef.current?.click()}
          className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] text-fg/80 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {mapRef ? 'replace' : 'pick'}
        </button>
        {mapRef ? (
          <button
            type="button"
            data-testid={`inspector-map-clear-${nodeId}-${slot}`}
            onClick={() =>
              dispatch(
                { type: 'setParam', nodeId, paramPath, value: null },
                'user',
                `clear ${slot} map`,
              )
            }
            className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] text-fg/80 hover:text-warn focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            clear
          </button>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label={`${slot} map file`}
          data-testid={`inspector-map-file-${nodeId}-${slot}`}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPick(f);
            e.target.value = '';
          }}
        />
      </span>
    </label>
  );
}

// v0.6 #3 (#181, W2) — the Texture Placement section: ONE shared uvTransform
// (tiling/offset/rotation) applied to all 6 map textures. ALWAYS rendered when
// the material carries a uvTransform (post-migration: always) — never gated on a
// precondition that could strand a non-identity transform with no reset ([[H75]]).
// tiling/offset dispatch the WHOLE [x,y] array (setAtPath has no array-index path);
// rotation is a scalar. NON-animated (D-02).
function UvTransformSection({
  nodeId,
  uvTransform,
}: {
  nodeId: string;
  uvTransform: { tiling: [number, number]; offset: [number, number]; rotation: number };
}) {
  const dispatch = useDagStore((s) => s.dispatch);
  const { tiling, offset, rotation } = uvTransform;
  const setVec = (path: string, axis: 0 | 1, cur: [number, number], v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const next: [number, number] = axis === 0 ? [n, cur[1]] : [cur[0], n];
    dispatch({ type: 'setParam', nodeId, paramPath: path, value: next }, 'user', `set ${path}`);
  };
  return (
    <div className="flex flex-col" data-testid={`inspector-uvtransform-${nodeId}`}>
      <div className="px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wide text-fg/40">
        Texture Placement
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-1 text-[11px] text-fg/80">
        <span className="font-mono text-fg/60">tiling</span>
        <span className="flex items-center gap-1">
          <UvNumberInline
            value={tiling[0]}
            label="x"
            testid={`inspector-uvtransform-tilingX-${nodeId}`}
            ariaPath="material.uvTransform.tiling.x"
            onCommit={(v) => setVec('material.uvTransform.tiling', 0, tiling, v)}
          />
          <UvNumberInline
            value={tiling[1]}
            label="y"
            testid={`inspector-uvtransform-tilingY-${nodeId}`}
            ariaPath="material.uvTransform.tiling.y"
            onCommit={(v) => setVec('material.uvTransform.tiling', 1, tiling, v)}
          />
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-1 text-[11px] text-fg/80">
        <span className="font-mono text-fg/60">offset</span>
        <span className="flex items-center gap-1">
          <UvNumberInline
            value={offset[0]}
            label="x"
            testid={`inspector-uvtransform-offsetX-${nodeId}`}
            ariaPath="material.uvTransform.offset.x"
            onCommit={(v) => setVec('material.uvTransform.offset', 0, offset, v)}
          />
          <UvNumberInline
            value={offset[1]}
            label="y"
            testid={`inspector-uvtransform-offsetY-${nodeId}`}
            ariaPath="material.uvTransform.offset.y"
            onCommit={(v) => setVec('material.uvTransform.offset', 1, offset, v)}
          />
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-1 text-[11px] text-fg/80">
        <span className="font-mono text-fg/60">rotation</span>
        <UvNumberInline
          value={rotation}
          label="rad"
          testid={`inspector-uvtransform-rotation-${nodeId}`}
          ariaPath="material.uvTransform.rotation"
          onCommit={(v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return;
            dispatch(
              { type: 'setParam', nodeId, paramPath: 'material.uvTransform.rotation', value: n },
              'user',
              'set material.uvTransform.rotation',
            );
          }}
        />
      </div>
    </div>
  );
}

// A controlled number input for one component of a vec2 (commits via onCommit so
// the parent merges it into the whole [x,y] array — setAtPath has no index path).
function UvNumberInline({
  value,
  label,
  testid,
  ariaPath,
  onCommit,
}: {
  value: number;
  label: string;
  testid: string;
  ariaPath: string;
  onCommit: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-[10px] text-fg/60">
      <span className="font-mono">{label}</span>
      <input
        type="number"
        step="0.1"
        value={value}
        data-testid={testid}
        aria-label={ariaPath}
        onChange={(e) => onCommit(e.target.value)}
        className="w-14 rounded border border-border bg-muted px-1 py-0.5 text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
    </label>
  );
}

// v0.7 Phase 4 (#198) — the SHARED OpenPBR lobe-row block that BOTH the native
// primitive `MaterialEditor` and the glTF `GltfMaterialEditor` render (V20/V53:
// one IR → one editor). It owns every cross-cutting per-field affordance H104
// demands a custom control re-wire, ONCE, for both callers:
//   - the ParamDiamond (keyframe toggle at `fieldPath`),
//   - the Auto-Key routing chokepoint (routeAnimatedGrab → caller's source write
//     → autoKeyCommit — the H36 single-write seam),
//   - the EVALUATED read-side (resolveEvaluatedParam → display the value the
//     renderer shows + read-only-while-playing) — closing the H40 material read
//     gap for native AND glTF at the same stroke.
// The two callers differ ONLY in the three caller-specific closures below; the
// extras (native Maps + UvTransform / glTF slot selector + edit-layer Maps) stay
// in each caller AROUND this block (the design's reduce-to-extras fork).
interface MaterialRowTestids {
  num: string;
  scrub: string;
  color: string;
  colorHex: string;
}
function MaterialRows({
  nodeId,
  fieldPath,
  readValue,
  commitSource,
  testids,
}: {
  nodeId: string;
  /** The keyframe channel path for a lobe field (native `material.<lobe>.<field>`,
   *  glTF `materials.<slot>.<lobe>.<field>`) — drives diamond + animation + read. */
  fieldPath: (lobe: string, key: string) => string;
  /** The authored base value (pre-evaluation) for a field. */
  readValue: (lobe: string, key: string, kind: 'number' | 'color') => number | string;
  /** The UN-animated source write — caller-specific (native dotted setParam, glTF
   *  whole-`materials`-array replace, since setAtPath can't index an array, V53). */
  commitSource: (lobe: string, key: string, value: number | string) => void;
  /** Per-field e2e testids — each caller keeps its existing scheme (H95, no churn). */
  testids: (lobe: string, key: string) => MaterialRowTestids;
}) {
  return (
    <>
      {MATERIAL_LOBES.map(({ lobe, label, fields }) => (
        <div key={lobe} className="flex flex-col">
          <div className="px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wide text-fg/40">
            {label}
          </div>
          {fields.map(({ key, label: fieldLabel, kind }) => {
            const path = fieldPath(lobe, key);
            const tid = testids(lobe, key);
            if (kind === 'color') {
              return (
                <MaterialColorRow
                  key={key}
                  nodeId={nodeId}
                  paramPath={path}
                  label={fieldLabel}
                  value={readValue(lobe, key, 'color') as string}
                  testidColor={tid.color}
                  testidHex={tid.colorHex}
                  onSource={(v) => commitSource(lobe, key, v)}
                />
              );
            }
            return (
              <MaterialNumberRow
                key={key}
                nodeId={nodeId}
                paramPath={path}
                label={fieldLabel}
                value={readValue(lobe, key, 'number') as number}
                testidInput={tid.num}
                testidScrub={tid.scrub}
                onSource={(v) => commitSource(lobe, key, v)}
              />
            );
          })}
        </div>
      ))}
    </>
  );
}

// One shared OpenPBR scalar row: drag-scrub label + numeric input, ParamDiamond,
// Auto-Key routing, and the H40 read-side. `value` is the authored base (the
// diamond's first-key); `effective` is the evaluated value the renderer shows
// (transient → channel → base). Read-only while a channel actively drives it
// during playback (`playing && resolved !== null`) — the VectorField D-02 gate.
function MaterialNumberRow({
  nodeId,
  paramPath,
  label,
  value,
  testidInput,
  testidScrub,
  onSource,
}: {
  nodeId: string;
  paramPath: string;
  label: string;
  value: number;
  testidInput: string;
  testidScrub: string;
  onSource: (next: number) => void;
}) {
  const frame = useTimeStore((s) => s.frame);
  const seconds = useTimeStore((s) => s.seconds);
  const normalized = useTimeStore((s) => s.normalized);
  const playing = useTimeStore((s) => s.playing);
  const dagState = useDagStore((s) => s.state);
  const resolved = useMemo(
    () => resolveEvaluatedParam(dagState, nodeId, paramPath, { time: { frame, seconds, normalized } }),
    [dagState, nodeId, paramPath, frame, seconds, normalized],
  );
  const effective = typeof resolved?.value === 'number' ? resolved.value : value;
  const readOnly = playing && resolved !== null;
  const onEdit = (next: number) => {
    // H36 single-write seam (the H104 affordance): animated → route to the channel
    // /transient and SKIP the source write; un-animated → caller's source write,
    // then autoKeyCommit (Auto-Key ON → first-key creates the free-floating channel).
    if (routeAnimatedGrab(nodeId, paramPath, next)) return;
    onSource(next);
    autoKeyCommit(nodeId, paramPath, next);
  };
  const scrub = useDragScrub({ value: effective, onCommit: onEdit });
  const display = scrub.isDragging ? scrub.previewValue : effective;
  return (
    <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
      <span className="flex items-center gap-1">
        <ParamDiamond nodeId={nodeId} paramPath={paramPath} value={value} />
        <span
          className="cursor-ew-resize select-none font-mono text-fg/60 hover:text-accent"
          onPointerDown={scrub.onPointerDown}
          data-testid={testidScrub}
          title="Drag horizontally to scrub. Shift = fine, Cmd/Ctrl = coarse."
        >
          {label}
        </span>
      </span>
      <input
        type="number"
        step="0.1"
        value={display}
        readOnly={readOnly}
        data-readonly-while-playing={readOnly || undefined}
        aria-label={label}
        data-testid={testidInput}
        className="w-24 rounded border border-border bg-muted px-2 py-0.5 text-right font-mono text-xs text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          if (Number.isNaN(next)) return;
          onEdit(next);
        }}
      />
    </label>
  );
}

// One shared OpenPBR colour row: swatch + hex input, ParamDiamond, Auto-Key
// routing, and the H40 read-side (mirrors MaterialNumberRow for strings). The
// draft tracks the EFFECTIVE value so a scrubbed/animated colour shows through.
function MaterialColorRow({
  nodeId,
  paramPath,
  label,
  value,
  testidColor,
  testidHex,
  onSource,
}: {
  nodeId: string;
  paramPath: string;
  label: string;
  value: string;
  testidColor: string;
  testidHex: string;
  onSource: (next: string) => void;
}) {
  const frame = useTimeStore((s) => s.frame);
  const seconds = useTimeStore((s) => s.seconds);
  const normalized = useTimeStore((s) => s.normalized);
  const playing = useTimeStore((s) => s.playing);
  const dagState = useDagStore((s) => s.state);
  const resolved = useMemo(
    () => resolveEvaluatedParam(dagState, nodeId, paramPath, { time: { frame, seconds, normalized } }),
    [dagState, nodeId, paramPath, frame, seconds, normalized],
  );
  const effective = typeof resolved?.value === 'string' ? resolved.value : value;
  const readOnly = playing && resolved !== null;
  const [draft, setDraft] = useState(effective);
  // Resync when the effective value changes outside this field (undo, slot switch,
  // scrub, animation, agent edit) — the input is otherwise locally edited.
  useEffect(() => setDraft(effective), [effective]);
  const commit = (next: string) => {
    if (!isHex6(next)) return;
    if (routeAnimatedGrab(nodeId, paramPath, next)) return;
    onSource(next);
    autoKeyCommit(nodeId, paramPath, next);
  };
  const swatch = isHex6(draft) ? draft : '#000000';
  return (
    <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
      <span className="flex items-center gap-1 font-mono text-fg/60">
        <ParamDiamond nodeId={nodeId} paramPath={paramPath} value={value} />
        {label}
      </span>
      <span className="flex items-center gap-1">
        <input
          type="color"
          aria-label={`${label} colour swatch`}
          value={swatch}
          disabled={readOnly}
          data-readonly-while-playing={readOnly || undefined}
          data-testid={testidColor}
          className="h-5 w-7 cursor-pointer rounded border border-border bg-muted p-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
        />
        <input
          type="text"
          aria-label={`${label} hex`}
          value={draft}
          readOnly={readOnly}
          data-readonly-while-playing={readOnly || undefined}
          data-testid={testidHex}
          className="w-20 rounded border border-border bg-muted px-2 py-0.5 text-right font-mono text-xs text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          }}
        />
      </span>
    </label>
  );
}

function MaterialEditor({ nodeId, material }: { nodeId: string; material: unknown }) {
  const dispatch = useDagStore((s) => s.dispatch);
  if (!isMaterialIR(material)) return null;
  const maps = (material.maps ?? {}) as Record<string, BakedTextureRef | null>;
  const uvt = material.uvTransform as
    | { tiling: [number, number]; offset: [number, number]; rotation: number }
    | undefined;
  return (
    <div data-testid={`inspector-material-editor-${nodeId}`} className="flex flex-col">
      {/* v0.7 Phase 4 (#198) — the SHARED lobe rows (the same MaterialRows the glTF
          editor renders). The primitive owns its material → a direct dotted
          setParam (D-07); no override decorator on material fields (native material
          fields never carried one). */}
      <MaterialRows
        nodeId={nodeId}
        fieldPath={(lobe, key) => `material.${lobe}.${key}`}
        readValue={(lobe, key, kind) => {
          const lobeObj = (material[lobe] ?? {}) as Record<string, unknown>;
          if (kind === 'color')
            return typeof lobeObj[key] === 'string' ? (lobeObj[key] as string) : '#000000';
          return typeof lobeObj[key] === 'number' ? (lobeObj[key] as number) : 0;
        }}
        commitSource={(lobe, key, value) =>
          dispatch(
            { type: 'setParam', nodeId, paramPath: `material.${lobe}.${key}`, value },
            'user',
            `edit material.${lobe}.${key}`,
          )
        }
        testids={(lobe, key) => {
          const p = `material.${lobe}.${key}`;
          return {
            num: `inspector-input-${nodeId}-${p}`,
            scrub: `inspector-scrub-${nodeId}-${p}`,
            color: `inspector-color-${nodeId}-${p}`,
            colorHex: `inspector-colorhex-${nodeId}-${p}`,
          };
        }}
      />
      <div className="flex flex-col">
        <div className="px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wide text-fg/40">
          Maps
        </div>
        {MATERIAL_MAP_SLOTS.map((slot) => (
          <MapRow key={slot} nodeId={nodeId} slot={slot} mapRef={maps[slot] ?? null} />
        ))}
      </div>
      {uvt ? <UvTransformSection nodeId={nodeId} uvTransform={uvt} /> : null}
    </div>
  );
}

function ParamRow({
  nodeId,
  paramPath,
  value,
  overrideInfo,
}: {
  nodeId: string;
  paramPath: string;
  value: unknown;
  overrideInfo?: OverrideInfo;
}) {
  // v0.6 #2 (#178, W3) — the inline material IR renders the lobe-grouped editor
  // INSTEAD of the (complex — Pro mode) fallback. Closes NPanel:636 for primitives.
  if (paramPath === 'material' && isMaterialIR(value)) {
    return <MaterialEditor nodeId={nodeId} material={value} />;
  }
  if (typeof value === 'number') {
    return (
      <NumericField
        nodeId={nodeId}
        paramPath={paramPath}
        label={paramPath}
        value={value}
        overrideInfo={overrideInfo}
      />
    );
  }
  if (isVec3(value)) {
    return (
      <VectorField
        nodeId={nodeId}
        paramPath={paramPath}
        label={paramPath}
        value={value}
        overrideInfo={overrideInfo}
      />
    );
  }
  if (typeof value === 'boolean') {
    return <BooleanField nodeId={nodeId} paramPath={paramPath} label={paramPath} value={value} />;
  }
  if (typeof value === 'string') {
    // No string param is a covered override field today (the descriptor covers
    // only numeric roughness/metalness + the vec3 TRS), so the string row needs
    // no decorator. If a string override field appears, thread overrideInfo here.
    return (
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px]">
        <span className="font-mono text-fg/60">{paramPath}</span>
        <span className="font-mono text-fg/80">{value}</span>
      </div>
    );
  }
  if (isInputBinding(value)) return null;
  return (
    <div className="px-3 py-1.5 text-[11px] text-fg/40">
      {paramPath}: <span className="text-fg/30">(complex — Pro mode)</span>
    </div>
  );
}

/**
 * Phase 151 — the transform-card Apply control (issue #151). Lives in the
 * transform section body for a selected primitive (BoxMesh/SphereMesh). Bakes
 * the TRS into geometry → a BakedMesh (one undo) via the SAME dispatch helper the
 * Object ▸ Apply menu uses. When the transform is animated it renders DISABLED
 * with the D-04 message (the dispatch-side guard is the belt; this is the chrome).
 */
function ApplyTransformControl({ nodeId }: { nodeId: string }) {
  const state = useDagStore((s) => s.state);
  const currentFrame = useTimeStore((s) => s.frame);
  const animated = isTransformAnimated(state, nodeId, currentFrame);
  const onApply = (mask: ApplyMask) => {
    void dispatchApplyTransform(nodeId, mask);
  };
  return (
    <div className="flex flex-col gap-1 px-3 py-1.5" data-testid="npanel-apply-transform">
      {animated ? (
        <div className="text-[10px] text-fg/40" data-testid="npanel-apply-animated-msg">
          Apply unavailable — transform is animated (#153/#149)
        </div>
      ) : null}
      <div className="flex items-center gap-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-fg/40">apply</span>
        {(['all', 'location', 'rotation', 'scale'] as ApplyMask[]).map((mask) => (
          <button
            key={mask}
            type="button"
            disabled={animated}
            onClick={() => onApply(mask)}
            data-testid={`npanel-apply-${mask}`}
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-fg/70 hover:bg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {mask === 'all' ? 'All' : mask.charAt(0).toUpperCase() + mask.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * v0.6 #2 (#178, W6 — D-05/D-07) — the per-submesh slot selector for a
 * MaterialOverride that wraps a MULTI-material glTF. Renders ONLY when the
 * target glTF has >=2 material slots (a primitive / single-material / not-yet-
 * loaded target shows nothing — the override is whole-child by nature). The
 * "which-slot" state IS the node's `slotIndex` param (no separate React state):
 * "All" clears it (undefined ⇒ every slot, backward-compat); a number addresses
 * that submesh. The SAME flat material controls below the selector author the
 * override; the selector only changes WHICH slot they target (D-05 — an
 * addressing dimension, not a second code path).
 */
function SlotSelector({ nodeId }: { nodeId: string }) {
  const nodes = useDagStore((s) => s.state.nodes);
  const dispatch = useDagStore((s) => s.dispatch);
  const slotCount = countOverrideSlots(nodes, nodeId);
  const params = (nodes[nodeId]?.params ?? {}) as { slotIndex?: number };
  const current = typeof params.slotIndex === 'number' ? params.slotIndex : undefined;
  // Hide the selector for whole-child targets (primitive / single-material /
  // not-yet-loaded). EXCEPTION: if a slotIndex is already set, ALWAYS render so a
  // STALE slotIndex (e.g. the asset later dropped below 2 slots → the override
  // silently matches no slot) still has an "All" reset affordance. Without this
  // the override would no-op with no UI to recover it.
  if (slotCount < 2 && current === undefined) return null;
  const setSlot = (slot: number | undefined) =>
    dispatch(
      { type: 'setParam', nodeId, paramPath: 'slotIndex', value: slot },
      'user',
      slot === undefined ? 'override all slots' : `override slot ${slot}`,
    );
  const slotButton = (label: string, slot: number | undefined, testid: string) => {
    const active = current === slot;
    return (
      <button
        key={testid}
        type="button"
        role="radio"
        aria-checked={active}
        data-testid={testid}
        onClick={() => setSlot(slot)}
        className={`rounded border px-2 py-0.5 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
          active
            ? 'border-accent bg-accent/15 text-accent'
            : 'border-border text-fg/70 hover:bg-muted hover:text-fg'
        }`}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      data-testid={`inspector-slot-selector-${nodeId}`}
      className="flex flex-col gap-1 px-3 py-1.5"
    >
      <div className="font-mono text-[10px] uppercase tracking-wide text-fg/40">Submesh</div>
      <div role="radiogroup" aria-label="Material slot" className="flex flex-wrap gap-1">
        {slotButton('All', undefined, `inspector-slot-all-${nodeId}`)}
        {Array.from({ length: slotCount }, (_, i) =>
          slotButton(String(i), i, `inspector-slot-${nodeId}-${i}`),
        )}
      </div>
    </div>
  );
}

/** One read-only row inside the glTF material readout (label · value). */
function ReadoutRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-[10px] uppercase tracking-wide text-fg/40">{label}</span>
      <span className="text-[11px] text-fg/70">{children}</span>
    </div>
  );
}

/** One render slot's embedded material, read-only. */
function GltfMaterialSlotRow({ slot }: { slot: GltfMaterialSlot }) {
  const num = (n: number | null) => (n == null ? '—' : n.toFixed(2));
  return (
    <div
      data-testid={`gltf-material-slot-${slot.slot}`}
      className="flex flex-col gap-0.5 rounded border border-border px-2 py-1.5"
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-fg/80">{slot.materialName}</span>
        <span className="font-mono text-[10px] text-fg/40">slot {slot.slot}</span>
      </div>
      <ReadoutRow label="base color">
        {slot.color ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              data-testid={`gltf-material-swatch-${slot.slot}`}
              className="inline-block h-3 w-3 rounded-sm border border-border"
              style={{ backgroundColor: slot.color }}
            />
            <span className="font-mono text-[10px] text-fg/60">{slot.color}</span>
          </span>
        ) : (
          '—'
        )}
      </ReadoutRow>
      <ReadoutRow label="metalness">{num(slot.metalness)}</ReadoutRow>
      <ReadoutRow label="roughness">{num(slot.roughness)}</ReadoutRow>
      {slot.opacity != null && slot.opacity < 1 ? (
        <ReadoutRow label="opacity">{num(slot.opacity)}</ReadoutRow>
      ) : null}
      <ReadoutRow label="maps">{slot.maps.length > 0 ? slot.maps.join(', ') : '—'}</ReadoutRow>
    </div>
  );
}

// #178 S4 — one EDITABLE field inside the glTF lobe editor. Mirrors the native
// ColorField/NumericField chrome but commits through `onCommit` (the parent
// rebuilds the WHOLE `materials` array) instead of dispatching a dotted path —
// `setAtPath` cannot index into an array (ops.ts: a `materials.0.base.color`
// path REPLACES the array with `{}`), so a glTF material edit MUST be a whole-
// array replace. No ParamDiamond/scrub/autoKey yet — material-scalar animation
// is S6; these are plain authoring fields.
function GltfMatColorField({
  testid,
  label,
  value,
  onCommit,
  diamond,
}: {
  testid: string;
  label: string;
  value: string;
  onCommit: (next: string) => void;
  diamond?: React.ReactNode;
}) {
  const [draft, setDraft] = useState(value);
  // Resync when the authored value changes outside this field (undo, slot switch).
  useEffect(() => setDraft(value), [value]);
  const commit = (next: string) => {
    if (!isHex6(next)) return;
    onCommit(next);
  };
  const swatch = isHex6(draft) ? draft : '#000000';
  return (
    <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
      <span className="flex items-center gap-1 font-mono text-fg/60">
        {diamond}
        {label}
      </span>
      <span className="flex items-center gap-1">
        <input
          type="color"
          aria-label={`${label} colour swatch`}
          value={swatch}
          data-testid={`inspector-gltfmat-color-${testid}`}
          className="h-5 w-7 cursor-pointer rounded border border-border bg-muted p-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
        />
        <input
          type="text"
          aria-label={`${label} hex`}
          value={draft}
          data-testid={`inspector-gltfmat-colorhex-${testid}`}
          className="w-20 rounded border border-border bg-muted px-2 py-0.5 text-right font-mono text-xs text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          }}
        />
      </span>
    </label>
  );
}

function GltfMatNumberField({
  testid,
  label,
  value,
  onCommit,
  diamond,
}: {
  testid: string;
  label: string;
  value: number;
  onCommit: (next: number) => void;
  diamond?: React.ReactNode;
}) {
  return (
    <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
      <span className="flex items-center gap-1 font-mono text-fg/60">
        {diamond}
        {label}
      </span>
      <input
        type="number"
        step="0.1"
        value={value}
        aria-label={label}
        data-testid={`inspector-gltfmat-num-${testid}`}
        className="w-24 rounded border border-border bg-muted px-2 py-0.5 text-right font-mono text-xs text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          if (Number.isNaN(next)) return;
          onCommit(next);
        }}
      />
    </label>
  );
}

/**
 * #178 S4 — the EDITABLE OpenPBR editor for a GltfChild's captured material(s)
 * (the visible payoff). Reuses MATERIAL_LOBES (the SAME lobe grouping native
 * Box/Sphere use) so a glTF material edits exactly like a native one (V53/V32:
 * one IR, one editor). Each field commits via a WHOLE-`materials`-array replace
 * (setAtPath can't index an array — see GltfMatColorField), matching the S3 e2e
 * write. The S3 overlay re-applies on the `materials` change (its effect deps on
 * depNodeMap) → the viewport repaints live (the falsifiable proof, [[H97]]).
 * Multi-slot children get a local slot selector — which slot to EDIT is a
 * view-only concern, NOT a DAG param (unlike MaterialOverride.slotIndex). Texture
 * maps stay on the clone (captured null, overlay preserves them) → no map rows
 * here; capture + editing land in S5. Renders ONLY when `materials` is non-empty;
 * an absent/empty array keeps the read-only readout (V10/H14 backward-compat).
 */
function GltfMaterialEditor({
  nodeId,
  materials,
}: {
  nodeId: string;
  materials: InlineMaterialSpec[];
}) {
  const dispatch = useDagStore((s) => s.dispatch);
  const [activeSlot, setActiveSlot] = useState(0);
  // Clamp: a slot switch + undo could leave activeSlot past the array end.
  const slot = activeSlot < materials.length ? activeSlot : 0;
  const mat = materials[slot] as unknown as Record<string, Record<string, unknown>>;
  // The keyframe paramPath for a lobe field — `materials.<slot>.<lobe>.<field>`,
  // targeting THIS GltfChild dagId directly (the glTF direct-channel road, V57).
  const fieldPath = (lobe: string, key: string) => `materials.${slot}.${lobe}.${key}`;
  const commit = (lobe: string, key: string, value: unknown) => {
    // #188 — keyframing parity (the H104 rule: a custom control must re-wire every
    // cross-cutting affordance, here Auto-Key). If this field is ANIMATED, route the
    // edit through the shared seam (transient hold / keyframe at the playhead) and do
    // NOT also whole-array-replace the source `materials` — the channel owns the value
    // (H36 single-write; a source write would double-apply and read as a no-op while
    // the channel drives the render). Un-animated → the existing whole-array replace,
    // then autoKeyCommit (Auto-Key ON → first-key creates the free-floating channel).
    if (routeAnimatedGrab(nodeId, fieldPath(lobe, key), value)) return;
    const cur = materials[slot] as unknown as Record<string, Record<string, unknown>>;
    const nextMat = { ...cur, [lobe]: { ...(cur[lobe] ?? {}), [key]: value } };
    const next = materials.map((m, i) => (i === slot ? nextMat : m));
    dispatch(
      { type: 'setParam', nodeId, paramPath: 'materials', value: next },
      'user',
      `edit material slot ${slot} ${lobe}.${key}`,
    );
    autoKeyCommit(nodeId, fieldPath(lobe, key), value);
  };
  // #178 S5 — edit-layer map write: rebuild the whole `materials` array setting
  // this slot's `maps.<mapSlot>` (null = inherit imported, CLEARED_MAP = remove,
  // a ref = replace). Same whole-array replace as the scalar `commit`.
  const commitMap = (mapSlot: MaterialMapSlot, value: BakedTextureRef | null) => {
    const cur = materials[slot] as unknown as { maps?: Record<string, unknown> };
    const nextMat = { ...cur, maps: { ...(cur.maps ?? {}), [mapSlot]: value } };
    const next = materials.map((m, i) => (i === slot ? nextMat : m));
    dispatch(
      { type: 'setParam', nodeId, paramPath: 'materials', value: next },
      'user',
      `edit material slot ${slot} maps.${mapSlot}`,
    );
  };
  return (
    <div data-testid={`inspector-gltf-material-editor-${nodeId}`} className="flex flex-col">
      {materials.length > 1 ? (
        <div className="flex flex-col gap-1 px-3 py-1.5">
          <div className="font-mono text-[10px] uppercase tracking-wide text-fg/40">Submesh</div>
          <div role="radiogroup" aria-label="Material slot" className="flex flex-wrap gap-1">
            {materials.map((m, i) => {
              const active = i === slot;
              return (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`inspector-gltfmat-slot-${nodeId}-${i}`}
                  onClick={() => setActiveSlot(i)}
                  className={`rounded border px-2 py-0.5 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                    active
                      ? 'border-accent bg-accent/15 text-accent'
                      : 'border-border text-fg/70 hover:bg-muted hover:text-fg'
                  }`}
                >
                  {m.name || String(i)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {MATERIAL_LOBES.map(({ lobe, label, fields }) => (
        <div key={lobe} className="flex flex-col">
          <div className="px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wide text-fg/40">
            {label}
          </div>
          {fields.map(({ key, label: fieldLabel, kind }) => {
            const lobeObj = (mat[lobe] ?? {}) as Record<string, unknown>;
            const testid = `${nodeId}-${slot}-${lobe}-${key}`;
            if (kind === 'color') {
              const cv = typeof lobeObj[key] === 'string' ? (lobeObj[key] as string) : '#000000';
              return (
                <GltfMatColorField
                  key={key}
                  testid={testid}
                  label={fieldLabel}
                  value={cv}
                  onCommit={(v) => commit(lobe, key, v)}
                  diamond={
                    <ParamDiamond nodeId={nodeId} paramPath={fieldPath(lobe, key)} value={cv} />
                  }
                />
              );
            }
            const nv = typeof lobeObj[key] === 'number' ? (lobeObj[key] as number) : 0;
            return (
              <GltfMatNumberField
                key={key}
                testid={testid}
                label={fieldLabel}
                value={nv}
                onCommit={(v) => commit(lobe, key, v)}
                diamond={
                  <ParamDiamond nodeId={nodeId} paramPath={fieldPath(lobe, key)} value={nv} />
                }
              />
            );
          })}
        </div>
      ))}
      {/* #178 S5 — edit-layer texture maps. Each row shows this slot's edit state
          (imported / replaced / cleared) + lets the director replace (pick a
          file → bake → ref), clear (remove the imported texture), or revert to
          the imported texture (null). The renderer's overlay applies it live. */}
      <div className="flex flex-col">
        <div className="px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wide text-fg/40">
          Maps
        </div>
        {MATERIAL_MAP_SLOTS.map((mapSlot) => {
          const maps = (mat.maps ?? {}) as Record<string, BakedTextureRef | null | undefined>;
          return (
            <GltfMapRow
              key={mapSlot}
              testid={`${nodeId}-${slot}-${mapSlot}`}
              slot={mapSlot}
              value={maps[mapSlot] ?? null}
              onSet={(next) => commitMap(mapSlot, next)}
            />
          );
        })}
      </div>
    </div>
  );
}

// #178 S5 — one edit-layer texture-map row for a glTF material. Three states:
// null = inherit the imported texture; CLEARED_MAP = removed; a BakedTextureRef =
// replaced. "replace" bakes a picked file (attachMapFromFile → OPFS) and sets the
// ref; "clear" sets the sentinel; "revert" sets null. A decode/persist failure
// surfaces via assetErrorStore (never a silent drop). Non-animated (maps are D-04).
function GltfMapRow({
  testid,
  slot,
  value,
  onSet,
}: {
  testid: string;
  slot: MaterialMapSlot;
  value: BakedTextureRef | null;
  onSet: (next: BakedTextureRef | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cleared = isClearedMap(value);
  const state = value == null ? 'imported' : cleared ? 'cleared' : 'replaced';
  const onPick = async (file: File) => {
    try {
      const storage = await getStorage();
      const ref = await attachMapFromFile(storage, file, slot);
      // attachMapFromFile stamps the image-UPLOAD orientation (flipY=true, the
      // native Box/Sphere convention). A glTF mesh's UVs are authored for the
      // glTF texture convention (flipY=false — what GLTFLoader sets on the
      // imported textures this replacement sits beside). Override so a replaced
      // map aligns with the SAME UVs instead of rendering vertically flipped.
      onSet({ ...ref, flipY: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      useAssetErrorStore.getState().report(`gltfmap:${slot}`, `${slot} map failed: ${msg}`);
    }
  };
  // The row is a `role=group` (NOT a `<label>`): a label wraps a single labelable
  // control, but this row holds several buttons + a hidden file input — a label
  // would associate with the file input, so clicking the slot name / state text
  // would spuriously open the OS file chooser. The group's aria-label names the
  // slot so the (otherwise generic) "pick"/"clear"/"revert" buttons read in
  // context; each button ALSO carries a slot-specific aria-label so it is
  // unambiguous on its own (6 map slots otherwise read identically).
  const stateLabel =
    state === 'replaced' ? 'replaced' : state === 'cleared' ? 'cleared' : 'imported';
  return (
    <div
      role="group"
      aria-label={`${slot} map (${stateLabel})`}
      className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80"
    >
      <span className="font-mono text-fg/60">{slot}</span>
      <span className="flex items-center gap-1">
        <span
          className="font-mono text-[10px] text-fg/40"
          data-testid={`inspector-gltfmap-state-${testid}`}
        >
          {state === 'replaced' ? '● replaced' : state === 'cleared' ? '— cleared' : 'imported'}
        </span>
        <button
          type="button"
          aria-label={`${state === 'replaced' ? 'Replace' : 'Pick'} ${slot} map`}
          data-testid={`inspector-gltfmap-pick-${testid}`}
          onClick={() => inputRef.current?.click()}
          className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] text-fg/80 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {state === 'replaced' ? 'replace' : 'pick'}
        </button>
        {state === 'imported' ? (
          <button
            type="button"
            aria-label={`Clear ${slot} map`}
            data-testid={`inspector-gltfmap-clear-${testid}`}
            onClick={() => onSet(CLEARED_MAP)}
            className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] text-fg/80 hover:text-warn focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            clear
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Revert ${slot} map to imported`}
            data-testid={`inspector-gltfmap-revert-${testid}`}
            onClick={() => onSet(null)}
            className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] text-fg/80 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            revert
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label={`${slot} map file`}
          data-testid={`inspector-gltfmap-file-${testid}`}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPick(f);
            e.target.value = '';
          }}
        />
      </span>
    </div>
  );
}

/** UX #8 — read-only readout of a glTF asset/child's embedded materials, read
 *  off the rendered clone (gltfMaterialStore, published by GltfAssetR). The
 *  embedded materials live on the clone, not the DAG, so without this the
 *  inspector's MATERIAL section is empty. Editing is via the MaterialOverride
 *  wrapper — this is inspect-only. For a GltfChild, `childId` (the node's own
 *  id, which equals the stamped basherGltfChildId) filters to that child's
 *  slots; for the whole asset it is null (all slots). */
function GltfMaterialReadout({ assetRef, childId }: { assetRef: string; childId: string | null }) {
  const slots = useGltfMaterialStore((s) => s.byAsset[assetRef]);
  const visible = (slots ?? []).filter((sl) => childId == null || sl.childId === childId);
  if (visible.length === 0) {
    return (
      <div data-testid="gltf-material-readout-empty" className="px-3 py-1.5 text-[11px] text-fg/40">
        {slots == null ? 'Materials load with the model…' : 'No materials on this part.'}
      </div>
    );
  }
  return (
    <div data-testid="gltf-material-readout" className="flex flex-col gap-2 px-3 py-1.5">
      {visible.map((sl) => (
        <GltfMaterialSlotRow key={sl.slot} slot={sl} />
      ))}
    </div>
  );
}

/** A collapsible section card. Header click toggles via
 *  inspectorSectionsStore; visual collapse combines user choice with
 *  the §5.8 default rule via resolveCollapsed. */
function SectionCard({
  nodeType,
  sectionId,
  declaredSections,
  children,
}: {
  nodeType: string;
  sectionId: SectionId;
  declaredSections: readonly SectionId[];
  children: React.ReactNode;
}) {
  const userCollapsed = useInspectorSectionsStore(
    (s) => s.collapsedByNodeType[nodeType]?.[sectionId],
  );
  const setCollapsed = useInspectorSectionsStore((s) => s.setCollapsed);
  const isDefault = isDefaultCollapsed(declaredSections, sectionId);
  const collapsed = resolveCollapsed(userCollapsed, isDefault);
  // Visual-state-aware toggle: clicking always flips what the user
  // currently SEES. The store's toggleCollapsed only sees the persisted
  // user choice, which is undefined until the user clicks once — so we
  // resolve visual state here and call setCollapsed with the explicit
  // inverse. Ensures first click on a default-collapsed section
  // expands it (the natural UX).
  const onToggle = () => setCollapsed(nodeType, sectionId, !collapsed);
  return (
    <section
      data-testid={`inspector-section-${sectionId}`}
      data-collapsed={collapsed || undefined}
      className="border-b border-border"
    >
      <button
        type="button"
        onClick={onToggle}
        data-testid={`inspector-section-toggle-${sectionId}`}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[10px] uppercase tracking-wide text-fg/60 hover:bg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <span aria-hidden className="text-fg/40">
          {collapsed ? '▸' : '▾'}
        </span>
        <span data-testid={`inspector-section-header-${sectionId}`}>
          {formatSectionLabel(sectionId)}
        </span>
      </button>
      {collapsed ? null : (
        <div data-testid={`inspector-section-body-${sectionId}`} className="flex flex-col pb-1">
          {children}
        </div>
      )}
    </section>
  );
}

export function NPanel() {
  const selectedId = useSelectionStore((s) => s.selectedNodeId);
  const node = useDagStore((s) => (selectedId ? s.state.nodes[selectedId] : null));

  // #173 — Inspector (R7) per-panel collapse. Mirrors LeftSidebar's chevron
  // pattern (the flag/persistence already lived in chromeStore since P6; this
  // wires it). Collapsed → a 28px chevron-only strip; the Layout column shrinks
  // to match. Chevrons point the opposite way from the left sidebar because the
  // inspector is right-docked: `‹` expands leftward, `›` collapses rightward.
  const collapsed = useChromeStore((s) => s.inspectorCollapsed);
  const toggleCollapsed = useChromeStore((s) => s.toggleInspector);

  // Resolve the node's declared inspectorSections via the registry
  // (the source of truth — V14 alignment). Empty array → raw fallback.
  const declaredRaw = node ? getNodeType(node.type)?.inspectorSections : undefined;
  const declared: SectionId[] = (declaredRaw ?? []).filter(isSectionId);

  // #130 (D-04) — the override-set descriptor for this node type (null for the
  // ~38 node types that track no overrides). `makeOverrideInfo` returns the
  // decorator contract for a covered field, else undefined → ParamRow renders
  // byte-identical to pre-#130. Recomputed on every params change because NPanel
  // subscribes to the node (the dot re-renders after edit/revert).
  const overrideDesc = node ? overrideDescriptor(node.type) : null;
  const makeOverrideInfo = (paramPath: string): OverrideInfo | undefined => {
    if (!overrideDesc || !node || !overrideDesc.fields.includes(paramPath)) return undefined;
    return {
      descriptor: overrideDesc,
      marked: isFieldOverridden(
        node.params as Record<string, unknown> | undefined,
        overrideDesc,
        paramPath,
      ),
    };
  };

  const inspectorLabel = `Inspector — ${node?.meta?.name ?? (node ? node.id : 'no selection')}`;

  if (collapsed) {
    // Collapsed strip: 28px wide, chevron-only (mirrors LeftSidebar's collapsed
    // aside). Clicking re-expands to the full inspector. The Layout column is
    // already 28px, so this fits without overflow.
    return (
      <aside
        data-testid="inspector"
        data-collapsed="true"
        role="region"
        aria-label={`${inspectorLabel} (collapsed)`}
        className="flex h-full w-full flex-col bg-transparent"
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          data-testid="inspector-expand-toggle"
          title="Expand inspector"
          aria-label="Expand inspector"
          className="flex h-8 w-7 items-center justify-center self-end rounded text-fg-dim hover:bg-bg-1 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ‹
        </button>
      </aside>
    );
  }

  return (
    <aside
      data-testid="inspector"
      data-collapsed="false"
      role="region"
      aria-label={inspectorLabel}
      className="no-scrollbar flex h-full flex-col overflow-y-auto bg-transparent text-xs"
    >
      {/* Spline Wave C header styling, reconciled with #174's collapse toggle:
          the `›` button sits on the Inspector's INSIDE (viewport-facing, left)
          edge — collapses rightward, mirroring LeftSidebar's toggle. */}
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border pl-1 pr-3 text-[11px] font-medium uppercase tracking-wide text-fg-dim">
        <button
          type="button"
          onClick={toggleCollapsed}
          data-testid="inspector-collapse-toggle"
          title="Collapse inspector"
          aria-label="Collapse inspector"
          className="flex h-5 w-5 items-center justify-center rounded normal-case text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ›
        </button>
        <span className="flex-1">Inspector</span>
      </header>
      {!node ? (
        // v0.6 #4 W5 (D-09) — first-run empty-state guidance. Plain text only:
        // the inspector (R7) is the W8 #2-EXCLUDED region precisely because its
        // empty body has no tabbable controls — keep it that way (no buttons),
        // so the selection-adaptive contract and the W8 baseline both hold.
        // Opaque `fg-dim` (not an `fg/N` alpha) so it clears AA on the light
        // palette (the W3/W4 lesson). Mirrors the viewport empty-state hint.
        <div data-testid="inspector-empty-hint" className="flex flex-col gap-1 p-4 text-fg-dim">
          <span>No selection.</span>
          <span>
            Click an object in the viewport, or press <span className="text-fg">+ Add</span> to
            create one.
          </span>
        </div>
      ) : (
        <>
          <div className="border-b border-border px-3 py-2 text-fg/60">
            <div className="font-mono text-fg">{node.id}</div>
            <div className="text-[10px] text-fg/40">
              {node.type} v{node.version}
            </div>
          </div>
          {declared.length === 0 ? (
            // D-08 B raw-fallback path: nodes that intentionally omit
            // inspectorSections render their params in a flat list.
            <div data-testid="inspector-raw-fallback" className="flex flex-col py-1">
              {Object.entries((node.params ?? {}) as Record<string, unknown>).map(
                ([key, value]) => (
                  <ParamRow
                    key={key}
                    nodeId={node.id}
                    paramPath={key}
                    value={value}
                    overrideInfo={makeOverrideInfo(key)}
                  />
                ),
              )}
            </div>
          ) : (
            (() => {
              // Group params by section. Params that don't route into
              // any declared section land in a "raw" bucket rendered
              // after the declared sections (typed under (complex —
              // Pro mode) or string display — preserves zero param
              // hiding while keeping unrouted params visible).
              const grouped: Map<SectionId, [string, unknown][]> = new Map();
              const unrouted: [string, unknown][] = [];
              for (const [key, value] of Object.entries(
                (node.params ?? {}) as Record<string, unknown>,
              )) {
                if (isInputBinding(value)) continue; // socket binding, not param
                // v0.6 #2 (#178, W6): slotIndex is the per-submesh addressing
                // dimension; it renders as the dedicated SlotSelector chrome at
                // the top of the material section, NOT as a raw numeric row.
                if (node.type === 'MaterialOverride' && key === 'slotIndex') continue;
                const section = paramToSection(key, declared);
                if (section === null) {
                  unrouted.push([key, value]);
                } else {
                  if (!grouped.has(section)) grouped.set(section, []);
                  grouped.get(section)!.push([key, value]);
                }
              }
              // #178 S4 — a GltfChild's captured OpenPBR materials (S2). Non-empty
              // → the MATERIAL section routes to the editable GltfMaterialEditor;
              // absent/empty → the read-only readout (V10/H14 backward-compat).
              const gltfChildMaterials =
                node.type === 'GltfChild' &&
                Array.isArray((node.params as { materials?: unknown }).materials)
                  ? ((node.params as { materials: InlineMaterialSpec[] }).materials ?? [])
                  : [];
              return (
                <>
                  {declared.map((sectionId) => (
                    <SectionCard
                      key={sectionId}
                      nodeType={node.type}
                      sectionId={sectionId}
                      declaredSections={declared}
                    >
                      {/* v0.6 #2 (#178, W6) — per-submesh slot selector at the
                          top of a glTF MaterialOverride's material section. Only
                          renders for a >=2-slot glTF target; the flat material
                          controls below author the override for the chosen slot. */}
                      {sectionId === 'material' && node.type === 'MaterialOverride' ? (
                        <SlotSelector nodeId={node.id} />
                      ) : null}
                      {/* #178 S4 — a GltfChild that captured OpenPBR materials at
                          import (S2) gets the EDITABLE lobe editor (the same one
                          Box/Sphere use); editing writes the child's `materials`
                          and the S3 overlay repaints the clone live. A GltfChild
                          with NO captured materials (pre-#178 save / empty bone)
                          and the whole-asset GltfAsset keep the read-only readout
                          (V10/H14 backward-compat). */}
                      {sectionId === 'material' &&
                      node.type === 'GltfChild' &&
                      gltfChildMaterials.length > 0 ? (
                        <GltfMaterialEditor nodeId={node.id} materials={gltfChildMaterials} />
                      ) : sectionId === 'material' &&
                        (node.type === 'GltfAsset' || node.type === 'GltfChild') ? (
                        <GltfMaterialReadout
                          assetRef={String((node.params as { assetRef?: unknown }).assetRef ?? '')}
                          childId={node.type === 'GltfChild' ? node.id : null}
                        />
                      ) : null}
                      {/* UX #9 — the Environment section is authored by a single
                          custom control, NOT raw param rows (the env params route
                          here only to leave the raw-fallback bucket). */}
                      {sectionId === 'environment' && node.type === 'Scene' ? (
                        <SceneEnvironmentControls nodeId={node.id} />
                      ) : null}
                      {/* UX #12 — the Camera (lens) section is authored by a
                          single custom control (focal length / sensor / clipping),
                          NOT raw param rows; the lens params route here only to
                          leave the raw-fallback bucket. */}
                      {sectionId === 'camera' &&
                      (node.type === 'PerspectiveCamera' || node.type === 'OrthographicCamera') ? (
                        <CameraLensControls nodeId={node.id} />
                      ) : null}
                      {sectionId === 'environment' || sectionId === 'camera'
                        ? null
                        : (grouped.get(sectionId) ?? []).map(([key, value]) => (
                            <ParamRow
                              key={key}
                              nodeId={node.id}
                              paramPath={key}
                              value={value}
                              overrideInfo={makeOverrideInfo(key)}
                            />
                          ))}
                      {/* Phase 151 — Apply control in the transform card for a
                          selected primitive (BoxMesh/SphereMesh). Bakes TRS →
                          BakedMesh via the same helper the Object ▸ Apply menu
                          uses (one undo). glTF-child Apply = Wave 4. */}
                      {sectionId === 'transform' &&
                      (node.type === 'BoxMesh' || node.type === 'SphereMesh') ? (
                        <ApplyTransformControl nodeId={node.id} />
                      ) : null}
                    </SectionCard>
                  ))}
                  {unrouted.length > 0 ? (
                    <div data-testid="inspector-unrouted-params" className="flex flex-col py-1">
                      {unrouted.map(([key, value]) => (
                        <ParamRow
                          key={key}
                          nodeId={node.id}
                          paramPath={key}
                          value={value}
                          overrideInfo={makeOverrideInfo(key)}
                        />
                      ))}
                    </div>
                  ) : null}
                </>
              );
            })()
          )}
          {node.type === 'ComfyUIWorkflow' ? (
            <CostPreviewConnector workflowNodeId={node.id} />
          ) : null}
          {(() => {
            if (node.type !== 'GltfChild') return null;
            const gp = (node.params ?? {}) as { assetRef?: unknown; childName?: unknown };
            if (typeof gp.assetRef !== 'string' || typeof gp.childName !== 'string') return null;
            return <RevertImportedClipConnector assetRef={gp.assetRef} childName={gp.childName} />;
          })()}
        </>
      )}
    </aside>
  );
}
