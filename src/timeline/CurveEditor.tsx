// CurveEditor — the graph editor for the active timeline row: a KeyframeChannel node, or a curve in a
// character's pose layer (#1215), both resolved by the row resolver the dopesheet's key editing uses.
//
// Renders the channel's interpolated curve over [0, duration]. Number
// channels render a single line; Vec3 renders three lines (x/y/z). Quat
// and Color are scope-deferred — quaternion handles + color paths are
// uncommon authoring surfaces and need their own UI affordance pass.
//
// V8 file-rooted: pure projection. Drag-edit emits setParam Ops via a
// component imported from src/app/ in a follow-on commit.

import { useMemo } from 'react';
import { useDagStore } from '../core/dag/store';
import { useTimeStore } from '../app/stores/timeStore';
import { useSelectionStore } from '../app/stores/selectionStore';
import { useTimelineSelection } from './timelineSelection';
import { isKeyframeChannelNode } from '../app/animate/paramAnimationState';
import { EditableCurve } from './EditableCurve';
import { isComputedRowId, layerChannelRows, parseLayerRowId } from './layerChannelRows';
import { resolveRowChannelForWrite } from '../app/animate/rowChannelWrite';

interface VecKey {
  time: number;
  value: readonly number[];
  easing: 'linear' | 'cubic';
}

export function CurveEditor({ duration }: { duration: number }) {
  const activeChannelId = useTimelineSelection((s) => s.activeChannelId);
  const selectedId = useSelectionStore((s) => s.selectedNodeId);
  const dagState = useDagStore((s) => s.state);
  const nodes = dagState.nodes;
  const seconds = useTimeStore((s) => s.seconds);

  // #163 — when no channel row is explicitly active, fall back to a channel of
  // the SELECTED object so the curve editor isn't empty after keying. Grounded:
  // Blender's Graph Editor / Houdini's Animation Editor show the selected
  // object's curves automatically — you don't tab to the dopesheet to pick one.
  // READ-ONLY fallback (no store write): an explicit Dopesheet row-pin still
  // wins, and the pane causes no side-effect while mounted-hidden (it is kept
  // mounted CSS-hidden when not on the Curve tab / not in Animate mode).
  const channelId = useMemo(() => {
    if (activeChannelId != null) return activeChannelId;
    let firstAny: string | null = null;
    for (const [id, n] of Object.entries(nodes)) {
      if (!isKeyframeChannelNode(n)) continue;
      if (firstAny == null) firstAny = id;
      const target = (n.params as { target?: string } | undefined)?.target;
      if (selectedId && target === selectedId) return id; // prefer the selection's channel
    }
    // #1215 — a selected armature Object's keys live in its pose layers: its first layer curve.
    if (selectedId && nodes[selectedId]?.type === 'Object') {
      const first = layerChannelRows(nodes, selectedId)[0];
      if (first) return first.channelId;
    }
    return firstAny; // else the first channel in the project
  }, [activeChannelId, nodes, selectedId]);

  if (channelId == null) {
    return (
      <div
        data-testid="curve-editor"
        className="flex h-full items-center justify-center px-4 text-center text-xs text-fg-dim"
      >
        No animated channels yet — keyframe a property (◇ in the inspector) to see its curve.
      </div>
    );
  }
  // #1215 — a computed source's row (a retarget, a generated clip): read-only until baked. Its keys
  // are where the source's poses land; there is no curve to edit, and bake is the road to one.
  if (isComputedRowId(channelId)) {
    return (
      <div
        data-testid="curve-editor"
        className="flex h-full items-center justify-center px-4 text-center text-xs text-fg-dim"
      >
        Computed motion — “bake motion to keys” in the inspector makes its keys editable.
      </div>
    );
  }

  // A channel node's row or a pose layer's row (#1215): one resolver answers where the curve lives,
  // what it holds and how to write it — the same road K / Delete / drag take in the dopesheet.
  const curve = resolveRowChannelForWrite(dagState, channelId);
  if (!curve) {
    return (
      <div
        data-testid="curve-editor"
        className="flex h-full items-center justify-center text-xs text-fg-dim"
      >
        Channel not found (it may have been deleted).
      </div>
    );
  }

  const params = curve.params as { keyframes?: VecKey[]; paramPath?: string };
  const keyframes = (params.keyframes ?? []).slice().sort((a, b) => a.time - b.time);
  const layer = parseLayerRowId(channelId);
  const paramPath = params.paramPath ?? layer?.component ?? '';
  const nodeType = curve.nodeType;

  // Authored Number / Vec3 channel → the reze-style editable graph editor
  // (UX #11). Curves are sampled THROUGH the shared keyframeInterp inside
  // EditableCurve, so what's drawn is what the renderer plays (H40).
  if (nodeType === 'KeyframeChannelNumber' || nodeType === 'KeyframeChannelVec3') {
    return (
      <EditableCurve
        channelId={channelId}
        channelType={nodeType}
        paramPath={paramPath}
        keyframes={keyframes}
        curve={curve.params}
        write={curve.write}
        duration={duration}
        seconds={seconds}
      />
    );
  }

  // Quat / Color channels — slerp + HSL-lerp curves don't render as a 1D-y
  // trace yet. Surface the metadata so the user sees the channel is selected;
  // full visualization lands when the curve editor grows a quaternion-arc /
  // color-strip projection.
  return (
    <div
      data-testid="curve-editor"
      className="flex h-full flex-col items-center justify-center gap-1 text-xs text-fg-dim"
    >
      <span>
        {nodeType.replace('KeyframeChannel', '')} — {paramPath || '(no path)'}
      </span>
      <span className="text-[10px]">
        Curve preview not yet implemented for{' '}
        {nodeType === 'KeyframeChannelQuat' ? 'quaternion' : 'color'} channels.
      </span>
      <span className="text-[10px]">
        {keyframes.length} keyframe{keyframes.length === 1 ? '' : 's'}; values shown in dopesheet.
      </span>
    </div>
  );
}
