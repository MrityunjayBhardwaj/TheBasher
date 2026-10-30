// sceneBundleText — a `.basher` scene file written and read in parts, never as one string (#1736).
//
// WHY THIS EXISTS. A scene file is one JSON object: the node graph, plus every stored asset as a
// base64 string. Saving built it with one `JSON.stringify(bundle)` and opening read it with one
// `file.text()` and one `JSON.parse`, so the whole file had to fit in a single JavaScript string.
// V8's longest string is 0x1fffffe8 characters (536,870,888). Measured on a real 595,462,686-byte
// shot (a 348 MB graph and 27 assets) in Chromium 147: `file.text()` does not throw, it returns an
// EMPTY string, so opening reported a valid file as "corrupt JSON"; and saving it threw "Invalid
// string length" from the one `JSON.stringify`.
//
// The graph and each asset are separate values, so they need not share a string:
//   - Writing: the file is a Blob of parts. Each top-level field is its own part, and inside
//     `assets` each asset is its own part. The Blob joins them on disk; no string holds the file.
//   - Reading: the file is read as BYTES. A scan over the bytes finds where each top-level value
//     starts and ends (and each asset inside `assets`), and each is decoded and parsed alone.
//     Scanning bytes is safe for UTF-8: every byte of a multi-byte character is ≥ 0x80, so none
//     can be mistaken for a quote, a backslash or a bracket.
// The largest single string is then the largest single value (here the 348 MB graph). A value
// past the limit on its own is said by name rather than failing as "invalid string length".
//
// REF: issue #1736; src/app/sceneFileActions.ts (the save and open actions); sceneBundle.ts (the
//      envelope's schema, applied after this).

/** V8's longest string, in UTF-16 code units. */
export const LONGEST_STRING = 0x1fffffe8;

export interface BundleTextOptions {
  /** The longest string one part may be. Tests pass a small one. */
  readonly maxString?: number;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJ = 0x7b;
const CLOSE_OBJ = 0x7d;
const OPEN_ARR = 0x5b;
const CLOSE_ARR = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;

const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;

class TooLong extends Error {}

function checked(text: string, what: string, max: number): string {
  if (text.length > max) {
    throw new TooLong(
      `The scene's ${what} is ${mb(text.length)} of text on its own, more than this browser can ` +
        `hold in one piece (${mb(max)}).`,
    );
  }
  return text;
}

/** JSON for one value, or a named error where it is too long to be one string. */
function stringifyPart(value: unknown, what: string, max: number): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new TooLong(
        `The scene's ${what} is more text than this browser can hold in one piece (${mb(max)}).`,
      );
    }
    throw err;
  }
  return checked(text, what, max);
}

/**
 * The scene file's text, as parts to hand to a Blob. Equal, joined, to `JSON.stringify(bundle)`
 * for a bundle without undefined fields.
 */
export function sceneBundleParts(
  bundle: Record<string, unknown>,
  options: BundleTextOptions = {},
): string[] {
  const max = options.maxString ?? LONGEST_STRING;
  const parts: string[] = ['{'];
  let first = true;
  for (const [key, value] of Object.entries(bundle)) {
    if (value === undefined) continue;
    parts.push(`${first ? '' : ','}${JSON.stringify(key)}:`);
    first = false;
    if (key === 'assets' && value && typeof value === 'object' && !Array.isArray(value)) {
      parts.push('{');
      let firstAsset = true;
      for (const [path, data] of Object.entries(value as Record<string, unknown>)) {
        if (data === undefined) continue;
        parts.push(`${firstAsset ? '' : ','}${JSON.stringify(path)}:`);
        parts.push(stringifyPart(data, `asset ${path}`, max));
        firstAsset = false;
      }
      parts.push('}');
    } else {
      parts.push(stringifyPart(value, key, max));
    }
  }
  parts.push('}');
  return parts;
}

/** Thrown for bytes that are not one JSON object. */
export class BundleSyntaxError extends Error {}

const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

function skipSpace(b: Uint8Array, i: number): number {
  while (i < b.length && isSpace(b[i])) i++;
  return i;
}

/** The index just past the string whose opening quote is at `i`. */
function stringEnd(b: Uint8Array, i: number): number {
  for (let j = i + 1; j < b.length; j++) {
    if (b[j] === BACKSLASH) j++;
    else if (b[j] === QUOTE) return j + 1;
  }
  throw new BundleSyntaxError('unterminated string');
}

