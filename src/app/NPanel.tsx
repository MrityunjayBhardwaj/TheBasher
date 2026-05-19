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

import { useDagStore } from '../core/dag/store';
import { getNodeType } from '../core/dag/registry';
import type { NodeRef } from '../core/dag/types';
import { useTimeStore } from './stores/timeStore';
import { dispatchFirstKeyComposite, dispatchMutatorFromUI } from './animate/dispatchMutator';
import { paramAnimationState } from './animate/paramAnimationState';
import { useAutoKeyStore } from './stores/autoKeyStore';
import { useDragScrub } from './dragScrub';
import {
  formatSectionLabel,
  isDefaultCollapsed,
  isSectionId,
  paramToSection,
  type SectionId,
} from './inspectorSections';
import { CostPreviewConnector } from './render/CostPreviewConnector';
import { useInspectorSectionsStore, resolveCollapsed } from './stores/inspectorSectionsStore';
import { useSelectionStore } from './stores/selectionStore';

/**
 * Find the KeyframeChannel* node that animates (nodeId, paramPath) and
 * return its id plus the exact stored `time` (SECONDS) of any sample on
 * the current frame. Single source of truth = the DAG (same scan as the
 * C1 helper). Returns null when no channel exists.
 */
function resolveChannel(
  nodes: Record<string, { id: string; type: string; params?: unknown }>,
  nodeId: string,
  paramPath: string,
  currentFrame: number,
): { channelId: string; onKeySeconds: number | null } | null {
  for (const node of Object.values(nodes)) {
    if (!node.type.startsWith('KeyframeChannel')) continue;
    const p = (node.params ?? {}) as {
      target?: unknown;
      paramPath?: unknown;
      keyframes?: unknown;
    };
    if (p.target !== nodeId || p.paramPath !== paramPath) continue;
    const kfs = Array.isArray(p.keyframes) ? (p.keyframes as { time: number }[]) : [];
    const onKey = kfs.find((kf) => Math.round(kf.time * 60) === currentFrame);
    return { channelId: node.id, onKeySeconds: onKey ? onKey.time : null };
  }
  return null;
}

/**
 * THE single Auto-Key commit chokepoint (Phase 7, Wave D / D4).
 *
 * Called by every inspector value-commit handler (NumericField +
 * VectorComponent, onChange AND onCommit) AFTER the raw `setParam`
 * dispatch. It is NOT a second DAG path — it is the SAME Wave A seam
 * (`dispatchMutatorFromUI` / `dispatchFirstKeyComposite`) the diamond
 * click uses, triggered by an edit instead of a click (RESEARCH
 * Boundary 5).
 *
 * Strictly gated on `useAutoKeyStore.getState().enabled`: when Auto-Key
 * is OFF this returns IMMEDIATELY, before any seam call, so the inspector
 * behaviour is BYTE-IDENTICAL to pre-P7 (the caller already did the raw
 * setParam; nothing else happens). This single function is the only
 * interception point — the logic is not scattered across handlers (D4
 * ownership + pre-mortem: gate once, here).
 *
 * Channel-exists ⇒ single `keyframe` Mutator at the current SECONDS
 * (never a frame — the single conversion rule). No channel ⇒ first-key
 * composite. Both at `useTimeStore.getState().seconds`.
 */
function autoKeyCommit(nodeId: string, paramPath: string, value: unknown): void {
  if (!useAutoKeyStore.getState().enabled) return; // OFF → byte-identical pre-P7

  const seconds = useTimeStore.getState().seconds;
  const frame = useTimeStore.getState().frame;
  const dagState = useDagStore.getState().state;

  // `paramAnimationState !== 'none'` ⇔ a KeyframeChannel* already animates
  // this (nodeId, paramPath) — the SAME pure scan the diamond uses (C1).
  const exists = paramAnimationState(dagState, nodeId, paramPath, frame) !== 'none';

  let result: { ok: true } | { ok: false; reason: string };
  if (!exists) {
    result = dispatchFirstKeyComposite({ targetId: nodeId, paramPath, value, seconds });
  } else {
    const resolved = resolveChannel(dagState.nodes, nodeId, paramPath, frame);
    if (!resolved) {
      result = { ok: false, reason: 'Auto-Key: channel not found for animated param.' };
    } else {
      result = dispatchMutatorFromUI(
        'mutator.timeline.keyframe',
        { channelId: resolved.channelId, time: seconds, value },
        `Auto-Key ${nodeId}.${paramPath}`,
      );
    }
  }
  if (!result.ok) {
    // eslint-disable-next-line no-alert
    window.alert?.(result.reason);
  }
}

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

  const glyph = animState === 'none' ? '◇' : '◆';
  const colorClass =
    animState === 'on-key'
      ? 'text-record'
      : animState === 'animated'
        ? 'text-accent'
        : 'text-fg/40 hover:text-accent';

  const onActivate = (alt: boolean) => {
    const seconds = useTimeStore.getState().seconds;
    let result: { ok: true } | { ok: false; reason: string };

    if (animState === 'none') {
      result = dispatchFirstKeyComposite({
        targetId: nodeId,
        paramPath,
        value,
        seconds,
      });
    } else {
      const resolved = resolveChannel(nodes, nodeId, paramPath, frame);
      if (!resolved) {
        // Should not happen (animState !== 'none' ⇒ channel exists) but
        // never mutate-and-pray — surface the inconsistency.
        result = { ok: false, reason: 'Channel not found for animated param.' };
      } else if (animState === 'on-key' || alt) {
        // Delete the on-key sample. Use the channel's exact stored
        // SECONDS for the sample on this frame (frame-rounded match).
        const t =
          resolved.onKeySeconds ??
          // Alt-click on an off-key frame: nothing to delete here —
          // Blender Alt-I is a silent no-op off a key.
          null;
        if (t === null) {
          result = { ok: true };
        } else {
          result = dispatchMutatorFromUI(
            'mutator.timeline.removeKeyframes',
            { channelId: resolved.channelId, scope: { time: t } },
            `Delete key ${nodeId}.${paramPath}`,
          );
        }
      } else {
        // 'animated' off-key → add a key at the current seconds.
        result = dispatchMutatorFromUI(
          'mutator.timeline.keyframe',
          { channelId: resolved.channelId, time: seconds, value },
          `Key ${nodeId}.${paramPath}`,
        );
      }
    }

    if (!result.ok) {
      // Surface the rejection — never silently swallow (C2 constraint).
      // eslint-disable-next-line no-alert
      window.alert?.(result.reason);
    }
  };

  return (
    <button
      type="button"
      data-testid={`inspector-diamond-${nodeId}-${paramPath}`}
      data-anim-state={animState}
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
}

