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
import { getStorage } from './boot';
import { useAssetErrorStore } from './stores/assetErrorStore';
import type { BakedTextureRef } from '../nodes/types';
import { useDagStore } from '../core/dag/store';
import { getNodeType } from '../core/dag/registry';
import type { NodeRef } from '../core/dag/types';
import { countOverrideSlots } from './resolveOverrideSlots';
import { useTimeStore } from './stores/timeStore';
import { useTransientEditStore, keyOf } from './stores/transientEditStore';
import { dispatchMutatorFromUI } from './animate/dispatchMutator';
import {
  dispatchApplyTransform,
  isTransformAnimated,
  type ApplyMask,
} from './animate/dispatchApplyTransform';
import { paramAnimationState } from './animate/paramAnimationState';
import {
  autoKeyCommit,
  keyParamFromTransient,
  resolveChannel,
  routeAnimatedGrab,
} from './animate/autoKeyCommit';
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
import { useInspectorSectionsStore, resolveCollapsed } from './stores/inspectorSectionsStore';
import { useSelectionStore } from './stores/selectionStore';
import { resolveTransformParam } from './resolveTransformParam';
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
// `./animate/autoKeyCommit` module (one Auto-Key chokepoint, two callers:
// this inspector AND the viewport gizmo grab — issue #68 / D-02). The
// bodies are byte-identical to the prior module-private versions, so
// NPanel's behavior is unchanged (verified: the NPanel suite stays green).
// resolveChannel is re-imported because the diamond handler also uses it.

/**
 * The 3-state inspector diamond (D-01 entry point / D-03 viz). Owns NO
 * state — renders derived `paramAnimationState` and dispatches through
 * the Wave A seam. Subscribes to `useTimeStore((s) => s.frame)` so it
 * re-derives on scrub. **Never reads currentFrameRef (V20).**
 *
 * - hollow ◇  → 'none'   : click = first-key composite (addLayer+addChannel+keyframe)
 * - filled ◆  → 'animated' (off-key) : click = single keyframe Mutator
 * - record ◆  → 'on-key' : click (or Alt-click) = removeKeyframes Mutator (scope:{time})
 *
 * Every Mutator call passes `useTimeStore.getState().seconds` (never a
 * frame int) — the on-key check via C1 is the only place frames are used.
 */
