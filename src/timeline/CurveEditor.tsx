// CurveEditor — read-only bezier projection of the active KeyframeChannel.
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
import { resolveClipRow } from './clipChannelRows';
import { isKeyframeChannelNode } from '../app/animate/paramAnimationState';
import { EditableCurve } from './EditableCurve';

const TRACK_COLORS = ['#ef4444', '#22c55e', '#3b82f6']; // x / y / z
const SAMPLES_PER_SECOND = 30;

interface VecKey {
  time: number;
  value: readonly number[];
  easing: 'linear' | 'cubic';
}

export function CurveEditor({ duration }: { duration: number }) {
  const activeChannelId = useTimelineSelection((s) => s.activeChannelId);
  const selectedId = useSelectionStore((s) => s.selectedNodeId);
  const nodes = useDagStore((s) => s.state.nodes);
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
  // P7.12 B2 — read-only imported-clip row. A synthetic `clip:<bone>:<comp>`
  // active id has no DAG node; project its curve straight from the active
  // TransformClip's keyframes (the SAME params the renderer samples — H40
  // display-side: the curve shown must come from the clip the renderer reads,
  // never a divergent sample path). No drag handlers; an "imported" affordance
  // label tells the director the edit-to-bake gesture is available (Wave D).
  const clipRow = channelId.startsWith('clip:') ? resolveClipRow(nodes, channelId) : null;
  if (clipRow) {
    // The clip carries the whole TRS per keyframe; render the SELECTED
    // component's three axis lines (x/y/z) — position/rotation/scale Vec3s.
    const compValues = clipRow.keyframes.map((k) => k[clipRow.component]);
    const clipTracks: Track[][] = [0, 1, 2].map((vecAxis) =>
      clipRow.keyframes.map((k, ki) => ({
        time: k.time,
        value: compValues[ki][vecAxis],
        easing: 'linear' as const,
      })),
    );
    const clipSamples = sampleTracks(clipTracks, duration);
    const clipRange = computeRange(clipSamples);
    return (
      <div data-testid="curve-editor" className="relative h-full w-full bg-bg">
        <div className="absolute left-2 top-1 text-[10px] text-fg-dim">
          {clipRow.childName} — {clipRow.component}
        </div>
        <div
          data-testid="curve-readonly-label"
          className="absolute right-2 top-1 text-[10px] text-fg-dim italic"
        >
          (imported — edit to make editable)
        </div>
        <svg className="h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
          <line x1="0" y1="50" x2="100" y2="50" stroke="var(--line)" strokeWidth="0.2" />
          {clipSamples.map((track, ti) => (
            <polyline
              key={ti}
              data-testid={`curve-track-${ti}`}
              fill="none"
              stroke={TRACK_COLORS[ti % TRACK_COLORS.length]}
              strokeWidth="0.6"
              points={track
                .map((p) => {
                  const x = (p.t / Math.max(duration, 0.0001)) * 100;
                  const y = 100 - normalizeY(p.v, clipRange) * 100;
                  return `${x},${y}`;
                })
                .join(' ')}
            />
          ))}
          {clipRow.keyframes.map((k, i) => {
            const x = (k.time / Math.max(duration, 0.0001)) * 100;
            return clipTracks.map((track, ti) => (
              <circle
                key={`${i}-${ti}`}
                cx={x}
                cy={100 - normalizeY(track[i]?.value ?? 0, clipRange) * 100}
                r="0.8"
                fill="var(--fg)"
              />
            ));
          })}
          <line
            data-testid="curve-playhead"
            x1={(seconds / Math.max(duration, 0.0001)) * 100}
            y1="0"
            x2={(seconds / Math.max(duration, 0.0001)) * 100}
            y2="100"
            stroke="var(--accent)"
            strokeWidth="0.3"
          />
        </svg>
      </div>
    );
  }

  const node = nodes[channelId];
  if (!node) {
    return (
      <div
        data-testid="curve-editor"
        className="flex h-full items-center justify-center text-xs text-fg-dim"
      >
        Channel not found (it may have been deleted).
      </div>
    );
  }

  const params = (node.params ?? {}) as { keyframes?: VecKey[]; paramPath?: string };
  const keyframes = (params.keyframes ?? []).slice().sort((a, b) => a.time - b.time);

  // Authored Number / Vec3 channel → the reze-style editable graph editor
  // (UX #11). Curves are sampled THROUGH the shared keyframeInterp inside
  // EditableCurve, so what's drawn is what the renderer plays (H40).
  if (node.type === 'KeyframeChannelNumber' || node.type === 'KeyframeChannelVec3') {
    return (
      <EditableCurve
        channelId={channelId}
        channelType={node.type}
        paramPath={params.paramPath ?? ''}
        keyframes={keyframes}
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
        {node.type.replace('KeyframeChannel', '')} — {params.paramPath ?? '(no path)'}
      </span>
      <span className="text-[10px]">
        Curve preview not yet implemented for{' '}
        {node.type === 'KeyframeChannelQuat' ? 'quaternion' : 'color'} channels.
      </span>
      <span className="text-[10px]">
        {keyframes.length} keyframe{keyframes.length === 1 ? '' : 's'}; values shown in dopesheet.
      </span>
    </div>
  );
}

interface Track {
  time: number;
  value: number;
  easing: 'linear' | 'cubic';
}

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

function sampleTrack(track: Track[], duration: number): Array<{ t: number; v: number }> {
  if (track.length === 0) return [];
  const result: Array<{ t: number; v: number }> = [];
  const stepCount = Math.max(2, Math.round(duration * SAMPLES_PER_SECOND));
  for (let i = 0; i <= stepCount; i++) {
    const t = (i / stepCount) * duration;
    result.push({ t, v: sampleAt(track, t) });
  }
  return result;
}

function sampleTracks(tracks: Track[][], duration: number) {
  return tracks.map((t) => sampleTrack(t, duration));
}

function sampleAt(track: Track[], t: number): number {
  if (track.length === 0) return 0;
  if (t <= track[0].time) return track[0].value;
  const last = track[track.length - 1];
  if (t >= last.time) return last.value;
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const u = span > 0 ? (t - a.time) / span : 0;
      const eased = b.easing === 'cubic' ? smoothstep(u) : u;
      return a.value + (b.value - a.value) * eased;
    }
  }
  return last.value;
}

function computeRange(samples: Array<Array<{ t: number; v: number }>>): {
  min: number;
  max: number;
} {
  let min = Infinity;
  let max = -Infinity;
  for (const track of samples) {
    for (const s of track) {
      if (s.v < min) min = s.v;
      if (s.v > max) max = s.v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 };
  if (Math.abs(max - min) < 1e-6) return { min: min - 1, max: max + 1 };
  // 5% padding so the curve doesn't graze the SVG edges.
  const pad = (max - min) * 0.05;
  return { min: min - pad, max: max + pad };
}

function normalizeY(v: number, range: { min: number; max: number }): number {
  return (v - range.min) / Math.max(range.max - range.min, 1e-6);
}