/** The index just past the JSON value that starts at `i`. */
function valueEnd(b: Uint8Array, i: number): number {
  const c = b[i];
  if (c === QUOTE) return stringEnd(b, i);
  if (c === OPEN_OBJ || c === OPEN_ARR) {
    let depth = 0;
    for (let j = i; j < b.length; j++) {
      const d = b[j];
      if (d === QUOTE) j = stringEnd(b, j) - 1;
      else if (d === OPEN_OBJ || d === OPEN_ARR) depth++;
      else if (d === CLOSE_OBJ || d === CLOSE_ARR) {
        if (--depth === 0) return j + 1;
      }
    }
    throw new BundleSyntaxError('unterminated object');
  }
  let j = i;
  while (
    j < b.length &&
    b[j] !== COMMA &&
    b[j] !== CLOSE_OBJ &&
    b[j] !== CLOSE_ARR &&
    !isSpace(b[j])
  ) {
    j++;
  }
  if (j === i) throw new BundleSyntaxError('missing value');
  return j;
}

interface Member {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/** The members of the object whose `{` is at `open`, as byte ranges of their values. */
function membersOf(
  b: Uint8Array,
  open: number,
  decode: (s: number, e: number) => string,
): Member[] {
  if (b[open] !== OPEN_OBJ) throw new BundleSyntaxError('not an object');
  const out: Member[] = [];
  let i = skipSpace(b, open + 1);
  if (b[i] === CLOSE_OBJ) return out;
  for (;;) {
    if (b[i] !== QUOTE) throw new BundleSyntaxError('expected a key');
    const keyEnd = stringEnd(b, i);
    const key = JSON.parse(decode(i, keyEnd)) as string;
    i = skipSpace(b, keyEnd);
    if (b[i] !== COLON) throw new BundleSyntaxError('expected a colon');
    const start = skipSpace(b, i + 1);
    const end = valueEnd(b, start);
    out.push({ key, start, end });
    i = skipSpace(b, end);
    if (b[i] === COMMA) {
      i = skipSpace(b, i + 1);
      continue;
    }
    if (b[i] === CLOSE_OBJ) return out;
    throw new BundleSyntaxError('expected a comma or a closing brace');
  }
}

/**
 * Parse a scene file's bytes, one value at a time: each top-level field, and each asset inside
 * `assets`, is decoded and parsed on its own. Throws `BundleSyntaxError` for bytes that are not a
 * JSON object, and a named error for a single value too long to be one string.
 */
export function parseSceneBundleBytes(
  bytes: Uint8Array,
  options: BundleTextOptions = {},
): Record<string, unknown> {
  const max = options.maxString ?? LONGEST_STRING;
  const decoder = new TextDecoder();
  const decode = (start: number, end: number, what = 'file'): string => {
    // A UTF-8 byte decodes to at most one UTF-16 unit, so a range within the limit in bytes is
    // within it as text; one past it is checked once decoded.
    if (end - start > max) {
      let text: string | null = null;
      try {
        text = decoder.decode(bytes.subarray(start, end));
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
      }
      if (text === null || text.length > max) {
        throw new TooLong(
          `The scene's ${what} is ${mb(end - start)} on its own, more than this browser can ` +
            `read in one piece (${mb(max)}).`,
        );
      }
      return text;
    }
    return decoder.decode(bytes.subarray(start, end));
  };
  const parse = (start: number, end: number, what: string): unknown => {
    try {
      return JSON.parse(decode(start, end, what));
    } catch (err) {
      if (err instanceof SyntaxError) throw new BundleSyntaxError(`${what}: ${err.message}`);
      throw err;
    }
  };
  // Skip a byte-order mark, as `file.text()` did.
  let at = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  at = skipSpace(bytes, at);
  const top = membersOf(bytes, at, (s, e) => decode(s, e));
  const end = skipSpace(bytes, valueEnd(bytes, at));
  if (end !== bytes.length) throw new BundleSyntaxError('text after the scene object');
  const out: Record<string, unknown> = {};
  for (const m of top) {
    if (m.key === 'assets' && bytes[m.start] === OPEN_OBJ) {
      const assets: Record<string, unknown> = {};
      for (const a of membersOf(bytes, m.start, (s, e) => decode(s, e))) {
        assets[a.key] = parse(a.start, a.end, `asset ${a.key}`);
      }
      out[m.key] = assets;
    } else {
      out[m.key] = parse(m.start, m.end, m.key);
    }
  }
  return out;
}
