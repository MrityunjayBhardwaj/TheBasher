// The retire-a-kind gate (#471, Deliverable B-III) — no tracked end-to-end spec and no
// production file may CONSTRUCT a node type that the object↔data split has retired.
//
// WHY THIS EXISTS, and why a green suite is not the same thing.
// Retiring a fused kind turns its `evaluate` into a throwing sentinel, so any fixture that
// EVALUATES a relic fails loudly — that half is already mechanised and needs no gate. The
// hole is the other half: a fixture that BUILDS a relic and never evaluates it stays green
// while measuring a shape no user can create any more. That has happened twice, both times
// found the expensive way. Three specs carried a retired fused light for a whole release and
// stayed green because nothing evaluated it (#386 slice 5). Sixteen specs quietly failed for
// three merges because they still built a fused `SphereMesh` (#462). Neither had anything
// watching the SET of retired kinds against the files that name them.
//
// WHAT IT IS SCOPED TO, and the reasoning is load-bearing — this gate's scope was MEASURED,
// not assumed, and the measurement moved it twice:
//
//   1. It matches a CONSTRUCTION POSITION (`nodeType: '<relic>'`), never a bare name.
//      Necessary, because the relic names are OVERLOADED. `'DirectionalLight'` is
//      simultaneously a retired node type AND a live `LightValue.kind` discriminator (the
//      recompose target, src/nodes/types.ts:56) AND an Add-menu creation kind
//      (src/app/addPrimitives.ts). A name-grep over src/ fires on ~20 files of permanent,
//      correct code and would need an allowlist longer than the thing it guards. `nodeType:`
//      is the one position that unambiguously means "mint a node of this type".
//
//   2. It strips COMMENTS first. Four end-to-end specs name a relic in prose precisely to
//      record that it is retired (`// The fused 'Curve' node type is retired.`). Those are
//      the good pattern, not carriers, and a comment cannot build a node. Stripping costs
//      ~30 lines and buys an allowlist of zero — see `stripComments` on why it tracks string
//      state rather than blanking from `//` to end-of-line.
//
//   3. It reads the TRACKED file list, not the filesystem. There are commonly a dozen or
//      more untracked `tmp-*.spec.ts` probes in a working tree and they freely build relics.
//      A gate that is red locally and green in CI gets switched off, so the subject has to be
//      exactly what CI sees: `git ls-files`.
//
//   4. It scans `tests/**` and NON-TEST `src/**`, and deliberately NOT `src/**/*.test.ts`.
//      Measured: 17 unit fixtures construct a relic to exercise graph plumbing (diffing,
//      identify, tree walks) and never evaluate it, so the type string is inert there — and
//      the throwing sentinel already covers any that do evaluate. They are stale rather than
//      broken, they are a separate blast radius, and they are filed as #476. An end-to-end
//      spec is different in kind: it drives the real application and asserts on UI behaviour,
//      so a relic there means the assertion describes a shape the product cannot reach.
//
// THE ALLOWLIST IS EMPTY, AND IT SHOULD STAY THAT WAY. An accepted carrier is how a gate
// comes to excuse the very thing it was built to catch, so `ACCEPTED_CARRIERS` requires a
// reason and an issue number per entry and is asserted as a SET (a novel carrier fails; an
// entry whose file is clean is reported as prunable) rather than consulted as a label.
//
// WHAT IT CANNOT GUARD — stated because a gate that hides its blind spot reads as more
// coverage than it has. A relic minted through a COMPUTED type (`nodeTypeFor(kind)`) is
// invisible to any grep. That path is covered instead by the throwing sentinel plus the
// registry: production code that computed its way to a relic would throw on first evaluate.
//
// REF: src/test-utils/splitKinds.ts (`fusedTypes` — the derived subject); src/a11y/grepGates.test.ts
//      (the grep-gate-as-unit-test precedent this mirrors); .anvi/krama.md K23 finding 6 (the
//      green-suite-proves-nothing case); issues #471, #462, #476.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stripComments } from './sourceScan';
import { SPLIT_KINDS, SPLIT_KIND_NAMES } from './splitKinds';

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * A tracked file this gate accepts as a carrier despite the rule.
 *
 * Empty on purpose. Adding an entry means the gate stops protecting that file, so each one
 * carries the reason and the issue that will remove it — and the assertion below treats this
 * as a set, so an entry that is no longer needed is reported rather than quietly kept.
 */
