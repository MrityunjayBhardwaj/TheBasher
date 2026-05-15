// P6 W8 C5.4 — Vitest grep gates over production a11y invariants.
//
// Two gates land here:
//
//   1. V19 — gizmoStore.setMode is written by exactly one production
//      site (editorStore.ts:56, the propagation hook of
//      editorStore.setActiveTool). Any direct writer outside that line
//      reintroduces the W7 TransformToolbar asymmetry: a chrome surface
//      that updates gizmo state without going through the canonical
//      dispatcher, which then desynchronises with R4 / R8 / keyboard
//      Q/W/E/R. Grep gate detects regressions at commit time.
//
//   2. Bare-focus suppression — no production .tsx may carry
//      `focus[colon]outline-none` (the LEGACY form, without the
//      `focus-visible[colon]` prefix). Bare suppression removes the
//      browser's default focus indicator without replacement, regressive
//      for §8.1/§8.2 keyboard reachability. This is the same invariant
//      as focusRingGate.test.ts's first `it()` — duplicated here as a
//      single-line grep on the SAME files plus their sibling .ts
//      sources, which the AST-walking gate doesn't scan. The redundancy
//      is intentional: the AST gate sees React class strings, this gate
//      sees any source under src/.
//
// Why this file is .ts (not .test.tsx): the class-name string patterns
// are described using `[colon]` placeholders in comments, and the
// regexes are constructed from parts at runtime, so Tailwind's content
// scanner (which is excluded from test files via the content-glob
// `!./src/**/*.test.{ts,tsx}` in tailwind.config.ts) wouldn't be
// destabilised even if it did see them. The exclusion is the primary
// defence; this file's construction is belt-and-braces. (H31.)
//
// REF: docs/UI-SPEC.md §1 D-W8-2 (focus-ring), §8.1 (focus order);
//      .anvi/vyapti.md V19 (keyboard/UI shared dispatcher);
//      .anvi/hetvabhasa.md H31 (Tailwind content scanner trap);
//      memory/project_p6_w7_shipped.md (V19 W7 sister-case).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const SCAN_DIRS = ['app', 'timeline', 'viewport'];

const PSEUDO_FOCUS = 'focus' + ':';
const BARE_OUTLINE_RE = new RegExp(`(?<!-visible)\\b${PSEUDO_FOCUS}outline-none\\b`);

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, exts, acc);
    } else if (exts.some((e) => entry.endsWith(e))) {
      // Skip test sources — tailwind.config.ts excludes them too; they
      // legitimately contain pattern-match strings about the gated
      // classes.
      if (!/\.test\.(ts|tsx)$/.test(entry)) acc.push(full);
    }
  }
  return acc;
}

describe('a11y grep gates — P6 W8 C5.4', () => {
  it('V19: gizmoStore.setMode has exactly one production writer (editorStore.ts:56)', () => {
    const files: string[] = [];
    files.push(...walk(SRC, ['.ts', '.tsx']));

    const writers: { file: string; line: number; text: string }[] = [];
    // Two flavours of writer to catch:
    //   1. `useGizmoStore(...).setMode(` — hook-form direct dispatch
    //   2. `gizmoStore.setMode(` — imported-singleton direct dispatch
    //   3. `useGizmoStore.getState().setMode(` — imperative outside React
    const HOOK_RE = /useGizmoStore\([^)]*\)\.setMode\(/;
    const IMPORT_RE = /\bgizmoStore\.setMode\(/;
    const GETSTATE_RE = /useGizmoStore\.getState\(\)\.setMode\(/;

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        if (HOOK_RE.test(text) || IMPORT_RE.test(text) || GETSTATE_RE.test(text)) {
          writers.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }

    // The single allowed writer is editorStore.ts:56 (or wherever the
    // canonical propagation line lives). Assert exactly one match and
    // that it sits in editorStore.ts.
    if (writers.length !== 1) {
      const detail = writers
        .map((w) => `  ${relative(SRC, w.file)}:${w.line}  ${w.text}`)
        .join('\n');
      throw new Error(
        `V19: expected exactly 1 gizmoStore.setMode writer in production, found ${writers.length}. ` +
          `Any new writer must route through editorStore.setActiveTool. Hits:\n${detail}`,
      );
    }
    expect(writers[0].file).toMatch(/editorStore\.ts$/);
  });

  it('no bare legacy-focus outline suppression survives in chrome .tsx files (D-W8-2)', () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) {
      files.push(...walk(join(SRC, dir), ['.tsx']));
    }
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        if (BARE_OUTLINE_RE.test(text)) {
          offenders.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  ${relative(SRC, o.file)}:${o.line}  ${o.text}`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} bare legacy-focus outline-suppression occurrence(s) in chrome .tsx. ` +
          `Replace with the focus-visible ring pattern (D-W8-2). Offenders:\n${detail}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });
});
