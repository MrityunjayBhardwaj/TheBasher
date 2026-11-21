// GeneratedView — the 2D View's "Generated" tab (#1718, design board 12b).
//
// Make a reference still from Basher's render of a shot's first frame plus a prompt, see four
// variants, keep one, and hand it to the shot as its first frame. A still is made by a ComfyUI
// workflow node whose file has a still output; the shot's video workflow is the workflow node
// whose frames start inside the shot (`shotVideoWorkflows`). "Use as first frame of Shot N" is one
// wire, and Regenerate on the shot runs the still first when it is stale, because the graph says
// the shot reads it. Every edit goes through `generatedStillActions` (the op road).
//
// What it reads: the graph (workflow nodes, shots off the camera cuts), and the Generated store
// (variants, picks). It holds the prompt being typed locally and commits it on blur and before
// a Generate, so a keystroke is not an undo step.
//
// V8: src/app/. Never dispatches itself; the actions do.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useDagStore } from '../core/dag/store';
import type { NodeId } from '../core/dag/types';
import { workflowMadeState, type WorkflowMadeState } from '../nodes/comfyWorkflowMade';
import { getStorage } from './boot';
import {
  firstFrameOps,
  shotVideoWorkflows,
  stillWorkflowOf,
  stillWorkflowsOf,
  type ShotWorkflow,
} from './generated/generatedStill';
import {
  generateStillVariants,
  keepStillVariant,
  regenerateShot,
  setStillPrompt,
  wireStillAsFirstFrame,
} from './generated/generatedStillActions';
import { nodeDisplayName } from './sceneTreeWalk';
import { sceneEndSeconds } from './sceneRange';
import { shotsOf } from './shots';
import { useGeneratedStillStore } from './stores/generatedStillStore';
import { uiEvaluatorCache } from './uiEvaluatorCache';

const STATE_WORDS: Record<WorkflowMadeState, string> = {
  unmade: 'not generated',
  current: 'generated',
  stale: 'stale',
  'cannot-run': 'cannot run',
};

