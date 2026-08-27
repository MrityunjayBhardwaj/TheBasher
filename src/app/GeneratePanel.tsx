// GeneratePanel — the DIRECTOR's way into both generators, and the third leg of
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
//   - No error surface of its own. Both callees report to the asset error
//     banner already; a second one would mean a failure could be shown twice or
//     (worse) shown here and nowhere else when a caller forgets.
//   - No validation of its own. The disabled button is an AFFORDANCE; the
//     schemas in `core/motiongen` and `core/modelgen` are the ENFORCEMENT, and
//     they refuse a blank prompt whatever the UI allows. Duplicating the rule
//     here would create a second place for it to drift.
//   - No route into the generation core. Its only two imports from the app are
//     the surfaces the agent tools' human siblings already use — so there is no
//     third road for a UI-only bug to live on.
//
// V8: app-layer, no `src/viewport/` imports. No DAG mutation here — the callees
// dispatch (K6: one atomic batch each).
//
// REF: src/app/asset/generateMotion.ts, src/app/asset/generateModel.ts (the two
//      surfaces); src/app/LeftSidebar.tsx (the Assets tab that mounts it);
//      ref/architecture/ai-track.md phases A1 and A4.

import { useState, type ReactNode } from 'react';
import { generateMotionIntoScene } from './asset/generateMotion';
import { generateModelFromText } from './asset/generateModel';

/** What a director can ask for. One member per app-layer surface that exists —
 *  image-to-3D is deliberately absent, because its picker plumbing is separate
 *  work and an option with no road is exactly the lying label this track keeps
 *  finding. */
export type GenerationKind = 'motion' | 'model';

/** The kinds offered, in display order. Exported so the shell and its test read
 *  one list rather than two. */
export const GENERATION_KINDS: readonly { kind: GenerationKind; label: string }[] = [
  { kind: 'motion', label: 'Motion' },
  { kind: 'model', label: 'Model' },
];

/** Both surfaces return this shape; neither throws. */
export type GenerationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * May the submit fire?
 *
 * Extracted because the project has no React Testing Library (W2 acceptance
 * gate #15 forbids new external deps), so the shell's decisions are testable
 * only when they are functions rather than JSX.
 */
export function canSubmit(prompt: string, busy: boolean): boolean {
  return !busy && prompt.trim().length > 0;
}

/**
 * Route a prompt to the surface for its kind.
 *
 * The trim is here rather than at the callee because the UI is what introduced
 * the whitespace; the callee sees the value a scripted caller would have sent.
 */
export async function runGeneration(
  kind: GenerationKind,
  prompt: string,
): Promise<GenerationOutcome> {
  const text = prompt.trim();
  const result =
    kind === 'motion' ? await generateMotionIntoScene(text) : await generateModelFromText(text);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

const KIND_HINT: Record<GenerationKind, string> = {
  motion: 'a figure walks forward, then turns left',
  model: 'a worn leather armchair',
};

export function GeneratePanel(): ReactNode {
  const [kind, setKind] = useState<GenerationKind>('motion');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  function submit(): void {
    if (!canSubmit(prompt, busy)) return;
    setBusy(true);
    // The promise never rejects — both surfaces catch and report to the banner —
    // so `finally` is the whole recovery: return to idle either way. The prompt
    // survives a failure on purpose, so a refused request can be edited rather
    // than retyped.
    void runGeneration(kind, prompt)
      .then((outcome) => {
        if (outcome.ok) setPrompt('');
      })
      .finally(() => setBusy(false));
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
        disabled={busy}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        placeholder={KIND_HINT[kind]}
        aria-label={`Describe the ${kind} to generate`}
        data-testid="generate-prompt"
        className="h-7 w-full rounded-md border border-border bg-bg px-2.5 text-[12px] text-fg placeholder:text-fg-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60"
      />
      <button
        type="button"
        data-testid="generate-submit"
        disabled={!canSubmit(prompt, busy)}
        onClick={submit}
        className="flex items-center justify-center gap-1 rounded-md border border-border bg-bg-1/40 px-2 py-1.5 text-[12px] font-medium text-fg/80 transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-fg/80"
      >
        <span aria-hidden>✦</span>
        <span>{busy ? 'Generating…' : 'Generate'}</span>
      </button>
    </section>
  );
}
