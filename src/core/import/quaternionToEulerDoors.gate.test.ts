// #876 DOOR CENSUS — every quaternion→Euler conversion in `src/` is listed here
// with the reason it is safe, and a new one fails this test until someone says
// which kind it is.
//
// THE DISTINCTION THIS GATE ENFORCES.
// `Euler.setFromQuaternion` returns a CANONICAL representative — one of several
// triples denoting the same rotation, chosen with no reference to any other
// value. That is correct for a POINT-IN-TIME conversion, where the triple is
// consumed immediately and never interpolated. It is wrong for a SEQUENCE that
// a downstream sampler lerps component-wise: two adjacent samples either side
// of a branch cut land on different representatives, and the interpolant walks
// the long way round. Near the XYZ gimbal pole that reads as a full turn
// between keyframes a few degrees apart.
//
// That defect has now been fixed TWICE at two different producers (#867 in
// `clipToKeyframes`, #876 in `gltfImportChain`) because each road converts on
// its own. `continuousEuler` is a gate anyone can walk past by calling
// `setFromQuaternion` directly. Until building a rotation CHANNEL from
// quaternions is the only constructible road, this census is what stops the
// third occurrence: it cannot prevent a bad call, but it refuses to let one be
// added silently.
//
// TO ADD A ROW: state which kind the call site is.
//   POINT_IN_TIME — one value, consumed now, never interpolated against a
//                   neighbour. Canonical is correct; nothing to do.
//   SEQUENCE      — produces successive samples that something later
//                   interpolates. MUST go through `continuousEuler` (or be the
//                   primitive that one is built from).
// If you cannot say which, that is the finding — do not guess to make the test
// pass.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'src';

type Kind = 'POINT_IN_TIME' | 'SEQUENCE';

interface Door {
  readonly count: number;
  readonly kind: Kind;
  readonly why: string;
}

/**
 * The allowlist. Keyed by file, because line numbers move for reasons that have
 * nothing to do with this concern; the COUNT is what makes a newly-added call in
 * an already-listed file fail rather than hide.
 */
const DOORS: Record<string, Door> = {
  'src/core/import/threeAdapter.ts': {
    count: 1,
    kind: 'SEQUENCE',
    why:
      'THE PRIMITIVE. `quaternionToEulerVec3` is the raw canonical conversion, and ' +
      '`continuousEuler` in this same file is the continuity-preserving wrapper built ' +
      'on it. Producers of keyframe sequences must call the wrapper, not this.',
  },
  'src/viewport/SceneFromDAG.tsx': {
    count: 2,
    kind: 'POINT_IN_TIME',
    why:
      "Both are per-frame render reads: a look-at direction folded into one frame's " +
      'TRS, and a bone-rotation accessor that reports the CURRENT pose. Neither is ' +
      'stored as a keyframe, so nothing interpolates between two of them.',
  },
  'src/app/resolveTrackTo.ts': {
    count: 1,
    kind: 'POINT_IN_TIME',
    why: 'Constraint aim resolved fresh each frame from a lookAt matrix; the triple is returned and used immediately.',
  },
  'src/app/nodeConstraints.ts': {
    count: 1,
    kind: 'POINT_IN_TIME',
    why: 'Constraint aim, parent-relative, resolved per frame. Not a stored sequence.',
  },
  'src/app/Gizmo.tsx': {
    count: 2,
    kind: 'POINT_IN_TIME',
    why: 'Gizmo display of the current local transform, decomposed for the inspector. Read-only, one value.',
  },
};

/** Every .ts/.tsx under src/, excluding untracked scratch probes. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      sourceFiles(p, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (entry.startsWith('tmp-')) continue;
    out.push(p);
  }
  return out;
}

describe('#876 — the quaternion→Euler door census', () => {
  it('every conversion site in src/ is listed, and no listed file grew one', () => {
    const files = sourceFiles(SRC);
    // The denominator, asserted: a scan that walked nothing would otherwise
    // report "no unlisted doors" and look exactly like a scan that passed.
    expect(files.length).toBeGreaterThan(500);

    const found: Record<string, number> = {};
    for (const f of files) {
      // Tests are excluded deliberately: a test may construct a canonical
      // conversion precisely in order to demonstrate the defect, and #867's
      // continuity test does exactly that.
      if (/\.test\.tsx?$/.test(f)) continue;
      const text = readFileSync(f, 'utf8');
      // Count call sites, not mentions — prose about the method appears in the
      // comments of both files that own this concern.
      const n = (text.match(/\.setFromQuaternion\s*\(/g) ?? []).length;
      if (n > 0) found[f.split('\\').join('/')] = n;
    }

    const listed = Object.keys(DOORS).sort();
    const actual = Object.keys(found).sort();

    // A NEW file with a conversion — door eight.
    expect(
      actual.filter((f) => !listed.includes(f)),
      'UNLISTED quaternion→Euler conversion. Decide whether it is POINT_IN_TIME or ' +
        'SEQUENCE and add it to DOORS with the reason. A SEQUENCE must go through ' +
        'continuousEuler.',
    ).toEqual([]);

    // A listed file that lost its conversion — the row is stale and misleads.
    expect(
      listed.filter((f) => !actual.includes(f)),
      'A listed file no longer converts; remove its DOORS row so the census stays honest.',
    ).toEqual([]);

    // A listed file that GREW one — the new call is unreviewed even though the
    // file was already blessed.
    for (const f of listed) {
      expect(found[f], `${f} changed its number of conversion sites`).toBe(DOORS[f].count);
    }
  });

  it('the only SEQUENCE door is the primitive that continuousEuler wraps', () => {
    // Stated as a test rather than a comment so that promoting some other site to
    // SEQUENCE forces a deliberate edit here. If a second SEQUENCE door ever
    // becomes legitimate, that is the moment to make the constructor the only
    // road instead of extending this list.
    const sequenceDoors = Object.entries(DOORS)
      .filter(([, d]) => d.kind === 'SEQUENCE')
      .map(([f]) => f);
    expect(sequenceDoors).toEqual(['src/core/import/threeAdapter.ts']);

    const adapter = readFileSync('src/core/import/threeAdapter.ts', 'utf8');
    expect(adapter).toContain('export function continuousEuler');
  });

  it('the glTF import road uses the continuous converter, not the canonical one', () => {
    // The specific regression #876 fixed: this road assembled keyframes with the
    // canonical converter and the consumer lerped them.
    const chain = readFileSync('src/core/import/gltfImportChain.ts', 'utf8');
    expect(chain).toContain('continuousEuler(');
    // And it must not have quietly reverted to converting per key at assembly time.
    expect(chain).not.toMatch(/kf\.rotation\s*=\s*radVec3ToDeg\(quaternionToEulerVec3/);
  });
});
