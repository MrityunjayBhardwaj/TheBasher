// #958 — EVERY FILE A `REF:` COMMENT CITES MUST EXIST.
//
// A `REF:` is a citation: it is how a reader gets from a claim in one file to the code
// that grounds it, and this repo leans on that heavily. It is also a bare string. No
// import resolves it, no type mentions it, and until this gate nothing checked it — so
// a rename or a deletion left every `REF:` naming the old path pointing at nothing,
// reading exactly like one that points at something.
//
// ── WHAT WAS MEASURED BEFORE THIS WAS WRITTEN ────────────────────────────────────────
//
//   455 distinct `src/…` paths are named somewhere in src/ and tests/. ELEVEN were not
//   on disk. SEVEN of those eleven sat on a `REF:` line — the camera, light, baked and
//   curve fused nodes retired by the Object↔data split, plus a `passRole` that moved
//   from `src/nodes/passes/` to `src/core/dag/`.
//
// ⚠️ SCOPED TO `REF:` LINES ON PURPOSE, and the four paths that shape excludes are the
// argument for it. `ContextMenu.tsx`, `LayerRowControls.tsx` and `Dopesheet.tsx` are
// named in ordinary prose about history, and `src/app/someNewReader.ts` is an
// illustrative placeholder — a hypothetical, not a citation. `ContextMenu.tsx` is the
// sharpest case: a contrast row asserts it does NOT exist, and would red the day it
// did. A gate over every path-shaped string would red on all four and be turned off
// within a week. A citation is a promise that the file is there; prose is not.
//
// 🔑 AND THE COUNT ABOVE IS THE GATE'S OWN FIRST LESSON. A shell sweep that matched
// `REF:` on ONE line found seven. This gate follows the indented continuation lines
// and found THIRTEEN — including three e2e specs citing `src/app/AssetsPopover.tsx`,
// which an earlier draft of this very comment listed as prose. The block, not the
// line, is the unit of a citation.
//
// REF: src/app/importCycles.gate.test.ts (the repo-walk idiom this borrows);
//      src/nodes/CameraData.ts (one of the seven, repointed); issue #958.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.(tsx?|mjs)$/.test(entry)) continue;
    // Untracked agent scratch is not the repo's problem, and a stale REF in a
    // throwaway probe would red this for everyone.
    if (/^tmp-/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * The `src/…` paths cited by `REF:` blocks in one file.
 *
 * A block is the `//` line carrying `REF:` plus the indented `//` continuation lines
 * under it — the house style (`//      more/paths.ts;`). Stopping at the first
 * unindented comment line is what keeps the next paragraph's prose out of the census.
 */
function citedPaths(source: string): string[] {
  const lines = source.split('\n');
  const cited: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(\/\/|\*)?\s*REF:/.test(lines[i])) continue;
    let block = lines[i];
    for (let j = i + 1; j < lines.length; j++) {
      if (!/^\s*(\/\/|\*)\s{2,}\S/.test(lines[j])) break;
      block += '\n' + lines[j];
    }
    cited.push(...(block.match(/\bsrc\/[A-Za-z0-9_/.-]+\.(?:tsx?|mjs)\b/g) ?? []));
  }
  return cited;
}

describe('#958 — a REF: citation resolves', () => {
  it('every src/ path a REF: block cites exists on disk', () => {
    const dangling: string[] = [];
    let citations = 0;
    for (const file of [
      ...sourceFiles(path.join(ROOT, 'src')),
      ...sourceFiles(path.join(ROOT, 'tests')),
    ]) {
      for (const cited of citedPaths(readFileSync(file, 'utf8'))) {
        citations++;
        try {
          statSync(path.join(ROOT, cited));
        } catch {
          dangling.push(`${path.relative(ROOT, file)} cites ${cited}`);
        }
      }
    }

    // 🔑 THE POPULATION BESIDE THE VERDICT. An empty `dangling` is the same green
    // whether every citation resolved or the block parser matched nothing at all —
    // which is precisely how a gate stops being a measurement. This repo has been
    // bitten by a zero with no denominator often enough to state it here.
    expect(citations, 'no REF: citations found — the block parser matched nothing').toBeGreaterThan(
      20,
    );
    expect(
      dangling,
      `REF: citations pointing at files that do not exist:\n${dangling.join('\n')}`,
    ).toEqual([]);
  });
});
