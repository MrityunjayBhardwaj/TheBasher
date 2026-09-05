// TimelineDrawer — Timebar (always visible) + collapsible drawer body
// hosting the dopesheet view (TimelineCanvas, the canvas-2D surface
// the SVG Dopesheet was replaced by in P6 W9), CurveEditor, and the
// LightStudioPanel (the 2D light-rig surface, #206) as tabs
// (P6 W5 — UI-SPEC §5.9; D-UX-2). The "Dopesheet" tab id/label is
// unchanged — only the rendering technology advanced (D-W9-2). Bottom
// toolbar with track-ops buttons added P6 W6.
//
// Drawer open/closed lives in viewportStore (timelineDrawerOpen).
// Default closed — preserves P0/P2 acceptance pixel-diff baselines.
//
// Active tab (when open) lives in timelineDockStore (D-W5-2: persisted).
// Tab semantics (D-W5-1): both panes stay mounted whenever the drawer
// is open; the inactive pane is hidden via `display: none` so store
// subscriptions (V8) and pane-internal scroll position survive a tab
// switch. Selecting a channel row in Dopesheet does NOT auto-switch
// to Curve Editor (D-W5-3 — explicit tab entry only).
//
// W6 adds a 28px bottom toolbar inside the drawer body. Buttons:
//   [Key] [Delete] [Simplify ▴] [Clear]
// Each wires to the same handler the corresponding keyboard shortcut
// uses (Key/Delete share buildKeyframeInsertOp / buildKeyframeDeleteOp
// from KeyboardShortcuts.tsx; Clear dispatches via the
// removeKeyframesMutator with scope:'all' — issue #60 / H36 parameterized
// what was formerly clearChannel; Simplify opens the SimplifyPopover). Track
// filters + transport buttons + Cut/Copy/Paste land later (W7+).

import { useState } from 'react';
import { useTimeStore, FRAMES_PER_SECOND } from '../app/stores/timeStore';
import { useViewportStore } from '../app/stores/viewportStore';
import { useTimelineDockStore, type TimelineTab } from '../app/stores/timelineDockStore';
import { useDagStore } from '../core/dag/store';
import { useTimelineSelection } from './timelineSelection';
import { buildKeyframeInsertOp, buildKeyframeDeleteOp } from '../app/KeyboardShortcuts';
import { removeKeyframesMutator, validatePlan } from '../agent/mutators';
// Narrow paths, not the barrel: `agent/mutators/index` re-exports every builder
// and reaches the tool registry, which imports back into `src/app` — importing
// it drags the importer into the app↔agent cycle cluster the enumeration gate
// watches. (This file already pays for that on the line above; adding to it
// rather than widening it.)
import { boneKeyOf } from '../agent/mutators/builders/channelAddress';
import { dispatchRevertGltfChannel } from '../app/animate/dispatchMutator';
import { useNotificationStore } from '../app/stores/notificationStore';
import { Timebar } from '../app/Timebar';
import { TimelineCanvas } from './TimelineCanvas';
import { CurveEditor } from './CurveEditor';
import { LightStudioPanel } from './LightStudioPanel';
import { NlaLanePane } from './NlaLanePane';
import { ControllersDockPane } from './ControllersDockPane';
import { SimplifyPopover } from './SimplifyPopover';

const DRAWER_HEIGHT_PX = 240;
const HEADER_HEIGHT_PX = 28;
const TOOLBAR_HEIGHT_PX = 28;

