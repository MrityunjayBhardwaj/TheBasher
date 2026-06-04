// Phase 151 (Apply-Transform) Wave 5 — SC-9 grep gate (issue #151, D-03).
//
// THE INVARIANT (CONTEXT D-03): Apply-Transform has NO keyboard binding.
// `Cmd/Ctrl+A` MUST stay select-all. The risk (Risk R8): a future mode-dependent
// keybinding for Apply silently shadows or replaces select-all in some editor
// mode, and a director loses Ctrl+A select-all without any error.
//
// This is a SOURCE grep gate (mirrors `src/a11y/grepGates.test.ts` and
// `src/viewport/gltfLoaderConfig.test.ts`'s regression-guard greps) — it asserts,
// against the actual `KeyboardShortcuts.tsx` text:
//   1. Ctrl/Cmd+A STILL maps to `selectAll` (the binding wasn't removed/renamed).
//   2. NO Apply keybinding was added — `KeyboardShortcuts.tsx` does not reference
//      `dispatchApplyTransform` / `isTransformAnimated` (Apply is menu/NPanel-only).
//
// A unit test (not an e2e) is the robust shape here: proving the ABSENCE of a
// keybinding is a negative an e2e cannot exhaustively cover (it would have to try
// every key in every mode), whereas the source grep proves it structurally.
//
// REF: docs/UI-SPEC.md §1 D-UX-21 (the Apply affordance — menu/NPanel, no keybind),
//      .anvi/dharana.md (CONTEXT 151 D-03), PLAN.md Wave 5 Task 12 (SC-9).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const KEYBOARD_SHORTCUTS = join(__dirname, 'KeyboardShortcuts.tsx');

function readKeyboardShortcuts(): string {
  return readFileSync(KEYBOARD_SHORTCUTS, 'utf8');
}

describe('SC-9 — Apply-Transform has no keyboard binding; Ctrl+A stays select-all (D-03)', () => {
  it('Cmd/Ctrl+A still maps to selectAll', () => {
    const src = readKeyboardShortcuts();
    // The select-all branch: a `cmd` (meta|ctrl) + the 'a' key → selectAll(...).
    // Assert both the key guard and the selectAll call survive.
    const cmdAGuard = /cmd\s*&&\s*\(e\.key === 'a' \|\| e\.key === 'A'\)/;
    expect(src).toMatch(cmdAGuard);
    expect(src).toMatch(/selectAll\(/);
  });

  it('no Apply keybinding exists — KeyboardShortcuts never references the Apply helper', () => {
    const src = readKeyboardShortcuts();
    // Apply is dispatched ONLY from the Object menu + the NPanel transform card.
    // If either of these appears in the keyboard handler, an Apply keybinding was
    // added (the R8 regression) — fail closed.
    expect(src).not.toMatch(/dispatchApplyTransform/);
    expect(src).not.toMatch(/isTransformAnimated/);
  });
});
