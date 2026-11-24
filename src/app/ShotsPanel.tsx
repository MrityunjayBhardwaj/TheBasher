// ShotsPanel — the film's shots, one row each, in the bottom drawer's Shots tab (#1595; moved
// out of the left sidebar by #1703).
//
// The rows are DERIVED from the keys on the active camera (`shots.ts`); nothing here stores a
// shot. Each edit is one undo step written as those keys (`shotOps.ts`), the same data the agent
// writes, and a cut moves by moving its key — in the dopesheet, on the "Camera cuts" row.
//
//   row     — Shot N · its time range · the camera that films it (a picker) · its speed · remove
//             its cut
//   click   — select the shot's camera and put the playhead on the shot's first frame; the view
//             stays where it is (#1708: look-through is a viewport setting, not a side effect)
//   double-click — the same, and look through the camera (Numpad 0 / Esc / an orbit drag toggle
//             it back)
//   footer  — cut at the playhead to a chosen camera · a new camera from the current view ·
//             keep length (a speed change leaves the shot's length alone)
//
// #1700 — speed is edited on the shot, as Premiere's Speed/Duration is on a clip: it writes the
// film's speed curve across the shot and the shot grows or shrinks, pushing everything after it on
// the playhead's clock (`shotSpeed.ts`), all as one undo step.
//
// V8 file-rooted: src/app/. Reads the DAG + time stores; writes only through dispatchAtomic.

import { useProposedNodeIds } from '../agent/diff/useProposal';
import { PROPOSAL_AMBER } from './proposalStyle';
import { useMemo, useState, type ReactNode } from 'react';
import { useDagStore } from '../core/dag/store';
import { useTimeStore } from './stores/timeStore';
import { useViewportStore } from './stores/viewportStore';
import { useSelectionStore } from './stores/selectionStore';
import { enumerateCameraNodeIds } from './activeCamera';
import { nodeDisplayName } from './sceneTreeWalk';
import { sceneEndSeconds } from './sceneRange';
import { shotsOf } from './shots';
import { shotCameraColors } from './shotColors';
import { buildCutOps, buildRemoveCutOps, buildSetShotCameraOps } from './shotOps';
import { buildShotSpeedOps, speedOver } from './shotSpeed';
import { snapshotCameraFromOrbit } from './character/cameraFromView';
import type { Op } from '../core/dag/types';

const secs = (t: number) => `${t.toFixed(2)} s`;

function commit(ops: Op[] | null, label: string): void {
  if (ops && ops.length > 0) useDagStore.getState().dispatchAtomic(ops, 'user', label);
}