export function TimelineDrawer() {
  const open = useViewportStore((s) => s.timelineDrawerOpen);
  const toggle = useViewportStore((s) => s.toggleTimelineDrawer);
  const duration = useTimeStore((s) => s.durationSeconds);
  const frame = useTimeStore((s) => s.frame);
  const activeTab = useTimelineDockStore((s) => s.activeTab);
  const setActiveTab = useTimelineDockStore((s) => s.setActiveTab);

  const totalFrames = Math.max(1, Math.round(duration * FRAMES_PER_SECOND));

  return (
    <div
      data-testid="timeline-drawer"
      data-open={open}
      role="region"
      aria-label={`Timeline — frame ${frame}`}
      className="flex w-full flex-col"
    >
      {open && (
        <div
          className="flex w-full flex-col border-t border-border"
          style={{ height: DRAWER_HEIGHT_PX }}
        >
          <DockHeader
            activeTab={activeTab}
            onSelectTab={setActiveTab}
            frame={frame}
            totalFrames={totalFrames}
          />
          <div className="relative flex-1" style={{ minHeight: 0 }}>
            <div
              data-testid="timeline-canvas-pane"
              data-active={activeTab === 'dopesheet'}
              className="absolute inset-0"
              style={{ display: activeTab === 'dopesheet' ? 'flex' : 'none' }}
            >
              <TimelineCanvas duration={duration} />
            </div>
            <div
              data-testid="curve-editor-pane"
              data-active={activeTab === 'curve'}
              className="absolute inset-0"
              style={{ display: activeTab === 'curve' ? 'flex' : 'none' }}
            >
              <CurveEditor duration={duration} />
            </div>
            <div
              data-testid="nla-pane"
              data-active={activeTab === 'nla'}
              className="absolute inset-0"
              style={{ display: activeTab === 'nla' ? 'flex' : 'none' }}
            >
              <NlaLanePane />
            </div>
            <div
              data-testid="light-studio-pane"
              data-active={activeTab === 'lightStudio'}
              className="absolute inset-0"
              style={{ display: activeTab === 'lightStudio' ? 'flex' : 'none' }}
            >
              <LightStudioPanel />
            </div>
            <div
              data-testid="controllers-pane"
              data-active={activeTab === 'controllers'}
              className="absolute inset-0"
              style={{ display: activeTab === 'controllers' ? 'flex' : 'none' }}
            >
              <ControllersDockPane />
            </div>
          </div>
          {/* The track-ops toolbar is keyframe-specific — only the time tabs show
              it. The Light Studio is a spatial surface with its own affordances;
              the NLA lane view acts on strips/tracks, not timelineSelection
              channels (#283 Phase 5 — its own affordances land in 5C/5D). */}
          {!['lightStudio', 'nla', 'controllers'].includes(activeTab) ? <DockToolbar /> : null}
        </div>
      )}
      <div className="flex items-stretch">
        <button
          type="button"
          data-testid="timeline-drawer-toggle"
          aria-label={open ? 'Collapse timeline drawer' : 'Expand timeline drawer'}
          aria-expanded={open}
          className="flex w-8 items-center justify-center border-r border-border bg-bg-2 text-fg hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          onClick={toggle}
        >
          {open ? '▾' : '▴'}
        </button>
        <div className="flex-1">
          <Timebar />
        </div>
      </div>
    </div>
  );
}

function DockHeader({
  activeTab,
  onSelectTab,
  frame,
  totalFrames,
}: {
  activeTab: TimelineTab;
  onSelectTab: (tab: TimelineTab) => void;
  frame: number;
  totalFrames: number;
}) {
  return (
    <div
      data-testid="timeline-tab-strip"
      role="tablist"
      aria-label="Timeline tabs"
      className="flex items-stretch border-b border-border bg-bg-2 text-xs"
      style={{ height: HEADER_HEIGHT_PX }}
    >
      <TabButton
        id="dopesheet"
        label="Dopesheet"
        active={activeTab === 'dopesheet'}
        onClick={() => onSelectTab('dopesheet')}
      />
      <TabButton
        id="curve"
        label="Curve Editor"
        active={activeTab === 'curve'}
        onClick={() => onSelectTab('curve')}
      />
      <TabButton
        id="nla"
        label="NLA"
        active={activeTab === 'nla'}
        onClick={() => onSelectTab('nla')}
      />
      <TabButton
        id="lightStudio"
        label="Light Studio"
        active={activeTab === 'lightStudio'}
        onClick={() => onSelectTab('lightStudio')}
      />
      <TabButton
        id="controllers"
        label="Controllers"
        active={activeTab === 'controllers'}
        onClick={() => onSelectTab('controllers')}
      />
      <div className="flex-1" />
      <div className="flex items-center gap-3 px-3 text-fg-dim">
        <span data-testid="timeline-dock-frame-readout">
          {frame} / {totalFrames}
        </span>
        <span data-testid="timeline-dock-fps-readout">{FRAMES_PER_SECOND} fps</span>
      </div>
    </div>
  );
}