function StateBadge({ state, testId }: { state: WorkflowMadeState; testId: string }) {
  const tone =
    state === 'current'
      ? 'border-accent text-accent'
      : state === 'stale'
        ? 'border-warn text-warn'
        : 'border-border text-fg-mute';
  return (
    <span
      data-testid={testId}
      data-state={state}
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${tone}`}
    >
      {STATE_WORDS[state]}
    </span>
  );
}

/** A picture in project storage, as an object URL (revoked when it changes). */
function useStoredImage(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    let live = true;
    let made: string | null = null;
    void getStorage()
      .then((storage) => storage.read(path))
      .then((bytes) => {
        if (!live) return;
        made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
        setUrl(made);
      })
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  return url;
}

function VariantTile({
  seed,
  path,
  index,
  picked,
  onPick,
}: {
  seed: number;
  path: string;
  index: number;
  picked: boolean;
  onPick: () => void;
}) {
  const url = useStoredImage(path);
  return (
    <button
      type="button"
      data-testid={`generated-variant-${seed}`}
      data-picked={picked || undefined}
      aria-pressed={picked}
      onClick={onPick}
      className={`flex flex-col gap-1 rounded border p-1.5 text-left transition-colors ${
        picked ? 'border-accent bg-accent/15' : 'border-border bg-bg/40 hover:border-accent'
      }`}
    >
      {url ? (
        <img
          src={url}
          alt={`Variant ${index + 1}`}
          className="aspect-video w-full rounded object-cover"
          style={{ imageRendering: 'pixelated' }}
        />
      ) : (
        <span className="aspect-video w-full rounded bg-muted/40" />
      )}
      <span className="text-[11px] text-fg/80">
        {index + 1} · seed <span className="font-mono">{seed}</span>
      </span>
    </button>
  );
}

const field =
  'rounded border border-border bg-bg px-1.5 py-0.5 text-[11px] text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';
const action =
  'rounded border border-border px-2 py-1 text-[11px] text-fg/80 transition-colors hover:border-accent hover:text-accent disabled:opacity-50 disabled:hover:border-border disabled:hover:text-fg/80';

export function GeneratedView(): ReactNode {
  const state = useDagStore((s) => s.state);
  const store = useGeneratedStillStore();
  const shots = useMemo(() => shotsOf(state, sceneEndSeconds(state)).shots, [state]);
  const stills = useMemo(() => stillWorkflowsOf(state), [state]);
  const shotIndex = Math.min(store.shotIndex, Math.max(0, shots.length - 1));
  const shot = shots[shotIndex] ?? null;
  const stillId =
    store.stillId && stills.some((w) => w.id === store.stillId)
      ? store.stillId
      : (stills[0]?.id ?? null);
  const still = stillId ? stillWorkflowOf(state, stillId) : null;
  const madeState = (id: NodeId) => workflowMadeState(state, id, uiEvaluatorCache);
  const nameOf = (id: NodeId) => nodeDisplayName(state.nodes, id);

  const savedPrompt = still?.promptInput ? String(still.promptInput.defaultValue ?? '') : '';
  const [prompt, setPrompt] = useState(savedPrompt);
  useEffect(() => setPrompt(savedPrompt), [savedPrompt, stillId]);
  const commitPrompt = () => {
    if (stillId && still?.promptInput && prompt !== savedPrompt) setStillPrompt(stillId, prompt);
  };

  const variants = store.variantsOf === stillId ? store.variants : [];
  const picked = variants.find((v) => v.seed === store.picked) ?? null;
  const busy =
    store.status === 'rendering' || store.status === 'generating' || store.status === 'running';

  const targets: ShotWorkflow[] = shot ? shotVideoWorkflows(state, shot) : [];
  const [targetId, setTargetId] = useState<NodeId | null>(null);
  const target = targets.find((t) => t.id === targetId) ?? targets[0] ?? null;
  const [inputChoice, setInputChoice] = useState<string | null>(null);
  const targetInput =
    target?.firstFrameInput ??
    (inputChoice && target?.stillInputs.includes(inputChoice) ? inputChoice : null);
  const shotLabel = shot ? `Shot ${shot.index + 1}` : 'the shot';
  // Wired so already: the action would add nothing, and the button says so instead.
  const alreadyFirstFrame =
    still !== null &&
    target !== null &&
    targetInput !== null &&
    firstFrameOps(state, still.id, { node: target.id, socket: targetInput }).length === 0;

  const firstFrameBlocker = !still
    ? 'Choose a still workflow first.'
    : madeState(still.id) === 'unmade'
      ? 'Keep a variant first.'
      : !target
        ? `${shotLabel} has no video workflow with a still input (a ComfyUI workflow whose frames start in the shot).`
        : !targetInput
          ? `Choose which still input of ${nameOf(target.id)} is its first frame.`
          : null;

  return (
    <div data-testid="generated-view" className="flex h-full w-full flex-col overflow-y-auto bg-bg">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-fg/70">
        <span>Generated</span>
        <label className="flex items-center gap-1 normal-case tracking-normal">
          <span className="text-fg-dim">Shot</span>
          <select
            data-testid="generated-shot-select"
            className={field}
            value={shotIndex}
            onChange={(e) => store.setShotIndex(Number(e.target.value))}
          >
            {shots.map((s) => (
              <option key={s.index} value={s.index}>
                {`Shot ${s.index + 1} · ${s.start.toFixed(2)} s`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 normal-case tracking-normal">
          <span className="text-fg-dim">Still workflow</span>
          <select
            data-testid="generated-still-select"
            className={field}
            value={stillId ?? ''}
            disabled={stills.length === 0}
            onChange={(e) => store.setStillId(e.target.value || null)}
          >
            {stills.length === 0 && <option value="">none in the graph</option>}
            {stills.map((w) => (
              <option key={w.id} value={w.id}>
                {nameOf(w.id)}
              </option>
            ))}
          </select>
        </label>
        {still && <StateBadge state={madeState(still.id)} testId="generated-still-state" />}
      </header>

      {!still ? (
        <p data-testid="generated-empty" className="p-4 text-[12px] text-fg-mute">
          No ComfyUI workflow in the graph makes a still. Add a ComfyUI workflow node and pick a
          workflow file with a still output (a Basher export of kind image) and a still input for
          the render.
        </p>
      ) : (
        <div className="flex flex-col gap-3 p-3">
          <section className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1 text-[11px] text-fg-dim">
              Prompt
              <textarea
                data-testid="generated-prompt"
                className={`${field} min-h-[48px] resize-y`}
                value={prompt}
                disabled={!still.promptInput}
                placeholder={still.promptInput ? '' : 'This workflow has no text input.'}
                onChange={(e) => setPrompt(e.target.value)}
                onBlur={commitPrompt}
              />
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="generated-generate"
                className={action}
                disabled={busy || !shot || !still.renderInput}
                title={
                  still.renderInput
                    ? `Render ${shotLabel}'s first frame and run ${nameOf(still.id)} on it`
                    : 'This workflow has no still input for the render.'
                }
                onClick={() => {
                  commitPrompt();
                  if (shot) void generateStillVariants(still.id, shot);
                }}
              >
                {still.seedInput ? 'Generate 4 variants' : 'Generate'}
              </button>
              <span
                data-testid="generated-status"
                data-status={store.status}
                className="text-[11px] text-fg-mute"
              >
                {store.status === 'rendering'
                  ? `Rendering ${shotLabel}'s first frame…`
                  : store.status === 'generating'
                    ? 'Generating…'
                    : store.status === 'running'
                      ? 'Regenerating…'
                      : (store.message ?? '')}
              </span>
            </div>
          </section>

          {variants.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <div className="grid grid-cols-2 gap-1.5" data-testid="generated-variants">
                {variants.map((v, i) => (
                  <VariantTile
                    key={v.seed}
                    seed={v.seed}
                    path={v.path}
                    index={i}
                    picked={v.seed === store.picked}
                    onPick={() => store.pick(v.seed)}
                  />
                ))}
              </div>
              <button
                type="button"
                data-testid="generated-keep"
                className={action}
                disabled={busy || !picked}
                onClick={() => picked && void keepStillVariant(still.id, picked)}
              >
                {picked ? `Keep variant · seed ${picked.seed}` : 'Pick a variant'}
              </button>
            </section>
          )}

          <section className="flex flex-col gap-1.5 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-dim">
              {targets.length > 1 && (
                <select
                  data-testid="generated-target-select"
                  className={field}
                  value={target?.id ?? ''}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {nameOf(t.id)}
                    </option>
                  ))}
                </select>
              )}
              {target && !target.firstFrameInput && (
                <select
                  data-testid="generated-input-select"
                  className={field}
                  value={inputChoice ?? ''}
                  onChange={(e) => setInputChoice(e.target.value || null)}
                >
                  <option value="">which input?</option>
                  {target.stillInputs.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                data-testid="generated-use-first-frame"
                className={action}
                data-wired={alreadyFirstFrame || undefined}
                disabled={busy || firstFrameBlocker !== null || alreadyFirstFrame}
                title={firstFrameBlocker ?? undefined}
                onClick={() =>
                  target &&
                  targetInput &&
                  wireStillAsFirstFrame(still.id, { node: target.id, socket: targetInput })
                }
              >
                {alreadyFirstFrame
                  ? `First frame of ${shotLabel}`
                  : `Use as first frame of ${shotLabel}`}
              </button>
            </div>
            {firstFrameBlocker && madeState(still.id) !== 'unmade' && (
              <p data-testid="generated-first-frame-blocker" className="text-[11px] text-fg-mute">
                {firstFrameBlocker}
              </p>
            )}
            {targets.map((t) => (
              <div
                key={t.id}
                data-testid={`generated-shot-workflow-${t.id}`}
                className="flex flex-wrap items-center gap-2 text-[11px] text-fg/80"
              >
                <span>
                  {shotLabel} · {nameOf(t.id)}
                </span>
                <StateBadge state={madeState(t.id)} testId={`generated-shot-state-${t.id}`} />
                <button
                  type="button"
                  data-testid={`generated-regenerate-${t.id}`}
                  className={action}
                  disabled={busy || madeState(t.id) === 'cannot-run'}
                  title="Run what this shot needs that is out of date, then the shot"
                  onClick={() => void regenerateShot(t.id)}
                >
                  {madeState(t.id) === 'unmade'
                    ? `Generate ${shotLabel}`
                    : `Regenerate ${shotLabel}`}
                </button>
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
