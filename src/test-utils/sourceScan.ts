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

/**
 * Does `src` name `word` in CODE — as an identifier, a property, a key, or a string that is
 * exactly the word (`params['zoom']`, `paramPath: 'zoom'`)?
 *
 * Stricter than a whole-word search over {@link stripComments}' output, which still counts a
 * word inside a longer string. That is how a file whose only mention was an error-message prefix
 * (`"faceCount: descriptor … built"`) kept being accepted as the reader of a param named
 * `faceCount` after the code that read it was deleted (#1407).
 *
 * String and template TEXT is blanked; the code inside a template's `${…}` is kept, and a plain
 * string whose whole content is the word is kept, since that is how a param is addressed by key.
 */
export function mentionsInCode(src: string, word: string): boolean {
  const code = stripComments(src);
  let out = '';
  let i = 0;
  // A stack of what we are inside: a quote char, or '{' for a template's `${…}` expression.
  const stack: string[] = [];
  const top = () => stack[stack.length - 1];
  while (i < code.length) {
    const c = code[i];
    const inside = top();
    if (inside === "'" || inside === '"') {
      // Plain string: find its end, keep the content only when it is exactly the word.
      let j = i;
      while (j < code.length && code[j] !== inside) j += code[j] === '\\' ? 2 : 1;
      const content = code.slice(i, j);
      out += content === word ? content : ' '.repeat(content.length);
      out += inside;
      stack.pop();
      i = j + 1;
      continue;
    }
    if (inside === '`') {
      if (c === '\\') {
        out += '  ';
        i += 2;
      } else if (c === '`') {
        out += c;
        stack.pop();
        i += 1;
      } else if (c === '$' && code[i + 1] === '{') {
        out += '${';
        stack.push('{');
        i += 2;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    // Code — either top level or inside a template expression.
    if (c === "'" || c === '"' || c === '`') {
      stack.push(c);
    } else if (inside === '{' && c === '{') {
      stack.push('{');
    } else if (inside === '{' && c === '}') {
      stack.pop();
    }
    out += c;
    i += 1;
  }
  return new RegExp(`(?<![A-Za-z0-9_$])${word}(?![A-Za-z0-9_$])`).test(out);
}