function TabButton({
  id,
  label,
  active,
  onClick,
}: {
  id: TimelineTab;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={`timeline-tab-${id}`}
      data-active={active}
      onClick={onClick}
      className={`flex items-center border-r border-border px-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        active ? 'bg-bg text-fg' : 'text-fg-dim hover:bg-muted/40 hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

function DockToolbar() {
  // Re-render the toolbar whenever the relevant pieces of timelineSelection
  // change, so the disabled state of each button reflects the live
  // (channel, keyframe) selection.
  const activeChannelId = useTimelineSelection((s) => s.activeChannelId);
  const activeKeyframeId = useTimelineSelection((s) => s.activeKeyframeId);
  // Pressed state for the Mute toggle — re-renders when the active channel's
  // `mute` param flips (#263). Synthetic clip rows have no DAG node → false.
  const activeChannelMuted = useDagStore((s) =>
    activeChannelId
      ? (s.state.nodes[activeChannelId]?.params as { mute?: boolean } | undefined)?.mute === true
      : false,
  );
  // Pressed state for the Solo toggle (#263) — same shape as mute.
  const activeChannelSoloed = useDagStore((s) =>
    activeChannelId
      ? (s.state.nodes[activeChannelId]?.params as { solo?: boolean } | undefined)?.solo === true
      : false,
  );
  const [simplifyOpen, setSimplifyOpen] = useState(false);

  function onKey() {
    // Op LIST, not one op: on a bone that has no channel yet the insert is
    // preceded by the mint that gives it one, and both land as one undo entry.
    const ops = buildKeyframeInsertOp();
    if (ops) {
      useDagStore.getState().dispatchAtomic(ops, 'user', 'insert keyframe');
    }
  }

  function onDelete() {
    const ops = buildKeyframeDeleteOp();
    if (ops) {
      useDagStore.getState().dispatchAtomic(ops, 'user', 'delete keyframe');
      useTimelineSelection.getState().setActiveKeyframe(null);
    }
  }

  function onMute() {
    if (!activeChannelId) return;
    const node = useDagStore.getState().state.nodes[activeChannelId];
    if (!node) return; // synthetic clip rows have no DAG node — nothing to mute
    const current = (node.params as { mute?: boolean }).mute === true;
    useDagStore
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: activeChannelId, paramPath: 'mute', value: !current }],
        'user',
        'toggle channel mute',
      );
  }

  function onSolo() {
    if (!activeChannelId) return;
    const node = useDagStore.getState().state.nodes[activeChannelId];
    if (!node) return; // synthetic clip rows have no DAG node — nothing to solo
    const current = (node.params as { solo?: boolean }).solo === true;
    useDagStore
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: activeChannelId, paramPath: 'solo', value: !current }],
        'user',
        'toggle channel solo',
      );
  }

  function onClear() {
    if (!activeChannelId) return;
    const state = useDagStore.getState().state;
    const notify = useNotificationStore.getState().notify;

    const node = state.nodes[activeChannelId];
    if (!node) {
      // A synthetic `clip:<bone>:<component>` row — read-only, no DAG node, so
      // there is no authored edit to clear. It used to fall through to
      // `validatePlan`, get "not in DAG", and return in silence; a director
      // pressing Clear on a row they can see is owed an answer, and "there is
      // nothing of yours here" is a different answer from "that failed".
      notify({
        severity: 'info',
        message: 'This row follows the clip — there are no edits of yours to clear.',
      });
      return;
    }

    // 🔑 ON A BONE, CLEAR IS A CHANNEL REMOVAL, NOT AN EMPTYING (#909).
    //
    // The band picks on PRESENCE, per component. Emptying a bone's channel in
    // place leaves it claiming its component at [0,0,0], so the bone collapses
    // to the origin while its neighbours keep walking — which reads as "Clear
    // deleted my animation" rather than as "Clear undid my edit". Deleting the
    // node returns the bone to the clip losslessly, because the clip was never
    // touched. That is the act `dispatchRevertGltfChannel` has performed per
    // bone since #121; the row points at ONE component, so it is asked for one.
    const bone = boneKeyOf(node);
    if (bone) {
      const reverted = dispatchRevertGltfChannel(bone);
      if (!reverted.ok) {
        notify({ severity: 'warn', message: `Could not clear: ${reverted.reason}` });
        return;
      }
      useTimelineSelection.getState().setActiveKeyframe(null);
      return;
    }

    const plan = validatePlan(
      removeKeyframesMutator,
      { channelId: activeChannelId, scope: 'all' as const },
      state,
      'clear channel',
    );
    if (!plan.ok) {
      // No longer silent. A refusal a director cannot see is indistinguishable
      // from a button that does nothing, which is how the bone road above went
      // unnoticed.
      notify({ severity: 'warn', message: `Could not clear: ${plan.reason}` });
      return;
    }
    if (plan.ops.length === 0) return; // already empty
    useDagStore.getState().dispatchAtomic(plan.ops, 'user', 'clear channel');
    useTimelineSelection.getState().setActiveKeyframe(null);
  }

  return (
    <div
      data-testid="timeline-dock-toolbar"
      className="relative flex items-center gap-1 border-t border-border bg-bg-2 px-2 text-xs"
      style={{ height: TOOLBAR_HEIGHT_PX }}
    >
      <ToolbarButton
        id="key"
        label="Key"
        title="Insert a keyframe at the current frame on the active channel (K)"
        disabled={activeChannelId === null}
        onClick={onKey}
      />
      <ToolbarButton
        id="delete"
        label="Delete"
        title="Delete the selected keyframe (Del)"
        disabled={activeKeyframeId === null}
        onClick={onDelete}
      />
      <span className="mx-2 h-4 w-px bg-border" />
      <ToolbarButton
        id="simplify"
        label="Simplify…"
        title="Reduce keyframe density on the active channel within tolerance"
        disabled={activeChannelId === null}
        onClick={() => setSimplifyOpen((v) => !v)}
      />
      <ToolbarButton
        id="clear"
        label="Clear"
        title="Wipe all keyframes from the active channel"
        disabled={activeChannelId === null}
        onClick={onClear}
      />
      <span className="mx-2 h-4 w-px bg-border" />
      <ToolbarButton
        id="mute"
        label="Mute"
        title="Silence the active channel — its keyframes stop driving the scene (they stay authored). Click again to unmute."
        disabled={activeChannelId === null}
        active={activeChannelMuted}
        onClick={onMute}
      />
      <ToolbarButton
        id="solo"
        label="Solo"
        title="Solo the active channel — only solo'd channels on the same object drive the scene; the rest go quiet. Click again to un-solo."
        disabled={activeChannelId === null}
        active={activeChannelSoloed}
        onClick={onSolo}
      />
      <div className="flex-1" />
      <SimplifyPopover open={simplifyOpen} onClose={() => setSimplifyOpen(false)} />
    </div>
  );
}

function ToolbarButton({
  id,
  label,
  title,
  disabled,
  active,
  onClick,
}: {
  id: string;
  label: string;
  title: string;
  disabled: boolean;
  /** Toggle buttons pass a boolean → renders a pressed style + `aria-pressed`.
   *  Plain action buttons omit it → no toggle semantics. */
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`timeline-toolbar-${id}`}
      data-disabled={disabled}
      data-active={active ? true : undefined}
      title={title}
      disabled={disabled}
      {...(active !== undefined ? { 'aria-pressed': active } : {})}
      onClick={onClick}
      className={`rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        disabled
          ? 'cursor-not-allowed text-fg-dim'
          : active
            ? 'bg-muted text-accent'
            : 'text-fg hover:bg-muted'
      }`}
    >
      {label}
    </button>
  );
}
