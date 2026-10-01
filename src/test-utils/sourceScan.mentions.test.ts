// `mentionsInCode` (#1407) — a mention that is code, as against prose or message text.

import { describe, expect, it } from 'vitest';
import { mentionsInCode } from './sourceScan';

describe('mentionsInCode', () => {
  it('counts an identifier, a property, a key and an exactly-quoted key', () => {
    expect(mentionsInCode('const zoom = 1;', 'zoom')).toBe(true);
    expect(mentionsInCode('return params.zoom;', 'zoom')).toBe(true);
    expect(mentionsInCode('const v = { zoom: 2 };', 'zoom')).toBe(true);
    expect(mentionsInCode("set(id, 'zoom', 2);", 'zoom')).toBe(true);
    expect(mentionsInCode('const s = `${params.zoom}px`;', 'zoom')).toBe(true);
  });

  it('does not count a longer identifier', () => {
    expect(mentionsInCode('export function faceCountOf() {}', 'faceCount')).toBe(false);
  });

  it('does not count a comment, a file name in a comment, or message text', () => {
    expect(mentionsInCode('// reads zoom here\nconst a = 1;', 'zoom')).toBe(false);
    expect(mentionsInCode('/* see faceCount.gate.test.ts */ const a = 1;', 'faceCount')).toBe(
      false,
    );
    expect(mentionsInCode("throw new Error('faceCount: built 3');", 'faceCount')).toBe(false);
    expect(mentionsInCode('const m = `faceCount: derives ${n} faces`;', 'faceCount')).toBe(false);
  });

  it('keeps reading code after a template that nests braces and quotes', () => {
    const src = 'const m = `a ${f({ k: "x" })} b`; const zoom = 1;';
    expect(mentionsInCode(src, 'zoom')).toBe(true);
    expect(mentionsInCode(src, 'k')).toBe(true);
    expect(mentionsInCode(src, 'x')).toBe(true);
    expect(mentionsInCode(src, 'a')).toBe(false);
  });
});
