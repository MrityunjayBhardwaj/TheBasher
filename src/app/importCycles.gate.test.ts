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
 * The module's top-level statements — everything outside a `function` or `class` body.
 *
 * ⚠️ IT LEANS ON THE FORMATTER, AND SAYS SO. A body is skipped from its opening line to the next
 * `}` at COLUMN 0, which is true of every file here because `prettier --check .` runs in CI over
 * the whole repo. If that ever stops being true this over-reports rather than under-reports — it
 * would treat a function body as top level and red on a call inside one, which is a false alarm
 * someone investigates, not a hazard that ships.
 */
function topLevelStatements(file: string): string {
  const lines = stripComments(sourceOf(file)).split('\n');
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping) {
      if (/^\}/.test(line)) skipping = false;
      continue;
    }
    if (/^(export\s+)?(default\s+)?(async\s+)?(function|class)\b/.test(line)) {
      skipping = true;
      continue;
    }
    if (/^\s*import\b/.test(line)) continue;
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

// The two rings #814 created, named rather than discovered. Both are geometry-side and both exist
// for the same reason: a descriptor-side answer needs a built-side fact, or the reverse.
const GEOMETRY_RINGS = [
  [
    'src/app/bevelLayout.ts',
    'src/app/edgeIdentity.ts',
    'src/app/faceCount.ts',
    'src/app/pointIdentity.ts',
  ],
  ['src/app/builtRims.ts', 'src/app/geometryRegistry.ts'],
];

describe('#814 the import cycles, enumerated and held', () => {
  it('the product has exactly these runtime cycles — a new one anywhere is a red', () => {
    // 🔴 THE EXACT SET, NOT A COUNT AND NOT AN UPPER BOUND. Two of these predate this work by a
    // long way and are listed so they are KNOWN rather than merely present; the two geometry ones
    // arrived with #814 and are the trade this file documents. Anything else appearing here is a
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
      GEOMETRY_RINGS[1],
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
});
