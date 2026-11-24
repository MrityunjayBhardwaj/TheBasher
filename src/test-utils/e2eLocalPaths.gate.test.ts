// No committed e2e spec may name an absolute path on one developer's machine (#1965).
//
// WHY THIS EXISTS. Ten tests on PR #1964 saved their screenshots to a session scratchpad
// under `/private/tmp/claude-501/...`. The folder existed on the machine that wrote them,
// so they passed there, and failed on CI with ENOENT before asserting anything. A spec that
// writes a file must write it under Playwright's own output folder:
// `test.info().outputPath('<name>.png')` (or `testInfo.outputPath`), which exists on every
// machine and lands in the CI artifact.
//
// WHAT IT SCANS. Every top-level `.ts` file in `tests/e2e/` (specs and their `_helpers`),
// except `tmp-*` scratch specs, which are never committed. It reads the directory rather
// than `git ls-files` so a new, not-yet-staged spec is caught before it is committed.
//
// REF: issue #1965; tests/e2e/p1952-panels-start-as-rails.spec.ts (one of the ten).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const E2E_DIR = join(__dirname, '..', '..', 'tests', 'e2e');

/** Path fragments that only exist on a developer's machine. */
const LOCAL_PATH = /\/private\/tmp\/|\/Users\/|claude-501/;

function e2eSourceFiles(dir: string = E2E_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.startsWith('tmp-'))
    .sort();
}

function localPathHits(text: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  text.split('\n').forEach((l, i) => {
    if (LOCAL_PATH.test(l)) hits.push({ line: i + 1, text: l.trim() });
  });
  return hits;
}

describe('e2e specs name no absolute local path (#1965)', () => {
  it('the matcher fires on a planted path and stays quiet on outputPath', () => {
    expect(localPathHits("const SHOTS = '/private/tmp/claude-501/x/scratchpad';")).toHaveLength(1);
    expect(localPathHits("await page.screenshot({ path: '/Users/me/a.png' });")).toHaveLength(1);
    expect(
      localPathHits("await page.screenshot({ path: test.info().outputPath('a.png') });"),
    ).toEqual([]);
  });

  it('scans a non-empty set of spec files', () => {
    const files = e2eSourceFiles();
    expect(files.filter((f) => f.endsWith('.spec.ts')).length).toBeGreaterThan(100);
    expect(files.some((f) => f.startsWith('tmp-'))).toBe(false);
  });

  it('no committed e2e file names one', () => {
    const offenders = e2eSourceFiles().flatMap((f) =>
      localPathHits(readFileSync(join(E2E_DIR, f), 'utf8')).map(
        (h) => `tests/e2e/${f}:${h.line}  ${h.text}`,
      ),
    );
    expect(offenders, 'write files via test.info().outputPath(name) instead').toEqual([]);
  });
});
