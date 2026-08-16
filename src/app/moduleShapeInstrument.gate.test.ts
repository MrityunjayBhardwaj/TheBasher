// #676 — the instrument that holds the leaves is itself measured.
//
// `importsOf` is used by two standing gates to assert a module's import list EXACTLY
// (`faceCountLeaf.gate.test.ts`, `operatorLane.gate.test.ts`). Neither of them can tell an
// honest empty answer from a broken parser, and until this file existed nothing measured
// the parser at all — it was used, never checked. Both defects it shipped with were found
// the same way: by pointing it at a new file and disbelieving the answer.
//
//   1. It could not cross a NEWLINE, so every import written across several lines was
//      invisible. That is how an import is written as soon as it names more than a symbol
//      or two, so the blindness scaled with the size of the import block.
//   2. It stripped BLOCK comments first, over raw text, so a `/*` sequence inside a `//`
//      line comment opened a block that ran to the next `*/` and ate the code in between.
//      15 files in this repo write that sequence in prose about eslint scopes; SEVEN of
//      them lost real import specifiers, and `src/render/dryRun.ts` — a file with seven
//      imports — reported NONE.
//
// The rows below are the two defects, as literals, plus one property derived over every
// source file. The literals are what red when the parse regresses; the property is what
// catches a regression in a shape nobody thought to write down.
//
// REF: tools/gates/moduleShape.ts (the instrument); src/test-utils/sourceScan.ts (the
//      comment stripper it now shares rather than re-spelling); issue #676.

import { describe, expect, it } from 'vitest';
import { importsOf } from '../../tools/gates/moduleShape';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';

/** Is this the shape of a module specifier, as opposed to text from a template literal? */
const looksLikeSpecifier = (s: string): boolean => /^[@a-zA-Z0-9._~/-]+$/.test(s);

describe('#676 importsOf sees a multi-line import', () => {
  it('reports a multi-line import sitting BESIDE single-line ones', () => {
    // `modifierGeometry.ts` opens with a nine-line `import type { … }` followed by five
    // single-line imports. The old parse returned the five and looked entirely healthy —
    // a partial answer is harder to disbelieve than an empty one.
    const imports = importsOf('src/app/modifierGeometry.ts');
    expect(imports).toContain('../nodes/types'); // the multi-line one
    expect(imports).toContain('../core/dag/evaluator'); // a single-line one
  });
});

describe('#676 importsOf is not derailed by a `/*` inside a line comment', () => {
  it('reports all seven imports of a file whose header writes `src/render/*` in prose', () => {
    // This file answered `[]` before the fix. Its header says "V8 (file-rooted dispatch):
    // src/render/* MUST NOT emit Ops" — the `/*` in `src/render/*` opened a block comment
    // that swallowed every import below it.
    const imports = importsOf('src/render/dryRun.ts');
    expect(imports).toEqual([
      '../core/comfy',
      '../core/dag/evaluator',
      '../core/dag/state',
      '../core/dag/types',
      '../core/storage',
      '../nodes/ComfyUIWorkflow',
      '../nodes/types',
    ]);
  });

  it('and the prose that caused it is a REAL IDIOM here, not a one-off', () => {
    // Stated as a count so the reason cannot be dismissed as one unlucky file. If this
    // ever reads zero the idiom has gone, and this whole describe can go with it — but it
    // should be removed deliberately, not discovered missing.
    const files = sourceFiles();
    const withIdiom = files.filter(([, raw]) =>
      raw.split('\n').some((line) => {
        const t = line.trim();
        return t.startsWith('//') && t.slice(2).includes('/*');
      }),
    );
    expect({ examined: files.length, found: withIdiom.length >= 10 }).toEqual({
      examined: files.length,
      found: true,
    });
  });
});

describe('#676 the parse is complete over the whole repo', () => {
  it('reports every `from` specifier in every source file, and the residual is not code', () => {
    // The derived half. A literal row catches the shape someone wrote down; this catches
    // the shape nobody did. `examined` is reported beside the finding, because a clean
    // zero from a walk that never descended reads exactly like a healthy repo.
    const files = sourceFiles();
    const unreported: string[] = [];
    for (const [path, raw] of files) {
      const code = stripComments(raw);
      const seen = new Set([...code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]));
      const reported = importsOf(path);
      for (const s of seen) if (!reported.includes(s)) unreported.push(`${path} :: ${s}`);
    }

    // Three `from '…'` occurrences in this repo are inside TEMPLATE LITERALS — generated
    // prose, not imports — so the residual is stated and shape-checked rather than
    // asserted to be empty. An empty-set assertion here would be false today and would be
    // "fixed" by widening the parser to swallow strings, which is the wrong direction.
    const notSpecifierShaped = unreported.filter((r) => !looksLikeSpecifier(r.split(' :: ')[1]));
    expect({ examined: files.length, unreported: unreported.length }).toEqual({
      examined: files.length,
      unreported: notSpecifierShaped.length,
    });
    expect(files.length).toBeGreaterThan(500);
  });

  it('never reports a specifier that is not literally in the file it came from', () => {
    // The other direction. A regex that widens too far starts inventing specifiers out of
    // object literals, and an invented entry in an EXACT-set gate is indistinguishable
    // from a real import nobody expected.
    const files = sourceFiles();
    const invented: string[] = [];
    for (const [path, raw] of files) {
      for (const s of importsOf(path)) {
        if (!raw.includes(`'${s}'`) && !raw.includes(`"${s}"`)) invented.push(`${path} :: ${s}`);
      }
    }
    expect({ examined: files.length, invented }).toEqual({ examined: files.length, invented: [] });
  });
});
