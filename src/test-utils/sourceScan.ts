// `stripComments` — the one subtle piece of the repo's grep-style gates, the ones that
// assert something about the SOURCE rather than about a running system.
//
// Extracted from `retiredKinds.gate.test.ts` (#471 B-III) when #387 needed a second such
// gate. It encodes a distinction that is easy to get wrong and expensive to discover:
// prose that quotes a forbidden pattern in order to DOCUMENT it is the good pattern, not
// a violation, and four end-to-end specs already name a retired node type in a comment
// for exactly that reason.
//
// It tracks quote state instead of blanking from `//` to end of line, because the naive
// form swallows the remainder of any line containing a `://` inside a string — and with
// it a real violation sitting further along that line. Comment bodies become spaces so
// reported line numbers still match the file on disk.
//
// DELIBERATELY NODE-FREE. `src/test-utils/*.ts` is inside `tsconfig.app.json`'s
// `include` and is not a `*.test.ts`, so it IS typechecked — and the app tsconfig
// declares `"types": ["vite/client"]`, with no `@types/node`. Enumerating tracked files
// therefore stays in each gate's own `.test.ts`, where `node:child_process` is available;
// that half is six lines of `git ls-files` and carries no reasoning worth sharing. This
// half carries all of it.
//
// REF: src/test-utils/retiredKinds.gate.test.ts and src/app/objectDataBand.test.ts (the
//      two consumers); src/a11y/grepGates.test.ts (the grep-gate-as-unit-test
//      precedent); issues #471, #387.

/** Blank out comments, preserving line count and every string's contents. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