function ParamDiamond({
  nodeId,
  paramPath,
  value,
}: {
  nodeId: string;
  paramPath: string;
  value: unknown;
}) {
  const frame = useTimeStore((s) => s.frame);
  const nodes = useDagStore((s) => s.state.nodes);
  const dagState = useDagStore((s) => s.state);

  const animState = paramAnimationState(dagState, nodeId, paramPath, frame);
  // #149 F1 — the 4th color (orange). SUBSCRIBED selector (not a getState
  // snapshot) so the diamond re-renders the moment the transient is set/cleared
  // (B12). A transient only exists on an ANIMATED param (routeAnimatedGrab
  // returns false for un-animated), so it always coincides with animState !==
  // 'none' — but orange wins display regardless (the unsaved edit is the most
  // urgent signal, the Blender contract). This is FLAG-A's replacement safety
  // net: orange = "held but not persisted" (supersedes the removed reject alert).
  const isTransient = useTransientEditStore((s) => s.edits.has(keyOf(nodeId, paramPath)));

  const glyph = animState === 'none' && !isTransient ? '◇' : '◆';
  const colorClass = isTransient
    ? 'text-warn' // orange — edited-but-not-keyed (transient), TOP of precedence
    : animState === 'on-key'
      ? 'text-record' // yellow — keyed here
      : animState === 'animated'
        ? 'text-accent' // green — animated, no key here
        : 'text-fg/40 hover:text-accent'; // gray — not animated

  const onActivate = (alt: boolean) => {
    // DELETE path (unchanged): an on-key click OR Alt-click on an animated param
    // removes the on-key sample (Blender's toggle). Off-key Alt is a silent no-op.
    if (animState !== 'none' && (animState === 'on-key' || alt)) {
      const resolved = resolveChannel(nodes, nodeId, paramPath, frame);
      if (!resolved) {
        // eslint-disable-next-line no-alert
        window.alert?.('Channel not found for animated param.');
        return;
      }
      const t = resolved.onKeySeconds ?? null;
      if (t === null) return; // Alt off-key → silent no-op
      const del = dispatchMutatorFromUI(
        'mutator.timeline.removeKeyframes',
        { channelId: resolved.channelId, scope: { time: t } },
        `Delete key ${nodeId}.${paramPath}`,
      );
      if (!del.ok) {
        // eslint-disable-next-line no-alert
        window.alert?.(del.reason);
      }
      return;
    }

    // INSERT/KEY path — #149 E1: the SHARED fork (keyParamFromTransient) captures
    // the HELD TRANSIENT value (the orange edit) when present, else the authored
    // `value`, then clears the slot on success. The SAME helper K/I uses (E2), so
    // the diamond and the viewport gesture cannot drift.
    const result = keyParamFromTransient(nodeId, paramPath, value);
    if (!result.ok) {
      // eslint-disable-next-line no-alert
      window.alert?.(result.reason);
    }
  };

  return (
    <button
      type="button"
      data-testid={`inspector-diamond-${nodeId}-${paramPath}`}
      data-anim-state={animState}
      data-transient={isTransient || undefined}
      aria-label={`Toggle keyframe for ${paramPath} (${animState})`}
      title="Click to key/unkey at the playhead. Alt-click to delete a key."
      className={`select-none px-1 text-[11px] leading-none ${colorClass} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
      onClick={(e) => onActivate(e.altKey)}
    >
      {glyph}
    </button>
  );
}

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
// v0.6 #2 (#178, W3) — ColorField: a swatch + hex control that dispatches setParam
// on its color paramPath (e.g. material.base.color). Mirrors NumericField's wiring
// EXACTLY so a colour ANIMATES like any scalar: ParamDiamond (the Blender field-
// colour table, free), routeAnimatedGrab + autoKeyCommit on edit (KeyframeColor
// channels already exist), and the optional override decorator. There is no colour
// picker anywhere else in the app (grep-confirmed) — this is the one.
function isHex6(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

interface ColorFieldProps {
  nodeId: string;
  paramPath: string;
  label: string;
  value: string;
  overrideInfo?: OverrideInfo;
}

function ColorField({ nodeId, paramPath, label, value, overrideInfo }: ColorFieldProps) {
  const dispatch = useDagStore((s) => s.dispatch);
  const [draft, setDraft] = useState(value);
  // Keep the hex text in sync when the authored value changes outside this field
  // (undo, animation scrub, agent edit) — the input is otherwise locally edited.
  useEffect(() => setDraft(value), [value]);
  const commit = (next: string) => {
    if (!isHex6(next)) return;
    // SAME chokepoints as NumericField (H36 anti-double-write): animated → seam,
    // covered override field → value+bit atomic, else raw setParam; then autoKey.
    if (routeAnimatedGrab(nodeId, paramPath, next)) return;
    if (!dispatchOverrideValueEdit(nodeId, paramPath, next, overrideInfo)) {
      dispatch({ type: 'setParam', nodeId, paramPath, value: next }, 'user', `edit ${paramPath}`);
    }
    autoKeyCommit(nodeId, paramPath, next);
  };
  const swatch = isHex6(draft) ? draft : '#000000';
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
        <span className="font-mono text-fg/60">{label}</span>
      </span>
      <span className="flex items-center gap-1">
        <input
          type="color"
          aria-label={`${label} colour swatch`}
          value={swatch}
          data-testid={`inspector-color-${nodeId}-${paramPath}`}
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
          data-testid={`inspector-colorhex-${nodeId}-${paramPath}`}
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

function MaterialEditor({ nodeId, material }: { nodeId: string; material: unknown }) {
  if (!isMaterialIR(material)) return null;
  const maps = (material.maps ?? {}) as Record<string, BakedTextureRef | null>;
  return (
    <div data-testid={`inspector-material-editor-${nodeId}`} className="flex flex-col">
      {MATERIAL_LOBES.map(({ lobe, label, fields }) => (
        <div key={lobe} className="flex flex-col">
          <div className="px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wide text-fg/40">
            {label}
          </div>
          {fields.map(({ key, label: fieldLabel, kind }) => {
            const paramPath = `material.${lobe}.${key}`;
            const lobeObj = material[lobe] ?? {};
            if (kind === 'color') {
              const cv = typeof lobeObj[key] === 'string' ? (lobeObj[key] as string) : '#000000';
              return (
                <ColorField
                  key={key}
                  nodeId={nodeId}
                  paramPath={paramPath}
                  label={fieldLabel}
                  value={cv}
                />
              );
            }
            const nv = typeof lobeObj[key] === 'number' ? (lobeObj[key] as number) : 0;
            return (
              <NumericField
                key={key}
                nodeId={nodeId}
                paramPath={paramPath}
                label={fieldLabel}
                value={nv}
              />
            );
          })}
        </div>
      ))}
      <div className="flex flex-col">
        <div className="px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wide text-fg/40">
          Maps
        </div>
        {MATERIAL_MAP_SLOTS.map((slot) => (
          <MapRow key={slot} nodeId={nodeId} slot={slot} mapRef={maps[slot] ?? null} />
        ))}
      </div>
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

  return (
    <aside
      data-testid="inspector"
      role="region"
      aria-label={inspectorLabel}
      className="flex h-full flex-col overflow-y-auto border-l border-border bg-muted/40 text-xs"
    >
      <header className="border-b border-border px-3 py-2 font-mono uppercase tracking-wide text-fg/70">
        inspector
      </header>
      {!node ? (
        <div className="p-4 text-fg/40">select a node</div>
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
                      {(grouped.get(sectionId) ?? []).map(([key, value]) => (
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
