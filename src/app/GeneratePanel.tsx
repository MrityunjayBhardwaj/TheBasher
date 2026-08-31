// GeneratePanel — the DIRECTOR's way into the generators, and the third leg of
// UI == agent == render for phases A1 and A4.
//
// Before this, `generateMotionIntoScene` and `generateModelIntoScene` were
// written, tested, wired to settings and to the licence gate, and reachable
// only from their own test files. The agent could generate (`motion.generate`,
// `model.generate`); a person could not. The claim "a generated asset is
// indistinguishable from an imported one" needs someone able to ask for one.
//
// 🔑 IT LIVES BESIDE `Import…`, AND THE PLACEMENT IS THE CLAIM. The Assets tab
// already carries the file road; this is the prompt road. Import takes a
// filename and Generate takes a sentence, and both end in the same library, the
// same OPFS folder and the same Ops. A separate "AI" panel would have said the
// opposite — that generated assets are a different kind of thing — which is the
// one statement this whole track exists to falsify.
//
// What it deliberately does NOT do:
//   - No error surface of its own. All three callees report to the asset error
//     banner already; a second one would mean a failure could be shown twice or
//     (worse) shown here and nowhere else when a caller forgets.
//   - No validation of its own. The disabled button is an AFFORDANCE; the
//     schemas in `core/motiongen`, `core/modelgen` and `core/rigging` are the
//     ENFORCEMENT, and they refuse a bad request whatever the UI allows.
//     Duplicating the rule here would create a second place for it to drift.
//   - No route into the generation core. Its only imports from the app are the
//     surfaces the agent tools' human siblings already use — so there is no
//     third road for a UI-only bug to live on.
//
// 🔴 THE IMAGE ROAD IS UI-ONLY TODAY. `model.generate`'s schema takes a prompt
// and nothing else, so a reference image is reachable by a person and not by the
// agent. That is a real parity gap, filed rather than hidden — the agent's road
// wants an OPFS path (the pattern `comfyImageBinding` already uses), not the raw
// bytes a file picker yields, so it is its own design rather than a wider zod
// schema.
//
// V8: app-layer, no `src/viewport/` imports. No DAG mutation here — the callees
// dispatch (K6: one atomic batch each).
//
// REF: src/app/asset/generateMotion.ts, src/app/asset/generateModel.ts,
//      src/app/asset/generateRiggedCharacter.ts (the three surfaces);
//      src/app/LeftSidebar.tsx (the Assets tab that mounts it);
//      ref/architecture/ai-track.md phases A1 and A4.

import { useRef, useState, type ReactNode } from 'react';
import { saveGeneratedMotionToLibrary, savedMotionName } from './asset/saveGeneratedMotion';
import {
  useGeneratedMotionStore,
  type PendingGeneratedMotion,
} from './stores/generatedMotionStore';
import { generateMotionIntoScene } from './asset/generateMotion';
import { generateModelIntoScene } from './asset/generateModel';
import { generateRiggedCharacter } from './asset/generateRiggedCharacter';
import type { SourceImage } from '../core/modelgen';

/** What a director can ask for. One member per app-layer surface that exists —
 *  nothing is offered that has no road, because an option with no road is the
 *  lying label this track keeps finding. */
export type GenerationKind = 'motion' | 'model' | 'character';

/** The kinds offered, in display order. Exported so the shell and its test read
 *  one list rather than two. */
export const GENERATION_KINDS: readonly { kind: GenerationKind; label: string }[] = [
  { kind: 'motion', label: 'Motion' },
  { kind: 'model', label: 'Model' },
  { kind: 'character', label: 'Character' },
];

/** Both surfaces return this shape; neither throws. */
export type GenerationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * How far along, and at WHAT.
 *
 * The label is carried rather than derived from a percentage because the rigged
 * road runs two billable tasks in sequence, each reporting its own 0–100. One
 * unlabelled bar would fill, snap to zero and fill again, which reads as a
 * restart rather than as progress.
 */
export interface GenerationProgressView {
  readonly label: string;
  readonly percent: number;
}

/** Which kinds can take a reference image instead of a prompt. Motion cannot —
 *  `motiongen` has no image road at all, so offering the slot there would be an
 *  affordance for something that does not exist. */
export function acceptsImage(kind: GenerationKind): boolean {
  return kind === 'model' || kind === 'character';
}

/**
 * May the submit fire?
 *
 * 🔑 AN IMAGE SATISFIES IT ON ITS OWN. `ImageModelRequest` carries no prompt —
 * the image REPLACES the text rather than refining it — so requiring both would
 * demand a sentence the request cannot even send.
 *
 * Extracted because the project has no React Testing Library (W2 acceptance
 * gate #15 forbids new external deps), so the shell's decisions are testable
 * only when they are functions rather than JSX.
 */
