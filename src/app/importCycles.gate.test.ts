// #814 — THE IMPORT CYCLES THIS PRODUCT HAS, ENUMERATED, AND THE ONE RULE THAT KEEPS THEM SAFE.
//
// `faceCountLeaf.gate.test.ts` protected a LOCAL acyclicity claim about one module: *"nothing
// this module depends on can depend back on it."* #814 traded that claim for one ring, because a
// bevel's face count is `F + E + V` and the `E` term lives in `edgeIdentity`, which needs the face
// order — so the ring closes at `faceCountOf('bevel')` and moving code between the modules
// relocates it without breaking it. Trading a property silently is how it stops being one, so it
// is traded HERE, in the open, with the compensating check attached.
//
// ── WHAT WAS MEASURED BEFORE ANY OF THIS WAS WRITTEN ──────────────────────────────────────
//
// Two things, both of which changed what the right gate was:
//
//   1. THE HAZARD IS REAL AND IT IS SILENT. On this toolchain a CALL-TIME cycle resolves
//      correctly, and a MODULE-INITIALISATION-TIME read across one evaluates to `undefined` —
//      no throw, no warning. There is no `import/no-cycle` rule configured, so nothing catches
//      it. That is the entire failure mode, and it is a property of WHEN a binding is read, not
//      of whether a cycle exists.
//
//   2. CYCLES ARE NOT NOVEL HERE. A census over 596 product files found FOUR runtime cyclic
//      components, two of which — 19 modules through `boot`/`importGltf`, and 11 through
//      `resolveEvaluated*` — long predate this work and have nothing to do with geometry. A gate
//      that banned cycles outright would have been a gate nobody could land.
//
// ⚠️ TYPE-ONLY IMPORTS ARE NOT EDGES, and counting them is the difference between four components
// and five. `import type` is erased, so it cannot participate in an initialisation order and
// cannot produce the `undefined` above. The census below drops them, which is why
// `src/nodes/types.ts` and `polygonLayout.ts` appear in no component here even though a
// specifier-level parse puts them in one.
//
// REF: src/app/bevelLayout.ts (the ring's header and its reason); src/app/faceCountLeaf.gate.test.ts
//      (the claim this supersedes for `faceCount.ts`); issue #814.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { stripComments } from '../test-utils/sourceScan';

const ROOT = path.resolve(__dirname, '../..');

function productFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      productFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.|\.gate\./.test(entry)) continue;
    out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

const FILES = productFiles(path.join(ROOT, 'src')).sort();
const PRESENT = new Set(FILES);

function sourceOf(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

/**
 * The specifiers `file` imports AS VALUES, resolved to product paths.
 *
 * 🔴 A BRACE CLAUSE WHOSE EVERY SPECIFIER IS `type X` IS ALSO ERASED, not just a leading
 * `import type`. `bevelLayout.ts` imports `SourceFace` and `PolygonRim` that way on purpose, and
 * treating those as edges would report a ring that does not exist at runtime.
 */
function valueImportsOf(file: string): string[] {
  const source = stripComments(sourceOf(file));
  const out: string[] = [];
  const pattern = /^\s*import\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) {
    const [, typeKeyword, clause, specifier] = match;
    if (typeKeyword) continue;
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces) {
      const named = braces[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const outside = clause
        .replace(/\{[\s\S]*\}/, '')
        .replace(/,/g, '')
        .trim();
      if (named.length > 0 && named.every((s) => s.startsWith('type ')) && outside === '') continue;
    }
    if (!specifier.startsWith('.')) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    for (const candidate of [
      base + '.ts',
      base + '.tsx',
      base + '/index.ts',
      base + '/index.tsx',
    ]) {
      if (PRESENT.has(candidate)) {
        if (candidate !== file) out.push(candidate);
        break;
      }
    }
  }
  return out;
}

