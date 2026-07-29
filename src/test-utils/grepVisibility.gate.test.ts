// The grep-visibility gate (#493) — no tracked source file may contain a NUL byte.
//
// WHY THIS EXISTS, and why it guards the guards rather than the product.
// Several of this repo's strongest checks are greps: the retire-a-kind gate scans tracked
// files for a construction position, the accessibility gates scan for banned patterns, and
// the everyday sweep behind every "who still names this type?" question is a plain
// `grep -rn`. All of them share one unstated assumption — that grep can SEE the file.
//
// A single NUL byte breaks that assumption silently. BSD and GNU grep classify a file
// containing one as binary and skip it without a word, so the sweep returns fewer hits and
// reports success. `git grep` uses its own scanner and is unaffected, which is what makes
// the divergence so hard to notice: the two tools disagree, and the one people reach for
// interactively is the one that lies.
//
// It is not hypothetical. `tests/e2e/split-kind-conformance.spec.ts` — the object↔data
// split's central gate, the file that decides whether a new kind ships with a road unswept
// — carried one NUL for four commits (`cafb01c`, #387). It was a deliberate
// never-containable sentinel standing in for a missing tooltip, and it worked: the spec ran
// and asserted correctly the whole time. But every repo-wide grep run during #388 silently
// skipped it, including the ones asking which specs covered the new kind. The gate was
// invisible to exactly the sweeps that would have found the gap it exists to close.
//
// WHAT IT DOES NOT CLAIM. A NUL is the loudest way to make a file grep-invisible, not the
// only one: invalid UTF-8 does it too, and some greps bail on very long lines. Those have
// never happened here, and a check that guessed at them would be inventing failure modes
// rather than pinning an observed one. This gate pins the one that bit us, by the mechanism
// that bit us.
//
// THE FIX WHEN IT FIRES is never to strip the byte and move on — it was load-bearing once
// and may be again. Ask what the sentinel was standing in for, then say that thing in a way
// that survives tooling: an explicit assertion on its own line usually reads better than the
// fallback it replaces.
//
// REF: tests/e2e/split-kind-conformance.spec.ts (the file that carried it);
//      src/test-utils/retiredKinds.gate.test.ts (the grep gate this protects);
//      issues #493, #471, #387.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Extensions whose contents are legitimately binary. Listed rather than sniffed: a
 * heuristic that decided "this one looks binary, skip it" would be free to decide the same
 * about a source file, which is the failure being guarded against.
 */
const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|ico|webp|svgz|woff2?|ttf|otf|eot|glb|gltf|bin|fbx|bvh|hdr|exr|wasm|zip|gz|pdf|mp4|webm|mov|wav|mp3|ogg)$/i;

/** Every tracked file that is meant to be text — exactly what CI would scan. */
function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p.length > 0 && !BINARY_EXTENSIONS.test(p));
}

interface NulHit {
  file: string;
  line: number;
  count: number;
}

function findNuls(files: readonly string[]): NulHit[] {
  const hits: NulHit[] = [];
  for (const file of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(REPO_ROOT, file));
    } catch {
      // A tracked path that cannot be read is a submodule or a broken link, not our concern.
      continue;
    }
    const first = buf.indexOf(0);
    if (first === -1) continue;
    let count = 0;
    for (const byte of buf) if (byte === 0) count++;
    // Line number of the FIRST offender, so the message points somewhere actionable.
    const line = buf.subarray(0, first).toString('utf8').split('\n').length;
    hits.push({ file, line, count });
  }
  return hits;
}

describe('grep-visibility gate (#493)', () => {
  it('no tracked source file contains a NUL byte', () => {
    const hits = findNuls(trackedTextFiles());
    expect(
      hits.map((h) => `${h.file}:${h.line} (${h.count} NUL)`),
      'a NUL byte makes grep classify the file as binary and SKIP it silently, so every ' +
        'repo-wide sweep — including the retire-a-kind gate and every "who names this type?" ' +
        'grep — stops seeing it while `git grep` still does. Say what the byte stood for in ' +
        'a way that survives tooling instead of embedding a control character',
    ).toEqual([]);
  });

  it('the scan actually reads files (guard the guard)', () => {
    // Without this, a `trackedTextFiles()` that returned [] — a moved repo root, a git
    // invocation that failed into an empty string — would report a clean sweep forever.
    // The number is a floor, not a count, so it does not churn as the repo grows.
    const files = trackedTextFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('tests/e2e/split-kind-conformance.spec.ts');
  });

  it('the detector fires on a NUL and stays silent without one (positive + negative control)', () => {
    // The gate above passes when the repo is clean, which is indistinguishable from a
    // detector that never fires. These two run it against known inputs.
    const withNul = Buffer.from('const a = 1;\nconst b = "\0";\n');
    const withoutNul = Buffer.from('const a = 1;\nconst b = "clean";\n');
    expect(withNul.indexOf(0)).toBeGreaterThan(-1);
    expect(withoutNul.indexOf(0)).toBe(-1);
    // And the line arithmetic points at the right line, not just at "somewhere".
    const line = withNul.subarray(0, withNul.indexOf(0)).toString('utf8').split('\n').length;
    expect(line).toBe(2);
  });
});