export function canSubmit(
  prompt: string,
  busy: boolean,
  kind: GenerationKind = 'motion',
  hasImage = false,
): boolean {
  if (busy) return false;
  if (hasImage && acceptsImage(kind)) return true;
  return prompt.trim().length > 0;
}

/** Human phase names, so the bar says which of the two tasks is running. */
const PHASE_LABEL: Record<string, string> = {
  generating: 'Generating mesh',
  checking: 'Checking it can be rigged',
  rigging: 'Building skeleton',
  importing: 'Importing',
};

/**
 * Route a request to the surface for its kind.
 *
 * The trim is here rather than at the callee because the UI is what introduced
 * the whitespace; the callee sees the value a scripted caller would have sent.
 */
export async function runGeneration(
  kind: GenerationKind,
  prompt: string,
  image?: SourceImage,
  onProgress?: (p: GenerationProgressView) => void,
): Promise<GenerationOutcome> {
  const text = prompt.trim();

  if (kind === 'motion') {
    const result = await generateMotionIntoScene(text);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  // The union the two mesh roads share. An image replaces the prompt outright;
  // it is not a hint alongside it, and the request type says so.
  const request = image
    ? ({ source: 'image', image } as const)
    : ({ source: 'text', prompt: text } as const);

  if (kind === 'character') {
    const result = await generateRiggedCharacter(request, {
      name: text || undefined,
      onProgress: (p) =>
        onProgress?.({ label: PHASE_LABEL[p.phase] ?? p.phase, percent: p.percent }),
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  const result = await generateModelIntoScene(request, {
    name: text || undefined,
    onProgress: (p) => onProgress?.({ label: p.status, percent: p.progress }),
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/**
 * What the panel should show about the last generated clip (#819).
 *
 * A generated clip is in the scene and nowhere else — no bytes, no library row,
 * gone on reload. So there are three states and they are genuinely different:
 * nothing generated yet, one clip on offer, and one clip kept. Extracted as a
 * function because this project has no React Testing Library (W2 gate #15), so
 * the panel's decisions are testable only when they are not JSX.
 *
 * 🔑 THE OFFER IS NOT GATED ON THE SELECTED KIND. What is on offer is the last
 * MOTION that was generated, which does not stop existing because the director
 * clicked "Model" to look at something else — hiding it there would make keeping
 * a clip depend on a control that has nothing to do with it.
 */
export type MotionSaveOffer =
  | { readonly kind: 'none' }
  | { readonly kind: 'offer'; readonly name: string }
  | { readonly kind: 'saved'; readonly name: string };

export function motionSaveOffer(
  pending: PendingGeneratedMotion | null,
  savedPath: string | null,
): MotionSaveOffer {
  if (pending) return { kind: 'offer', name: savedMotionName(pending.name) };
  if (savedPath) {
    // The folder is the name a director will look for in My Imports; the file
    // inside it repeats the name and says nothing extra.
    const parts = savedPath.split('/').filter(Boolean);
    return { kind: 'saved', name: parts[parts.length - 2] ?? savedPath };
  }
  return { kind: 'none' };
}

const KIND_HINT: Record<GenerationKind, string> = {
  motion: 'a figure walks forward, then turns left',
  model: 'a worn leather armchair',
  character: 'a stocky dwarf blacksmith, arms at their sides',
};

export function GeneratePanel(): ReactNode {
  const [kind, setKind] = useState<GenerationKind>('motion');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<{ file: SourceImage; name: string } | null>(null);
  const [progress, setProgress] = useState<GenerationProgressView | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingMotion = useGeneratedMotionStore((s) => s.pending);
  const savedPath = useGeneratedMotionStore((s) => s.savedPath);
  const offer = motionSaveOffer(pendingMotion, savedPath);

  const imageOffered = acceptsImage(kind);
  // An image attached under Model, then switched to Motion, must not silently
  // ride along into a request that cannot carry it.
  const activeImage = imageOffered ? image : null;

  async function onPickFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    setImage({ file: { bytes, mimeType: file.type || 'image/png' }, name: file.name });
  }

  function submit(): void {
    if (!canSubmit(prompt, busy, kind, activeImage !== null)) return;
    setBusy(true);
    setProgress(null);
    // The promise never rejects — every surface catches and reports to the
    // banner — so `finally` is the whole recovery: return to idle either way.
    // The prompt survives a failure on purpose, so a refused request can be
    // edited rather than retyped.
    void runGeneration(kind, prompt, activeImage?.file, setProgress)
      .then((outcome) => {
        if (outcome.ok) {
          setPrompt('');
          setImage(null);
        }
      })
      .finally(() => {
        setBusy(false);
        setProgress(null);
      });
  }

  return (
    <section
      data-testid="generate-panel"
      className="mb-2 flex flex-col gap-1.5 rounded-md border border-border bg-bg-1/40 px-2 py-2"
    >
      <div className="flex items-center gap-1" role="group" aria-label="What to generate">
        {GENERATION_KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            data-testid={`generate-kind-${k.kind}`}
            data-active={kind === k.kind || undefined}
            aria-pressed={kind === k.kind}
            onClick={() => setKind(k.kind)}
            className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
              kind === k.kind
                ? 'border-accent text-accent'
                : 'border-border text-fg-dim hover:border-border-strong hover:text-fg/80'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      <input
        type="text"
        value={prompt}
        disabled={busy || activeImage !== null}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        placeholder={activeImage ? 'the reference image is the subject' : KIND_HINT[kind]}
        aria-label={`Describe the ${kind} to generate`}
        data-testid="generate-prompt"
        className="h-7 w-full rounded-md border border-border bg-bg px-2.5 text-[12px] text-fg placeholder:text-fg-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60"
      />

      {imageOffered && (
        <div className="flex items-center gap-1.5" data-testid="generate-image-slot">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            data-testid="generate-image-input"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onPickFile(file);
            }}
          />
          <button
            type="button"
            disabled={busy}
            data-testid="generate-image-pick"
            onClick={() => fileInput.current?.click()}
            className="rounded border border-border px-2 py-0.5 text-[11px] text-fg-dim transition-colors hover:border-border-strong hover:text-fg/80 disabled:opacity-50"
          >
            {activeImage ? 'Change image' : 'Reference image…'}
          </button>
          {activeImage && (
            <>
              <span
                data-testid="generate-image-name"
                className="truncate text-[11px] text-fg/70"
                title={activeImage.name}
              >
                {activeImage.name}
              </span>
              <button
                type="button"
                disabled={busy}
                data-testid="generate-image-clear"
                onClick={() => setImage(null)}
                aria-label="Remove the reference image"
                className="rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-dim transition-colors hover:border-border-strong hover:text-fg/80 disabled:opacity-50"
              >
                ✕
              </button>
            </>
          )}
        </div>
      )}

      <button
        type="button"
        data-testid="generate-submit"
        disabled={!canSubmit(prompt, busy, kind, activeImage !== null)}
        onClick={submit}
        className="flex items-center justify-center gap-1 rounded-md border border-border bg-bg-1/40 px-2 py-1.5 text-[12px] font-medium text-fg/80 transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-fg/80"
      >
        <span aria-hidden>✦</span>
        <span>{busy ? 'Generating…' : 'Generate'}</span>
      </button>

      {offer.kind !== 'none' && (
        // The clip is in the scene either way. This row is only about whether a
        // copy is KEPT — so it says what would be saved before the gesture, not
        // after, and it never implies the motion itself is at risk.
        <div
          data-testid="generate-save-row"
          className="flex items-center justify-between gap-1.5 rounded border border-border bg-bg/40 px-2 py-1"
        >
          <span
            data-testid="generate-save-name"
            className="truncate text-[11px] text-fg/70"
            title={offer.name}
          >
            {offer.kind === 'saved' ? `Saved · ${offer.name}` : offer.name}
          </span>
          {offer.kind === 'offer' && (
            <button
              type="button"
              disabled={saving}
              data-testid="generate-save-to-library"
              onClick={() => {
                setSaving(true);
                // Never rejects — the banner carries any failure — so `finally`
                // is the whole recovery.
                void saveGeneratedMotionToLibrary().finally(() => setSaving(false));
              }}
              className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-fg-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save to library'}
            </button>
          )}
        </div>
      )}

      {busy && (
        // Only while busy, and only once the service has actually said
        // something. A bar drawn before the first report would show 0% for the
        // whole queue wait, which reads as stuck rather than as queued.
        <div data-testid="generate-progress" className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[11px] text-fg-dim">
            <span data-testid="generate-progress-label">{progress?.label ?? 'Starting…'}</span>
            {progress && <span data-testid="generate-progress-percent">{progress.percent}%</span>}
          </div>
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-bg"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress?.percent}
            aria-label="Generation progress"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              // No report yet is not 0% of the work — it is an unknown amount,
              // so the bar shows a small fixed sliver rather than claiming zero.
              style={{ width: `${progress ? progress.percent : 4}%` }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