const ACCEPTED_CARRIERS: readonly { file: string; why: string; issue: string }[] = [];

/**
 * Every node type the split has retired, derived from the kind descriptor rather than listed.
 *
 * Derived, because a list is a checklist: #388 and #389 each retire more fused types, and a
 * hardcoded set would silently stop covering them. `fusedTypes` is already the one place each
 * kind records what it replaced, so a new kind enrolls in this gate by existing. Note that
 * `AmbientLight` is correctly absent — ambient is a World datablock and never split, the one
 * partial retirement.
 */
function retiredNodeTypes(): string[] {
  return [...new Set(SPLIT_KIND_NAMES.flatMap((kind) => [...SPLIT_KINDS[kind].fusedTypes]))].sort();
}

// `stripComments` moved to `./sourceScan` when #387's band grep-gate became its second
// consumer — same reasoning, stated there. Enumerating tracked files stayed HERE (and in
// the other gate) because `src/test-utils/*.ts` is typechecked against a tsconfig with no
// `@types/node`, so a shared helper could not call `git ls-files`.

/** The construction position: `nodeType: '<relic>'`, in any of the three quote styles. */
function carrierPattern(types: readonly string[]): RegExp {
  const alt = types.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`\\bnodeType\\s*:\\s*['"\`](${alt})['"\`]`);
}

/** Tracked `.ts`/`.tsx` under `tests/**` or NON-test `src/**` — exactly what CI sees. */
function scannedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', 'src', 'tests'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((p) => /\.tsx?$/.test(p))
    .filter((p) => !/\.test\.tsx?$/.test(p));
}

interface Carrier {
  file: string;
  line: number;
  text: string;
  type: string;
}

function findCarriers(files: readonly string[], re: RegExp): Carrier[] {
  const hits: Carrier[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
    src.split('\n').forEach((text, i) => {
      const m = re.exec(text);
      if (m) hits.push({ file, line: i + 1, text: text.trim(), type: m[1] });
    });
  }
  return hits;
}

