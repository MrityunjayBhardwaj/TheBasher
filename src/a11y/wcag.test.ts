// wcag.ts unit tests — assert against W3C-published reference values so a
// bug in the contrast math can never silently invalidate the matrix
// (contrastMatrix.test.ts depends on these helpers being correct).
//
// REF: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
//      https://www.w3.org/TR/WCAG21/#dfn-relative-luminance

import { describe, expect, it } from 'vitest';
import {
  aaThreshold,
  composite,
  compositeStack,
  contrastRatio,
  formatHex,
  parseHex,
  relativeLuminance,
  srgbToLinear,
  withAlpha,
} from './wcag';

describe('parseHex', () => {
  it('parses 6-digit hex', () => {
    expect(parseHex('#ffffff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseHex('#000000')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseHex('#5af07a')).toEqual({ r: 90, g: 240, b: 122, a: 1 });
  });

  it('parses 3-digit hex by doubling each nibble', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseHex('#000')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseHex('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  });

  it('parses 8-digit hex with alpha', () => {
    expect(parseHex('#ffffff80').a).toBeCloseTo(0.5019, 3);
    expect(parseHex('#000000ff').a).toBe(1);
    expect(parseHex('#00000000').a).toBe(0);
  });

  it('tolerates uppercase and missing leading hash', () => {
    expect(parseHex('FFFFFF')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseHex('#AbCdEf').r).toBe(0xab);
  });

  it('throws on malformed input', () => {
    expect(() => parseHex('#zz')).toThrow();
    expect(() => parseHex('#abcd')).toThrow();
    expect(() => parseHex('not-a-hex')).toThrow();
  });
});

describe('formatHex', () => {
  it('round-trips with parseHex', () => {
    for (const hex of ['#000000', '#ffffff', '#5af07a', '#0a0a0a', '#a3a3a3']) {
      const rgba = parseHex(hex);
      expect(formatHex(rgba)).toBe(hex);
    }
  });

  it('clamps + rounds float channels', () => {
    expect(formatHex({ r: 255.4, g: -1, b: 127.6 })).toBe('#ff0080');
  });
});

describe('withAlpha', () => {
  it('attaches an alpha derived from a 0-100 percentage', () => {
    const base = { r: 90, g: 240, b: 122 };
    expect(withAlpha(base, 25)).toEqual({ ...base, a: 0.25 });
    expect(withAlpha(base, 100)).toEqual({ ...base, a: 1 });
  });

  it('defaults to opaque when alpha is null/undefined', () => {
    const base = { r: 0, g: 0, b: 0 };
    expect(withAlpha(base, null).a).toBe(1);
    expect(withAlpha(base, undefined).a).toBe(1);
  });

  it('clamps out-of-range percentages', () => {
    const base = { r: 0, g: 0, b: 0 };
    expect(withAlpha(base, -10).a).toBe(0);
    expect(withAlpha(base, 250).a).toBe(1);
  });
});

describe('composite (alpha-over)', () => {
  it('opaque top fully covers the bottom', () => {
    expect(composite({ r: 255, g: 0, b: 0, a: 1 }, { r: 0, g: 255, b: 0 })).toEqual({
      r: 255,
      g: 0,
      b: 0,
    });
  });

  it('fully-transparent top reveals the bottom unchanged', () => {
    expect(composite({ r: 255, g: 0, b: 0, a: 0 }, { r: 0, g: 255, b: 0 })).toEqual({
      r: 0,
      g: 255,
      b: 0,
    });
  });

  it('50% white over black produces mid-gray (~128,128,128)', () => {
    // 255 * 0.5 + 0 * 0.5 = 127.5 ≈ 128 once rounded.
    const out = composite({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 });
    expect(out.r).toBeCloseTo(127.5, 1);
    expect(out.g).toBeCloseTo(127.5, 1);
    expect(out.b).toBeCloseTo(127.5, 1);
    expect(formatHex(out)).toBe('#808080');
  });

  it('Tailwind /15 accent over bg-2 onto bg matches manual calc', () => {
    // accent #5af07a at 15% → over bg-2 #161616 (opaque) → resulting opaque RGB
    //   r = 90*0.15 + 22*0.85   = 32.2
    //   g = 240*0.15 + 22*0.85  = 54.7
    //   b = 122*0.15 + 22*0.85  = 37.0
    const out = composite({ r: 90, g: 240, b: 122, a: 0.15 }, { r: 22, g: 22, b: 22 });
    expect(out.r).toBeCloseTo(32.2, 1);
    expect(out.g).toBeCloseTo(54.7, 1);
    expect(out.b).toBeCloseTo(37.0, 1);
  });
});

describe('compositeStack', () => {
  it('single layer matches single composite() call', () => {
    const top = { r: 255, g: 0, b: 0, a: 0.5 };
    const base = { r: 0, g: 255, b: 0 };
    expect(compositeStack([top], base)).toEqual(composite(top, base));
  });

  it('empty stack returns the base unchanged', () => {
    const base = { r: 10, g: 20, b: 30 };
    expect(compositeStack([], base)).toEqual(base);
  });

  it('two stacked translucent whites over black converge toward mid-grays', () => {
    // Layer 0 (top) 25% white, Layer 1 25% white, base black.
    //   bottom blend first: 0.25*255 + 0.75*0 = 63.75
    //   top blend over that: 0.25*255 + 0.75*63.75 = 111.5625
    const out = compositeStack(
      [
        { r: 255, g: 255, b: 255, a: 0.25 },
        { r: 255, g: 255, b: 255, a: 0.25 },
      ],
      { r: 0, g: 0, b: 0 },
    );
    expect(out.r).toBeCloseTo(111.5625, 2);
    expect(out.g).toBeCloseTo(111.5625, 2);
    expect(out.b).toBeCloseTo(111.5625, 2);
  });
});

describe('srgbToLinear', () => {
  it('returns 0 for pure black, 1 for pure white', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(255)).toBeCloseTo(1, 6);
  });

  it('uses the linear branch below the 0.03928 threshold', () => {
    // 10/255 ≈ 0.0392 → linear branch: 0.0392 / 12.92 ≈ 0.00304
    expect(srgbToLinear(10)).toBeCloseTo(0.003035, 5);
  });

  it('uses the gamma branch above the threshold', () => {
    // 128/255 ≈ 0.502 → ((0.502+0.055)/1.055)^2.4 ≈ 0.2159
    expect(srgbToLinear(128)).toBeCloseTo(0.2159, 3);
  });
});

describe('relativeLuminance', () => {
  it('white = 1.0, black = 0.0', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
  });

  it('pure green dominates the Y weighting (0.7152)', () => {
    expect(relativeLuminance({ r: 0, g: 255, b: 0 })).toBeCloseTo(0.7152, 3);
    expect(relativeLuminance({ r: 255, g: 0, b: 0 })).toBeCloseTo(0.2126, 3);
    expect(relativeLuminance({ r: 0, g: 0, b: 255 })).toBeCloseTo(0.0722, 3);
  });
});

describe('contrastRatio', () => {
  it('black vs white = 21.0 (the WCAG maximum)', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
  });

  it('identical colors = 1.0 (no contrast)', () => {
    expect(contrastRatio('#5af07a', '#5af07a')).toBe(1);
    expect(contrastRatio('#0a0a0a', '#0a0a0a')).toBe(1);
  });

  it('#777 vs #fff ≈ 4.48 (a W3C-cited reference pair)', () => {
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });

  it('#777 vs #000 ≈ 4.69 (the mirror of the above through mid-gray)', () => {
    expect(contrastRatio('#777777', '#000000')).toBeCloseTo(4.69, 1);
  });

  it('accepts RGB objects as well as hex strings', () => {
    const w = { r: 255, g: 255, b: 255 };
    const k = { r: 0, g: 0, b: 0 };
    expect(contrastRatio(w, k)).toBeCloseTo(21, 1);
    expect(contrastRatio(w, '#000000')).toBeCloseTo(21, 1);
  });
});

describe('aaThreshold', () => {
  it('returns 4.5 for small text, 3.0 for large + ui', () => {
    expect(aaThreshold('small')).toBe(4.5);
    expect(aaThreshold('large')).toBe(3.0);
    expect(aaThreshold('ui')).toBe(3.0);
  });
});
