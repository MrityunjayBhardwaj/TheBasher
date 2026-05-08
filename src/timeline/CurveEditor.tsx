// CurveEditor — read-only bezier projection of the active KeyframeChannel.
//
// Renders the channel's interpolated curve over [0, duration]. Number
// channels render a single line; Vec3 renders three lines (x/y/z). Quat
// and Color are scope-deferred — quaternion handles + color paths are
// uncommon authoring surfaces and need their own UI affordance pass.
//
// V8 file-rooted: pure projection. Drag-edit emits setParam Ops via a
// component imported from src/app/ in a follow-on commit.

import { useDagStore } from '../core/dag/store';
import { useTimeStore } from '../app/stores/timeStore';
import { useTimelineSelection } from './timelineSelection';

const TRACK_COLORS = ['#ef4444', '#22c55e', '#3b82f6']; // x / y / z
const SAMPLES_PER_SECOND = 30;

interface VecKey {
  time: number;
  value: readonly number[];
  easing: 'linear' | 'cubic';
}

export function CurveEditor({ duration }: { duration: number }) {
  const channelId = useTimelineSelection((s) => s.activeChannelId);
  const nodes = useDagStore((s) => s.state.nodes);
  const seconds = useTimeStore((s) => s.seconds);

  if (channelId == null) {
    return (
      <div data-testid="curve-editor" className="flex h-full items-center justify-center text-xs text-mute">
        Select a channel row above to view its curve.
      </div>
    );
  }
  const node = nodes[channelId];
  if (!node) {
    return (
      <div data-testid="curve-editor" className="flex h-full items-center justify-center text-xs text-mute">
        Channel not found (it may have been deleted).
      </div>
    );
  }

  const params = (node.params ?? {}) as { keyframes?: VecKey[]; paramPath?: string };
  const keyframes = (params.keyframes ?? []).slice().sort((a, b) => a.time - b.time);

  const tracks = expandToTracks(node.type, keyframes);
  const samples = sampleTracks(tracks, duration);
  const yRange = computeRange(samples);

  return (
    <div data-testid="curve-editor" className="relative h-full w-full bg-bg">
      <div className="absolute left-2 top-1 text-[10px] text-mute">
        {node.type.replace('KeyframeChannel', '')} — {params.paramPath ?? '(no path)'}
      </div>
      <svg className="h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
        <line x1="0" y1="50" x2="100" y2="50" stroke="var(--line)" strokeWidth="0.2" />
        {samples.map((track, ti) => (
          <polyline
            key={ti}
            data-testid={`curve-track-${ti}`}
            fill="none"
            stroke={TRACK_COLORS[ti % TRACK_COLORS.length]}
            strokeWidth="0.6"
            points={track
              .map((p) => {
                const x = (p.t / Math.max(duration, 0.0001)) * 100;
                const y = 100 - normalizeY(p.v, yRange) * 100;
                return `${x},${y}`;
              })
              .join(' ')}
          />
        ))}
        {keyframes.map((k, i) => {
          const x = (k.time / Math.max(duration, 0.0001)) * 100;
          return tracks.map((track, ti) => (
            <circle
              key={`${i}-${ti}`}
              cx={x}
              cy={100 - normalizeY(track[i]?.value ?? 0, yRange) * 100}
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

interface Track {
  time: number;
  value: number;
  easing: 'linear' | 'cubic';
}

function expandToTracks(channelType: string, keyframes: VecKey[]): Track[][] {
  if (keyframes.length === 0) return [];
  if (channelType === 'KeyframeChannelNumber') {
    return [
      keyframes.map((k) => ({
        time: k.time,
        value: typeof k.value === 'number' ? k.value : Number(k.value) || 0,
        easing: k.easing,
      })),
    ];
  }
  if (channelType === 'KeyframeChannelVec3') {
    return [0, 1, 2].map((axis) =>
      keyframes.map((k) => ({
        time: k.time,
        value: Array.isArray(k.value) ? Number(k.value[axis] ?? 0) : 0,
        easing: k.easing,
      })),
    );
  }
  // Quat / Color: skipped in v0.5 — render no tracks.
  return [];
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

function computeRange(samples: Array<Array<{ t: number; v: number }>>): { min: number; max: number } {
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
