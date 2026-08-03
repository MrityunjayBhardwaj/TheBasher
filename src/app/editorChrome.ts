// editorChrome — the ONE answer to "is this object editor chrome, or is it DAG content?"
//
// ── WHAT CHROME IS ─────────────────────────────────────────────────────────────────────
//
// The grid, light and camera helpers, the editor fill rig, the ground-click plane, the
// agent-diff ghost, the curve line, the null glyph — everything the editor draws so a
// director can work, and nothing a render should contain. Chrome components declare
// themselves with `userData.editorChrome` (V37); this module only READS that declaration.
//
// ── WHY IT HAS TWO CLAUSES, AND WHY THE SECOND IS A WORKAROUND ─────────────────────────
//
// Clause 2 exists because drei injects `TransformControls` straight into the scene rather
// than through our component tree, so the gizmo cannot carry our flag and has to be caught
// by its three.js type instead. That is the clause most likely to move under us — a drei
// upgrade that renames the type, a second raw-injected library, or a decision to tag the
// gizmo properly (which would delete this clause outright). Whether the gizmo SHOULD carry
// the flag is a separate question and is deliberately not assumed here (#546's scope).
//
// ── WHY THIS IS A MODULE AND NOT A PRIVATE HELPER ──────────────────────────────────────
//
// It was a private helper three times over: `sceneBounds` (framing), the `renderToImage`
// hide-pass, and the locality e2e — the last of which could not import the answer, wrote
// it again, and got it half wrong on the first pass by matching the gizmo clause and not
// the flag. Each copy that drifts fails silently and differently: a framing bug here, a
// render-content bug there, a flaky test in the third. `src/app/` is the home rather than
// `src/viewport/` because `src/render/` already imports from `src/app/` and never from
// `src/viewport/` — putting it in viewport would invert a dependency direction to save a
// file. Held at one definition by `editorChrome.gate.test.ts`.
//
// ── WHAT THIS DOES NOT DECIDE: TRAVERSAL ───────────────────────────────────────────────
//
// The predicate answers "is THIS object chrome". What that means for an object's children
// is the caller's question, and the three callers legitimately differ: `sceneBounds` PRUNES
// the subtree (a helper's child must never inflate the bounds), the render hide-pass sets
// `visible = false` per object and lets three.js's own inheritance carry it down, and the
// e2e walks ANCESTRY because it reads leaf meshes and needs to know whether one sits under
// chrome. Folding traversal in here would force one of those three to be wrong.
//
// REF: vyapti V37 (the flag, and the SceneEnvironment inverse — one component must NEVER
//      be marked chrome); src/viewport/sceneBounds.ts + src/render/renderToImage.ts (the
//      two production consumers); tests/e2e/p535-render-locality.spec.ts (the third, which
//      imports this at runtime through the dev server); issues #546, #186, #535.

import type { Object3D } from 'three';

/**
 * True when `o` is editor chrome rather than DAG content.
 *
 * Per-object and ancestry-free by design — see the header. Structurally typed on purpose
 * (`userData` + `type`) so the e2e can hand it a plain scene object read across the
 * Playwright boundary without a three.js instance check standing in the way.
 */
export function isEditorChrome(o: Pick<Object3D, 'userData' | 'type'>): boolean {
  return o.userData?.editorChrome === true || (o.type ?? '').startsWith('TransformControls');
}