export function ShotsPanel(): ReactNode {
  const state = useDagStore((s) => s.state);
  const playhead = useTimeStore((s) => s.filmSeconds);
  const end = sceneEndSeconds(state);
  const view = useMemo(() => shotsOf(state, end), [state, end]);
  const cameras = useMemo(() => enumerateCameraNodeIds(state), [state]);
  // #1708 — each shot wears its camera's colour, the one its frame draws in the viewport.
  const colors = useMemo(() => shotCameraColors(view.shots), [view]);
  const nameOf = (id: string | null) => (id ? nodeDisplayName(state.nodes, id) : 'No camera');
  const current = view.shots.find((s) => playhead >= s.start && playhead < s.end) ?? null;
  // The camera a new cut goes to: the first one that is not on screen at the playhead.
  const [cutTo, setCutTo] = useState<string | null>(null);
  const [keepLength, setKeepLength] = useState(false);
  const target =
    cutTo && cameras.includes(cutTo)
      ? cutTo
      : (cameras.find((c) => c !== current?.cameraId) ?? null);

  // #1708 — a click picks the shot: its camera becomes the selection and the playhead goes to its
  // first frame. The view is left alone; looking through is the double-click (or Numpad 0).
  const goTo = (shot: { start: number; cameraId: string | null }) => {
    if (shot.cameraId) useSelectionStore.getState().select(shot.cameraId);
    useTimeStore.getState().setTime(shot.start);
  };
  const lookThrough = (shot: { start: number; cameraId: string | null }) => {
    goTo(shot);
    useViewportStore.getState().setLookThroughCamera(true);
  };

  // #1706 — a pending proposal that changes the cuts (the CameraSelect or its channel) frames the
  // shot list in the proposal amber; the list shown is still the applied one.
  const proposedIds = useProposedNodeIds('shots');
  const proposed =
    (view.selectId !== null && proposedIds.has(view.selectId)) ||
    (view.channelId !== null && proposedIds.has(view.channelId));

  return (
    <div
      data-testid="shots-panel"
      data-proposed={proposed || undefined}
      className="flex min-h-0 grow flex-col"
      style={proposed ? { boxShadow: `inset 0 0 0 2px ${PROPOSAL_AMBER}` } : undefined}
    >
      {proposed ? (
        <p
          data-testid="shots-proposed"
          className="px-2 pt-1 text-[11px]"
          style={{ color: PROPOSAL_AMBER }}
        >
          A proposed change to the cuts is waiting in chat · not applied
        </p>
      ) : null}
      <ol className="flex min-h-0 grow flex-col gap-1 overflow-y-auto px-2 py-2">
        {view.shots.map((shot) => {
          const isCurrent = shot === current;
          return (
            <li
              key={`${shot.index}-${shot.start}`}
              data-testid={`shot-row-${shot.index}`}
              data-current={isCurrent || undefined}
              className={`group flex flex-col gap-1 rounded border px-2 py-1.5 text-[12px] ${
                isCurrent ? 'border-accent bg-bg-1' : 'border-border hover:bg-bg-1'
              }`}
            >
              <button
                type="button"
                data-testid={`shot-select-${shot.index}`}
                onClick={() => goTo(shot)}
                onDoubleClick={() => lookThrough(shot)}
                title="Select this shot's camera · Double-click to look through it"
                className="flex items-baseline gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                <span
                  data-testid={`shot-color-${shot.index}`}
                  data-color={colors.get(shot.cameraId ?? '') ?? undefined}
                  aria-hidden
                  className="h-2 w-2 shrink-0 self-center rounded-full"
                  style={{ background: colors.get(shot.cameraId ?? '') ?? 'transparent' }}
                />
                <span className="font-medium text-fg">Shot {shot.index + 1}</span>
                <span className="font-mono text-[11px] text-fg-dim">
                  {secs(shot.start)} – {secs(shot.end)}
                </span>
              </button>
              <div className="flex items-center gap-1">
                <select
                  data-testid={`shot-camera-${shot.index}`}
                  aria-label={`Camera for shot ${shot.index + 1}`}
                  value={shot.cameraId ?? ''}
                  disabled={cameras.length < 2 || view.cutsSilenced}
                  onChange={(e) =>
                    commit(
                      buildSetShotCameraOps(state, shot.start, e.target.value),
                      `Shot ${shot.index + 1} on ${nameOf(e.target.value)}`,
                    )
                  }
                  className="min-w-0 grow rounded border border-border bg-bg-2 px-1 py-0.5 text-[12px] text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                >
                  {cameras.map((id) => (
                    <option key={id} value={id}>
                      {nameOf(id)}
                    </option>
                  ))}
                </select>
                <ShotSpeedInput
                  index={shot.index}
                  percent={Math.round(speedOver(state, shot.start, shot.end) * 100)}
                  onCommit={(percent) =>
                    commit(
                      buildShotSpeedOps(state, shot.start, shot.end, percent / 100, {
                        keepLength,
                      })?.ops ?? null,
                      `Shot ${shot.index + 1} at ${percent}%`,
                    )
                  }
                />
                {shot.keyTime !== null && shot.index > 0 && (
                  <button
                    type="button"
                    data-testid={`shot-remove-${shot.index}`}
                    onClick={() =>
                      commit(
                        buildRemoveCutOps(state, shot.keyTime!),
                        `Remove the cut at ${secs(shot.start)}`,
                      )
                    }
                    title="Remove this cut: the shot before runs on"
                    aria-label={`Remove the cut before shot ${shot.index + 1}`}
                    className="rounded px-1 text-fg-dim hover:bg-bg-2 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  >
                    ×
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {view.cutsSilenced && (
        // #1747 — the cuts channel is muted, soloed out or weighted to nothing: the film plays the
        // switch's own camera, so its keys cut nothing and writing more of them would not either.
        <p data-testid="shots-cuts-muted" className="px-2 pb-1 text-[11px] text-fg-dim">
          Camera cuts are muted: the whole film plays {nameOf(view.shots[0]?.cameraId ?? null)}.
          Unmute the Camera cuts channel to cut again.
        </p>
      )}
      <footer className="flex flex-col gap-1 border-t border-border px-2 py-2 text-[12px]">
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="shots-cut-here"
            disabled={!target || view.cutsSilenced}
            onClick={() =>
              target &&
              commit(
                buildCutOps(state, playhead, target),
                `Cut to ${nameOf(target)} at ${secs(playhead)}`,
              )
            }
            title={target ? undefined : 'Add a second camera to cut to'}
            className="shrink-0 rounded border border-border px-2 py-0.5 text-fg hover:bg-bg-1 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Cut at {secs(playhead)} to
          </button>
          <select
            data-testid="shots-cut-camera"
            aria-label="Camera to cut to"
            value={target ?? ''}
            disabled={cameras.length < 2}
            onChange={(e) => setCutTo(e.target.value)}
            className="min-w-0 grow rounded border border-border bg-bg-2 px-1 py-0.5 text-[12px] text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {cameras.map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </select>
        </div>
        <label
          className="flex items-center gap-1 text-fg-dim"
          title="Change a shot's speed without changing its length: nothing after it moves"
        >
          <input
            type="checkbox"
            data-testid="shots-keep-length"
            checked={keepLength}
            onChange={(e) => setKeepLength(e.target.checked)}
          />
          Keep length when changing speed
        </label>
        <button
          type="button"
          data-testid="shots-camera-from-view"
          onClick={() => void snapshotCameraFromOrbit()}
          title="Add a camera where the view is now"
          className="rounded border border-border px-2 py-0.5 text-left text-fg hover:bg-bg-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          + New camera from this view
        </button>
      </footer>
    </div>
  );
}

/** A shot's speed in percent. Commits on Enter or on leaving the field; a value that is not a
 *  positive number puts the shown speed back. */
function ShotSpeedInput(props: {
  index: number;
  percent: number;
  onCommit: (percent: number) => void;
}): ReactNode {
  const { index, percent, onCommit } = props;
  return (
    <label
      className="flex shrink-0 items-center gap-0.5 font-mono text-[11px] text-fg-dim"
      title="Shot speed: 50% plays the scene at half speed and makes the shot twice as long"
    >
      <input
        // Re-mounted when the speed changes, so the field always starts from what plays.
        key={percent}
        type="number"
        min={1}
        step={5}
        defaultValue={percent}
        data-testid={`shot-speed-${index}`}
        aria-label={`Speed of shot ${index + 1}, in percent`}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onBlur={(e) => {
          const n = Number(e.currentTarget.value);
          if (Number.isFinite(n) && n > 0 && n !== percent) onCommit(n);
          else e.currentTarget.value = String(percent);
        }}
        className="w-12 rounded border border-border bg-transparent px-1 text-right tabular-nums text-fg"
      />
      %
    </label>
  );
}