function NumericField({ nodeId, paramPath, label, value }: NumericFieldProps) {
  const dispatch = useDagStore((s) => s.dispatch);
  const scrub = useDragScrub({
    value,
    onCommit: (next) => {
      dispatch({ type: 'setParam', nodeId, paramPath, value: next }, 'user', `scrub ${paramPath}`);
      autoKeyCommit(nodeId, paramPath, next);
    },
  });
  const display = scrub.isDragging ? scrub.previewValue : value;
  return (
    <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
      <span className="flex items-center gap-1">
        <ParamDiamond nodeId={nodeId} paramPath={paramPath} value={value} />
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
        data-testid={`inspector-input-${nodeId}-${paramPath}`}
        className="w-24 rounded border border-border bg-muted px-2 py-0.5 text-right font-mono text-xs text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          if (Number.isNaN(next)) return;
          dispatch({ type: 'setParam', nodeId, paramPath, value: next });
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
}: {
  nodeId: string;
  paramPath: string;
  axisLabel: string;
  axisIndex: number;
  value: number;
  vec: readonly number[];
}) {
  const dispatch = useDagStore((s) => s.dispatch);
  const scrub = useDragScrub({
    value,
    onCommit: (next) => {
      const newVec = [...vec] as number[];
      newVec[axisIndex] = next;
      dispatch(
        { type: 'setParam', nodeId, paramPath, value: newVec },
        'user',
        `scrub ${paramPath}.${axisLabel}`,
      );
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
        data-testid={`inspector-vec-${nodeId}-${paramPath}-${axisLabel}`}
        className="w-full rounded border border-border bg-muted px-1.5 py-0.5 text-right font-mono text-[11px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          if (Number.isNaN(next)) return;
          const newVec = [...vec] as number[];
          newVec[axisIndex] = next;
          dispatch({ type: 'setParam', nodeId, paramPath, value: newVec });
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
}: {
  nodeId: string;
  paramPath: string;
  label: string;
  value: readonly number[];
}) {
  const dims = ['x', 'y', 'z'];
  return (
    <div className="flex flex-col gap-1 px-3 py-1.5 text-[11px] text-fg/80">
      <span className="flex items-center gap-1">
        <ParamDiamond nodeId={nodeId} paramPath={paramPath} value={value} />
        <span className="font-mono text-fg/60">{label}</span>
      </span>
      <div className="flex gap-1">
        {value.slice(0, 3).map((v, i) => (
          <VectorComponent
            key={dims[i]}
            nodeId={nodeId}
            paramPath={paramPath}
            axisLabel={dims[i]}
            axisIndex={i}
            value={v}
            vec={value}
          />
        ))}
      </div>
    </div>
  );
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
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
function ParamRow({
  nodeId,
  paramPath,
  value,
}: {
  nodeId: string;
  paramPath: string;
  value: unknown;
}) {
  if (typeof value === 'number') {
    return <NumericField nodeId={nodeId} paramPath={paramPath} label={paramPath} value={value} />;
  }
  if (isVec3(value)) {
    return <VectorField nodeId={nodeId} paramPath={paramPath} label={paramPath} value={value} />;
  }
  if (typeof value === 'string') {
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
                  <ParamRow key={key} nodeId={node.id} paramPath={key} value={value} />
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
                      {(grouped.get(sectionId) ?? []).map(([key, value]) => (
                        <ParamRow key={key} nodeId={node.id} paramPath={key} value={value} />
                      ))}
                    </SectionCard>
                  ))}
                  {unrouted.length > 0 ? (
                    <div data-testid="inspector-unrouted-params" className="flex flex-col py-1">
                      {unrouted.map(([key, value]) => (
                        <ParamRow key={key} nodeId={node.id} paramPath={key} value={value} />
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
        </>
      )}
    </aside>
  );
}