describe('retire-a-kind gate (#471 B-III)', () => {
  it('derives the retired types from the kind descriptor, and covers every sentinel relic', () => {
    const retired = retiredNodeTypes();
    // Guard-the-guard: an empty or shrunken subject would make every assertion below pass
    // vacuously, which is the exact failure mode this gate exists to prevent one level down.
    // 9 with the camera's two fused types (#387); 7 before it.
    expect(retired.length).toBeGreaterThanOrEqual(9);

    // The independent cross-check, and the reason a forgotten retirement cannot slip through:
    // a relic announces itself in its own source with the sentinel `'<Type> is retired;'`.
    // That set and the descriptor's `fusedTypes` must be EQUAL in both directions — a kind
    // retired without a descriptor entry leaves this gate blind to it, and a descriptor entry
    // with no sentinel means the relic still evaluates. Node types are strings, so there is no
    // `never` to close here; this equality is what substitutes for one.
    const sentinelRe = /['"](\w+) is retired[;,]/;
    const declared = new Set<string>();
    for (const file of scannedFiles()) {
      // Comment-stripped for the same reason the carrier sweep is: prose that quotes the
      // sentinel while discussing a retirement would otherwise enrol a type here and break the
      // equality below from the wrong side. String contents survive stripping, and the real
      // sentinel lives in one.
      const src = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      for (const line of src.split('\n')) {
        const m = sentinelRe.exec(line);
        if (m) declared.add(m[1]);
      }
    }
    expect([...declared].sort()).toEqual(retired);
  });

  it('no tracked end-to-end spec or production file constructs a retired node type', () => {
    const retired = retiredNodeTypes();
    const files = scannedFiles();
    // Guard-the-guard: if the tracked-file walk ever returns (nearly) nothing — no git, a
    // changed layout, a filter typo — the sweep finds no carriers and reports success while
    // having looked at nothing. Asserted per SCOPE rather than as one total, because a filter
    // bug that dropped an entire half (all of tests/, say) would still clear a combined
    // threshold on the surviving half alone. Counted structurally rather than by naming a
    // canary file, which would red this gate for the unrelated reason of a rename.
    expect(files.filter((f) => f.startsWith('tests/e2e/')).length).toBeGreaterThan(100);
    expect(files.filter((f) => f.startsWith('src/')).length).toBeGreaterThan(300);

    const carriers = findCarriers(files, carrierPattern(retired));
    const accepted = new Map(ACCEPTED_CARRIERS.map((a) => [a.file, a]));
    const novel = carriers.filter((c) => !accepted.has(c.file));

    if (novel.length > 0) {
      const detail = novel.map((c) => `  ${c.file}:${c.line}  ${c.text}`).join('\n');
      throw new Error(
        `${novel.length} file(s) construct a RETIRED node type (${retired.join(', ')}).\n` +
          `A relic's evaluate() throws, so if this is an end-to-end spec it is either failing ` +
          `or — worse — passing while asserting on a shape the product can no longer build. ` +
          `Retarget it onto the split pair with the matching tests/e2e/_split<Kind>.ts helper.\n` +
          `Carriers:\n${detail}`,
      );
    }
    expect(novel).toHaveLength(0);

    // The other direction: an accepted entry whose file is now clean is stale and should be
    // pruned, so the allowlist can only ever shrink by itself.
    const carrying = new Set(carriers.map((c) => c.file));
    const stale = ACCEPTED_CARRIERS.filter((a) => !carrying.has(a.file));
    expect(
      stale.map((s) => s.file),
      'accepted carriers no longer carrying a relic — remove these entries',
    ).toEqual([]);
  });

  it('the detector fires on a construction and stays silent on prose (positive + negative controls)', () => {
    // The standing proof that the sweep above is not vacuous. Its subject is currently empty —
    // which is the goal — so without these controls a broken regex, a broken comment stripper
    // or an empty type list would read exactly like a clean repository.
    const re = carrierPattern(retiredNodeTypes());
    const fires = (src: string) => re.test(stripComments(src));

    // Constructions — every spelling a fixture actually uses.
    for (const line of [
      "{ type: 'addNode', nodeId: sid, nodeType: 'SphereMesh', params: {} },",
      '    nodeType: "BoxMesh",',
      "nodeType:'Curve'",
      "  nodeType: 'AreaLight',",
      "{ id: 'a', nodeType: 'DirectionalLight' }",
    ]) {
      expect(fires(line), `must be detected: ${line}`).toBe(true);
    }

    // Prose and live vocabulary — none of these may trip the gate.
    for (const line of [
      "// selection/sampling name. The fused 'Curve' node type is retired.",
      "/* reaches an area LightData, not a node whose `type` is 'AreaLight'. */",
      "  readonly kind: 'DirectionalLight';", // the surviving LightValue discriminator
      "  { kind: 'PointLight', label: 'Point' },", // the Add-menu creation kind
      "  Area: 'AreaLight',", // lightKind → LightValue.kind map
      "case 'SpotLight':", // a switch over LightValue.kind
      "nodeType: 'Object',", // the surviving type
      "nodeType: 'SphereData',",
    ]) {
      expect(fires(line), `must NOT be detected: ${line}`).toBe(false);
    }

    // A carrier hiding behind a URL on the same line — the case that rules out the naive
    // strip-from-`//`-to-end-of-line implementation.
    expect(fires("const doc = 'https://x/y'; const op = { nodeType: 'BoxMesh' };")).toBe(true);
    // ...while a genuine trailing comment on the same line is still stripped.
    expect(fires("const op = { nodeType: 'Object' }; // not a 'BoxMesh' any more")).toBe(false);
  });
});