/** Tarjan's strongly connected components, keeping only the ones with more than one member. */
function cyclicComponents(): string[][] {
  const graph = new Map(FILES.map((f) => [f, valueImportsOf(f)]));
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let next = 0;

  // Iterative, because the deepest chain here is well past a comfortable recursion depth and a
  // stack overflow in a gate reads as an unrelated failure.
  for (const root of FILES) {
    if (index.has(root)) continue;
    const work: { node: string; edge: number }[] = [{ node: root, edge: 0 }];
    index.set(root, next);
    low.set(root, next);
    next++;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const edges = graph.get(frame.node) ?? [];
      if (frame.edge < edges.length) {
        const child = edges[frame.edge++];
        if (!index.has(child)) {
          index.set(child, next);
          low.set(child, next);
          next++;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, edge: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let popped: string;
        do {
          popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== frame.node);
        if (component.length > 1) found.push(component.sort());
      }
    }
  }
  return found.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/**
 * The module's top-level statements — everything outside a `function` or `class` body, and
 * outside an `import` statement however many lines it spans.
 *
 * ⚠️ IT LEANS ON THE FORMATTER, AND SAYS SO. A body is skipped from its opening line to the next
 * `}` at COLUMN 0, which is true of every file here because `prettier --check .` runs in CI over
 * the whole repo. If that ever stops being true this over-reports rather than under-reports — it
 * would treat a function body as top level and red on a call inside one, which is a false alarm
 * someone investigates, not a hazard that ships.
 */
function topLevelStatements(file: string): string {
  return topLevelStatementsOf(stripComments(sourceOf(file)));
}

/**
 * {@link topLevelStatements} over text rather than a path, so the parser can be pinned against
 * synthetic sources instead of planted edits to product files.
 *
 * 🔴 #1043 — AN IMPORT IS SKIPPED THROUGH TO ITS `from`, NOT JUST ITS FIRST LINE. Dropping only
 * lines that START with `import` kept the continuation lines of a multi-line clause, so every
 * name imported that way read as a module-level use. Measured when #1041 merged the two geometry
 * rings: 8 violations in `geometryRegistry.ts`, every one an import continuation, while a scan
 * that shares no code with this parser put all 8 names inside function bodies. It had never
 * fired because all 10 peer imports in the old rings were single-line — so it was waiting for the
 * first ring change, which is exactly when a false alarm here is most expensive.
 */
function topLevelStatementsOf(source: string): string {
  const lines = source.split('\n');
  const kept: string[] = [];
  let skipping = false;
  let inImport = false;
  for (const line of lines) {
    if (inImport) {
      if (/\bfrom\s*['"]/.test(line)) inImport = false;
      continue;
    }
    if (skipping) {
      if (/^\}/.test(line)) skipping = false;
      continue;
    }
    if (/^(export\s+)?(default\s+)?(async\s+)?(function|class)\b/.test(line)) {
      skipping = true;
      continue;
    }
    if (/^\s*import\b/.test(line)) {
      // A one-line import names its source on the same line, and a side-effect import
      // (`import './x';`) has no `from` at all — neither opens a span.
      if (!/\bfrom\s*['"]|^\s*import\s*['"]/.test(line)) inImport = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** The identifiers `file` imports from `from`, however they are spelled. */
function namesImportedFrom(file: string, from: string): string[] {
  const source = stripComments(sourceOf(file));
  const relative = path.posix
    .relative(path.posix.dirname(file), from)
    .replace(/\.tsx?$/, '')
    .replace(/^(?!\.)/, './');
  // 🔴 `[^;]*` AND NOT `[\s\S]*?`. The lazy any-character version spans from the FIRST import in
  // the file to the one being looked for, swallowing every name in between — measured: it
  // reported `geometryRegistry` importing `BoxGeometry` and `Matrix4` from `builtRims.ts`. An
  // import clause contains no semicolon before its `from`, and prettier guarantees the trailing
  // one, so the statement separator is the correct boundary. Same shape `valueImportsOf` uses.
  const pattern = new RegExp(
    `^\\s*import\\s+(type\\s+)?([^;]*?)\\s*from\\s*['"]${relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    'gm',
  );
  const names: string[] = [];
  for (const match of source.matchAll(pattern)) {
    // A leading `import type` is erased entirely, so it cannot be read at module level in any
    // sense that matters here — `bevelLayout.ts` pulls `SourceFace` that way and was reported as
    // a violation until this line existed.
    if (match[1]) continue;
    const clause = match[2];
    const braces = /\{([\s\S]*)\}/.exec(clause);
    const inner = braces ? braces[1] : '';
    for (const raw of inner.split(',')) {
      const spec = raw.trim();
      if (spec === '' || spec.startsWith('type ')) continue;
      names.push((spec.split(/\s+as\s+/).pop() ?? spec).trim());
    }
  }
  return names;
}

// ONE geometry ring, and it used to be two. #814 created a descriptor-side ring (bevelLayout,
// edgeIdentity, faceCount, pointIdentity) and a built-side one (builtRims, geometryRegistry), both
// for the same reason: a descriptor-side answer needs a built-side fact, or the reverse.
//
// 🔴 #1041 MERGED THEM, AND IT WAS MEASURED RATHER THAN ALLOWED. An imported mesh's topology IS
// its buffer, so a welded rim over one — and every edge answer composed from it, including a
// derived kind over an import — has to reach the buffer from the descriptor side. At HEAD there
// were 0 value imports from the descriptor ring into the built one and 17 names across 8
// file-pairs the other way, so ANY such import closes the loop. Measured with this file's own
// component check: removing either of the two new imports alone still merges them; removing both
// restores the old pair. `cornerMaterialisation.ts` joins because it sits on
// `geometryRegistry -> cornerMaterialisation -> faceCount`.
//
// The alternatives were costed, not dismissed: cutting the built-to-descriptor side is 17 names
// across 8 file-pairs against 3 across 2; injecting the buffer reader instead of importing it
// needs at least 22 call sites to carry a value that can only ever be `getForRead`.
//
// What makes the merge acceptable is the rule below, and it had to be repaired first (#1043): it
// compares files only within one ring entry, so it never saw the import that merged them, and it
// read multi-line imports as module-level uses. Merged and repaired, it is green on the real code
// and red on a planted single-line AND a planted multi-line module-level read.
const GEOMETRY_RINGS = [
  [
    'src/app/bevelLayout.ts',
    'src/app/builtRims.ts',
    'src/app/cornerMaterialisation.ts',
    'src/app/edgeIdentity.ts',
    'src/app/faceCount.ts',
    'src/app/geometryRegistry.ts',
    'src/app/pointIdentity.ts',
  ],
];

describe('#814 the import cycles, enumerated and held', () => {
  it('the product has exactly these runtime cycles — a new one anywhere is a red', () => {
    // 🔴 THE EXACT SET, NOT A COUNT AND NOT AN UPPER BOUND. Two of these predate this work by a
    // long way and are listed so they are KNOWN rather than merely present; the geometry one
    // arrived with #814 as two rings, became one at #1041, and is the trade this file documents. Anything else appearing here is a
    // cycle someone added without noticing, which is the state that produced the `undefined`.
    expect(cyclicComponents()).toEqual([
      [
        'src/agent/mutators/builders/addChannel.ts',
        'src/agent/mutators/builders/randomize.ts',
        'src/agent/mutators/builders/setMaterialColor.ts',
        'src/agent/mutators/index.ts',
        'src/agent/tools/index.ts',
        'src/agent/tools/libraryImport.ts',
        'src/agent/tools/modelGenerate.ts',
        'src/app/animate/dispatchApplyTransform.ts',
        'src/app/asset/bakedTextureLoader.ts',
        'src/app/asset/gltfEntryChoice.ts',
        'src/app/asset/importBvhFbx.ts',
        'src/app/asset/importCommon.ts',
        'src/app/asset/importGltf.ts',
        'src/app/asset/importRefs.ts',
        'src/app/boot.ts',
        'src/app/exposeParams.ts',
        'src/app/resolveColorWriteTarget.ts',
        'src/app/resolveMeshUVSpace.ts',
        'src/app/sceneBundle.ts',
      ],
      [
        'src/app/activeCamera.ts',
        'src/app/geometrySampleSource.ts',
        'src/app/nodeConstraints.ts',
        'src/app/operatorStack.ts',
        'src/app/paramDrivers.ts',
        'src/app/resolveEvaluatedMesh.ts',
        'src/app/resolveEvaluatedParam.ts',
        'src/app/resolveEvaluatedTransform.ts',
        'src/app/sceneTreeWalk.ts',
        'src/app/statefulOps.ts',
        'src/app/transformChannelSource.ts',
      ],
      GEOMETRY_RINGS[0],
    ]);
  });

  it('🔴 nothing in a geometry ring reads across it at MODULE LEVEL — the one rule', () => {
    // This is the whole compensating check, and it is the reason the ring is acceptable at all.
    // A cross-ring name used inside a function body is resolved by the time anything calls it; the
    // same name used to initialise a module-level `const` is read while the other module is still
    // evaluating, and yields `undefined` with nothing said.
    const violations: string[] = [];
    for (const ring of GEOMETRY_RINGS) {
      for (const file of ring) {
        const body = topLevelStatements(file);
        for (const peer of ring) {
          if (peer === file) continue;
          for (const name of namesImportedFrom(file, peer)) {
            if (new RegExp(`\\b${name}\\b`).test(body)) {
              violations.push(`${file} reads '${name}' from ${peer} at module level`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the rings are what the modules say they are, so the list above cannot drift silently', () => {
    // Every ring member imports at least one value from another member — the list is not stale
    // names kept alive by this file alone.
    for (const ring of GEOMETRY_RINGS) {
      for (const file of ring) {
        const peers = valueImportsOf(file).filter((f) => ring.includes(f));
        const importers = ring.filter((f) => f !== file && valueImportsOf(f).includes(file));
        expect(peers.length + importers.length).toBeGreaterThan(0);
      }
    }
  });

  it('#1043 — the parser skips a whole import and still sees a multi-line module-level read', () => {
    // Synthetic on purpose: a planted edit to a product file is the falsifier that keeps this
    // honest, and it cannot live in the tree. Each row fails a DIFFERENT wrong parser.
    const read = (text: string) => /\bfaceArityOf\b/.test(topLevelStatementsOf(text));

    // The false positive #1043 is about: a multi-line import and a call-time use only.
    expect(
      read(
        [
          'import {',
          '  faceArityOf,',
          '  faceCountMismatch,',
          "} from './faceCount';",
          'export function f() {',
          '  return faceArityOf(x);',
          '}',
        ].join('\n'),
      ),
    ).toBe(false);

    // A fix that swallows too much would miss this: a REAL module-level read, formatted multi-line.
    expect(
      read(
        [
          'import {',
          '  faceArityOf,',
          "} from './faceCount';",
          'const TABLE = [',
          '  faceArityOf,',
          '];',
        ].join('\n'),
      ),
    ).toBe(true);

    // And the single-line shape the rule always caught.
    expect(
      read(["import { faceArityOf } from './faceCount';", 'const x = faceArityOf;'].join('\n')),
    ).toBe(true);

    // A side-effect import has no `from`; treating it as opening a span would swallow the next
    // statement, which is a module-level read here.
    expect(read(["import './sideEffect';", 'const x = faceArityOf;'].join('\n'))).toBe(true);

    // A type-only multi-line import is skipped the same way and must not swallow what follows.
    expect(
      read(['import type {', '  Foo,', "} from './types';", 'const x = faceArityOf;'].join('\n')),
    ).toBe(true);
  });
});

// ── #641 — `src/nodes/types.ts` SITS BELOW THE APP LAYER, AND SAYS SO AT THE TOP ──────────
//
// The gate above deliberately drops `import type` edges, because an erased import cannot
// participate in a module-initialisation order and so cannot produce the silent `undefined`
// that is the whole hazard there. That is correct for THAT question and it is exactly why it
// could not see this one: `types.ts` carried `import type { MeshUVRead } from '../app/...'`
// 443 lines into the file, closing `nodes/types -> app/uvAttributes -> nodes/types`. Nothing
// was broken, and nothing would have been until the first VALUE crossed that edge — at the
// module every other module imports. Erasure was the only thing holding it.
//
// #641 moved the declaration instead of keeping the rule: `MeshUVRead` is the declared type of
// `EvaluatedMesh.uvRead`, so it belongs beside the interface it describes. These two rows keep
// the edge from coming back — one for the DIRECTION, one for the PLACEMENT that hid it.
//
// 🔴 BOTH ROWS ARE ABSENCE ASSERTIONS ON PURPOSE. A presence check ("types.ts still imports X")
// is monotone in the size of the file and so can never red on an ADDITION, which is the entire
// failure mode here. Each row also asserts its own denominator first, so a passing zero can
// never mean "the scan found nothing at all".
//
// REF: src/nodes/types.ts (the rehomed `MeshUVRead` / `UVAttributeVerdict` and the reason);
//      src/app/uvAttributes.ts (`readMeshUVs` — the implementation, which stayed); issue #641.

/** Every import specifier in `file`, type-only ones INCLUDED — the opposite of `valueImportsOf`. */
function allImportSpecifiersOf(file: string): string[] {
  const pattern = /^\s*import\s+(?:type\s+)?[^;]*?\s*from\s*['"]([^'"]+)['"]/gm;
  return [...stripComments(sourceOf(file)).matchAll(pattern)].map((m) => m[1]);
}

describe('#641 nodes/types.ts declares its layer at the top and does not reach up', () => {
  const TYPES = 'src/nodes/types.ts';

  it('imports NOTHING from src/app/ — type-only included, which is the whole point', () => {
    const specifiers = allImportSpecifiersOf(TYPES);
    // DENOMINATOR FIRST: this file does import things. A zero below therefore means "none of
    // them reach the app layer", and can never mean "the pattern matched nothing".
    expect(specifiers.length).toBeGreaterThan(0);

    const intoApp = specifiers.filter((s) =>
      path.posix.normalize(path.posix.join(path.posix.dirname(TYPES), s)).startsWith('src/app/'),
    );
    expect(intoApp).toEqual([]);
  });

  it('has every import at the top, above the first declaration', () => {
    const lines = sourceOf(TYPES).split('\n');
    const importLines = lines
      .map((line, i) => (/^import\s/.test(line) ? i : -1))
      .filter((i) => i >= 0);
    const firstDeclaration = lines.findIndex((line) => /^export\s/.test(line));

    // DENOMINATOR FIRST: both ends of the comparison were actually found.
    expect(importLines.length).toBeGreaterThan(0);
    expect(firstDeclaration).toBeGreaterThan(0);

    const belowFirstDeclaration = importLines
      .filter((i) => i > firstDeclaration)
      .map((i) => `${TYPES}:${i + 1}: ${lines[i].trim()}`);
    expect(belowFirstDeclaration).toEqual([]);
  });
});
