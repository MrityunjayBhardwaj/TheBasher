// Focus-ring gate — enforces D-W8-2 (P6 W8 C3.4).
//
// Rule: no production .tsx file under src/app, src/timeline, or
// src/viewport may carry a BARE legacy-focus outline-suppression class
// (the `focus[colon]outline-none` form, no `focus-visible[colon]`)
// without a paired ring class on the same element. The bare form
// removes the browser's default focus indicator without replacement —
// regressive for §8.1/§8.2 keyboard reachability.
//
// Note: class names below are described with `[colon]` placeholders in
// comments so this file's content doesn't appear to Tailwind's content
// scanner as a stream of arbitrary `pseudo:utility` tokens (which can
// destabilize PostCSS extraction). The runtime regexes still match the
// literal class strings via constructed-from-parts patterns.
//
// What this catches:
//   - The R8 L236 anti-pattern (FloatingViewportToolbar — fixed in C3)
//   - Future regressions where someone adds the bare legacy form
//     because "the outline is ugly" but doesn't add a replacement ring.
//
// What this does NOT cover (acknowledged limits):
//   - Per-element presence of a ring (would require AST walking every
//     <button>/<input>/<select>; high false-positive cost for low
//     marginal a11y value — the C5 e2e Tab-walk catches missed
//     elements end-to-end). The rule here is the necessary precondition
//     (no regressive bare outline suppression); the sufficient
//     condition is verified live by the C5 keyboard-only test.
//
// REF: D-W8-2 (locked focus-ring treatment);
//      memory/project_p6_w8_plan.md C3.4;
//      .anvi/hetvabhasa.md H30 (the screenshot-baseline trap C3 mitigates).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SCAN_DIRS = ['app', 'timeline', 'viewport'];

// Build the regex from parts so the literal pseudo:class fragments
// don't appear in this file's source as standalone string tokens.
const PSEUDO_FOCUS = 'focus' + ':';
const PSEUDO_FOCUS_VISIBLE = 'focus-visible' + ':';
const BARE_OUTLINE_RE = new RegExp(`(?<!-visible)\\b${PSEUDO_FOCUS}outline-none\\b`);
const FOCUS_VISIBLE_OUTLINE_RE = new RegExp(`${PSEUDO_FOCUS_VISIBLE}outline-none`);
const FOCUS_VISIBLE_RING_RE = new RegExp(`${PSEUDO_FOCUS_VISIBLE}ring`);
const OPT_OUT_RE = /data-no-focus-ring/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, acc);
    } else if (entry.endsWith('.tsx')) {
      // Skip *.test.tsx — gate enforces production sources only.
      if (!entry.endsWith('.test.tsx')) acc.push(full);
    }
  }
  return acc;
}

function collectChromeFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    files.push(...walk(join(ROOT, dir)));
  }
  return files;
}

describe('a11y focus-ring gate (D-W8-2)', () => {
  it('no bare legacy-focus outline suppression survives in chrome .tsx files', () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of collectChromeFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        if (BARE_OUTLINE_RE.test(text)) {
          offenders.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
      throw new Error(
        `Found ${offenders.length} bare legacy-focus outline-suppression occurrence(s). ` +
          `Replace with the focus-visible ring pattern (D-W8-2). Offenders:\n${detail}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  it('every focus-visible outline suppression has a paired ring (no orphaned suppression)', () => {
    const orphans: { file: string; line: number; text: string }[] = [];
    for (const file of collectChromeFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        // Within a single line: if focus-visible outline suppression is
        // present, expect either a focus-visible ring class OR the
        // data-no-focus-ring opt-out attribute on the same element. The
        // check is line-scoped because Tailwind className strings are
        // typically a single contiguous string literal.
        if (
          FOCUS_VISIBLE_OUTLINE_RE.test(text) &&
          !FOCUS_VISIBLE_RING_RE.test(text) &&
          !OPT_OUT_RE.test(text)
        ) {
          orphans.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }
    if (orphans.length > 0) {
      const detail = orphans.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
      throw new Error(
        `Found ${orphans.length} focus-visible outline-suppression line(s) without a paired ring class. ` +
          `Add the ring utility on the same element, or annotate with data-no-focus-ring if focus ` +
          `styling is intentionally elsewhere. Offenders:\n${detail}`,
      );
    }
    expect(orphans).toHaveLength(0);
  });
});
