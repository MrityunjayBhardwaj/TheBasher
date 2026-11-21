// NlaGeneratedRuns — a generated run as a strip in the NLA pane, stale in amber, with Re-cook and
// New seed on the strip itself (#1721, design board 13c).
//
// One row per generated clip (a clip cooked by a `MotionGenerate`), the strip spanning the run as
// it plays: from 0 to the clip's baked length. Display and the two buttons only — a run's timing is
// the generator's, not an NLA placement, so the strip is not dragged or trimmed here, and these
// rows stay OUT of `buildNlaLanes`, whose rows are parity-gated against the fold.
//
// The decision (stale, and why) is `generatedRuns`, a pure function of the graph; the action is
// `recookMotion` / `recookWithNewSeed`, the same road the generator's inspector card presses. This
// file is the wiring and nothing else.
//
// REF: src/nodes/motionGenerateRuns.ts (the decision); src/app/asset/recookMotion.ts (the action);
//      src/timeline/NlaLanePane.tsx (where it mounts); issue #1721.

import { useMemo, useState } from 'react';
import { useDagStore } from '../core/dag/store';
import { FRAMES_PER_SECOND } from '../app/stores/timeStore';
import { uiEvaluatorCache } from '../app/uiEvaluatorCache';
import { generatedRuns, staleRunLabel, type GeneratedRun } from '../nodes/motionGenerateRuns';
import { recookMotion, recookWithNewSeed, seedIsDriven } from '../app/asset/recookMotion';
import { useTimelineSpan } from './timelineSpan';
import { useTimelineViewStore } from './timelineViewStore';
import { NLA_HEADER_WIDTH_PX, NLA_ROW_HEIGHT_PX, spanToPercent } from './nlaLaneGeometry';

/** Every generated run in the graph, one row each. Renders nothing when there is none. */
export function NlaGeneratedRuns() {
  const state = useDagStore((s) => s.state);
  // A shared cache: answering "stale" evaluates each generator's path, and this re-derives on
  // every graph change (a drag is many) — uncached it re-walks every curve each time.
  const runs = useMemo(() => generatedRuns(state, uiEvaluatorCache), [state]);
  if (runs.length === 0) return null;
  return (
    <div data-testid="nla-generated-runs">
      {runs.map((run) => (
        <GeneratedRunRow key={run.clipId} run={run} />
      ))}
    </div>
  );
}

function GeneratedRunRow({ run }: { run: GeneratedRun }) {
  const { span: duration } = useTimelineSpan();
  const view = useTimelineViewStore((s) => s.view);
  const totalFrames = Math.max(1, Math.round(duration * FRAMES_PER_SECOND));
  const { leftPct, widthPct } = spanToPercent(
    0,
    run.duration,
    FRAMES_PER_SECOND,
    totalFrames,
    view,
  );
  const [busy, setBusy] = useState<null | 'recook' | 'seed'>(null);
  // Read at render: a driver bound to the seed takes New seed away, as it makes the field read-only.
  const driven = useDagStore((s) => seedIsDriven(run.producerId, s.state.nodes));

  async function press(kind: 'recook' | 'seed') {
    setBusy(kind);
    try {
      if (kind === 'recook') await recookMotion(run.producerId);
      else await recookWithNewSeed(run.producerId);
    } finally {
      // Always cleared: the cook never throws, and a strip stuck on "Generating…" would be a
      // second failure on top of the first.
      setBusy(null);
    }
  }

  const canRecook = run.stale || !run.baked || run.status === 'failed';
  const status = run.stale
    ? staleRunLabel(run.staleBecause!)
    : !run.baked
      ? run.status === 'failed'
        ? 'generation failed'
        : 'not generated yet'
      : 'up to date';

  return (
    <div
      data-testid={`nla-gen-row-${run.clipId}`}
      className="flex w-full border-b border-border"
      style={{ height: NLA_ROW_HEIGHT_PX }}
    >
      {/* The header carries the words: a two-second run is a narrow strip, and its buttons come
          first there, so the status must not depend on the strip being wide enough to show it. */}
      <div
        className="flex shrink-0 items-center gap-1.5 border-r border-border bg-bg-2 px-1.5 text-[11px]"
        style={{ width: NLA_HEADER_WIDTH_PX }}
        title={`${run.name} — generated`}
      >
        <span className="min-w-0 truncate text-fg/70">{run.name}</span>
        <span
          data-testid={`nla-gen-status-${run.clipId}`}
          className={`ml-auto shrink-0 text-[10px] ${run.stale ? 'text-warn' : 'text-fg/40'}`}
        >
          {status}
        </span>
      </div>
      <div className="relative min-w-0 flex-1">
        <div
          data-testid={`nla-gen-strip-${run.clipId}`}
          data-producer={run.producerId}
          data-stale={run.stale}
          data-stale-because={run.staleBecause ?? undefined}
          title={
            run.stale
              ? 'The old run plays until it re-cooks, so nothing jumps while you edit. Re-cook keeps the prompt and seed and follows the new path.'
              : `${run.name} — generated`
          }
          className={`absolute inset-y-0.5 flex min-w-0 items-center gap-1 overflow-hidden rounded px-1 text-[10px] ${
            run.stale
              ? 'border-2 border-warn bg-warn/15 text-fg'
              : 'border border-border bg-muted/60 text-fg/80'
          }`}
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        >
          <span className="flex shrink-0 gap-0.5">
            <button
              type="button"
              data-testid={`nla-gen-recook-${run.clipId}`}
              disabled={!canRecook || busy !== null}
              onClick={() => void press('recook')}
              className={`rounded px-1 font-semibold disabled:opacity-40 ${
                run.stale ? 'bg-warn text-bg' : 'border border-border'
              }`}
            >
              {busy === 'recook' ? 'Generating…' : 'Re-cook'}
            </button>
            <button
              type="button"
              data-testid={`nla-gen-newseed-${run.clipId}`}
              disabled={driven || busy !== null}
              title={
                driven
                  ? 'The seed is driven — change it at its source'
                  : 'Pick a new seed and re-cook'
              }
              onClick={() => void press('seed')}
              className="rounded border border-border px-1 disabled:opacity-40"
            >
              {busy === 'seed' ? 'Generating…' : 'New seed'}
            </button>
          </span>
          <span className="min-w-0 truncate font-semibold">{run.name} · generated</span>
        </div>
      </div>
    </div>
  );
}
