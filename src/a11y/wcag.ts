// WCAG 2.1 contrast helpers — pure functions, no platform deps.
//
// Used by src/a11y/contrastMatrix.test.ts (C1 of P6 W8) to mechanically
// audit every (fg-token, bg-stack) pair in production chrome against
// AA thresholds (4.5:1 normal text, 3:1 large text + UI components).
//
// Reference values asserted in wcag.test.ts:
//   - black (#000) on white (#fff) = 21.0
//   - mid-gray pairs from the W3C examples
//   - rgba(255,255,255,0.5) composited over #000 = #808080 (or near)
//
// Algorithms follow https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
// and the standard alpha-over compositing formula
//   out = top.rgb * top.a + bottom.rgb * (1 - top.a)
//
// REF: docs/UI-SPEC.md §8.4 (contrast); memory/project_p6_w8_plan.md C1.1.

export type RGB = { r: number; g: number; b: number };
export type RGBA = RGB & { a: number };

/**
 * Parse a hex string (#rgb / #rrggbb / #rrggbbaa) into {r,g,b[,a]} with 0-255
 * components and 0-1 alpha. Throws on malformed input — the matrix is
 * authored by hand, so a malformed hex is a bug to surface, not absorb.
 */
export function parseHex(hex: string): RGBA {
  const m = hex.trim().toLowerCase();
  const stripped = m.startsWith('#') ? m.slice(1) : m;
  let r: number;
  let g: number;
  let b: number;
  let a = 1;
  if (stripped.length === 3) {
    r = parseInt(stripped[0] + stripped[0], 16);
    g = parseInt(stripped[1] + stripped[1], 16);
    b = parseInt(stripped[2] + stripped[2], 16);
  } else if (stripped.length === 6) {
    r = parseInt(stripped.slice(0, 2), 16);
    g = parseInt(stripped.slice(2, 4), 16);
    b = parseInt(stripped.slice(4, 6), 16);
  } else if (stripped.length === 8) {
    r = parseInt(stripped.slice(0, 2), 16);
    g = parseInt(stripped.slice(2, 4), 16);
    b = parseInt(stripped.slice(4, 6), 16);
    a = parseInt(stripped.slice(6, 8), 16) / 255;
  } else {
    throw new Error(`parseHex: malformed hex "${hex}"`);
  }
  if ([r, g, b].some((x) => Number.isNaN(x))) {
    throw new Error(`parseHex: non-hex chars in "${hex}"`);
  }
  return { r, g, b, a };
}

/**
 * Format an RGB triple back to lowercase #rrggbb. Used by the matrix to
 * print the composited-bg column for human inspection.
 */
export function formatHex({ r, g, b }: RGB): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Apply a Tailwind /N alpha modifier (0-100) to a base RGB.
 * Returns RGBA with a in 0-1. Pass-through when alpha is undefined/null
 * (fully opaque).
 */
export function withAlpha(base: RGB, alphaPct: number | null | undefined): RGBA {
  const a = alphaPct == null ? 1 : Math.max(0, Math.min(100, alphaPct)) / 100;
  return { ...base, a };
}

/**
 * Alpha-over compositing. Single-step: paint `top` (with its own alpha)
 * onto the opaque `bottom`. Output is opaque RGB — once you composite
 * onto an opaque base, the result is opaque by definition.
 *
 *   out.rgb = top.rgb * top.a + bottom.rgb * (1 - top.a)
 *
 * For stacked alpha (multiple semi-transparent layers), call repeatedly:
 *   composite(layerA, composite(layerB, base))   — bottom-up
 */
export function composite(top: RGBA, bottom: RGB): RGB {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
  };
}

/**
 * Composite a top-to-bottom stack of semi-transparent layers down to one
 * opaque RGB. `stack[0]` is the visually topmost layer; `base` is the
 * opaque page background underneath everything.
 *
 * Reduces bottom-up, exactly as the browser blends: base is painted
 * first, then each layer above it.
 */
export function compositeStack(stack: RGBA[], base: RGB): RGB {
  let acc: RGB = base;
  for (let i = stack.length - 1; i >= 0; i--) {
    acc = composite(stack[i], acc);
  }
  return acc;
}

/**
 * sRGB channel (0-255) to linear-light intensity (0-1), per WCAG 2.1.
 *
 *   c' = c / 255
 *   linear = c' <= 0.03928 ? c' / 12.92 : ((c' + 0.055) / 1.055) ^ 2.4
 */
export function srgbToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

/**
 * Relative luminance of an opaque RGB color, per WCAG 2.1.
 *
 *   L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 *
 * where R/G/B are linear-light intensities.
 */
export function relativeLuminance({ r, g, b }: RGB): number {
  return (
    0.2126 * srgbToLinear(r) +
    0.7152 * srgbToLinear(g) +
    0.0722 * srgbToLinear(b)
  );
}

/**
 * Contrast ratio between two opaque colors, per WCAG 2.1 (range 1:1 .. 21:1).
 *
 *   ratio = (L_lighter + 0.05) / (L_darker + 0.05)
 *
 * Accepts hex strings OR RGB objects.
 */
export function contrastRatio(a: string | RGB, b: string | RGB): number {
  const colorA = typeof a === 'string' ? parseHex(a) : a;
  const colorB = typeof b === 'string' ? parseHex(b) : b;
  const L1 = relativeLuminance(colorA);
  const L2 = relativeLuminance(colorB);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Text-size classification for AA threshold lookup.
 *
 *   'small' — regular text < 18px or bold text < 14px  → AA = 4.5
 *   'large' — regular text ≥ 18px or bold text ≥ 14px  → AA = 3.0
 *   'ui'    — non-text UI component / graphic           → AA = 3.0
 */
export type TextSize = 'small' | 'large' | 'ui';

/** Return the WCAG AA required ratio for a given text-size class. */
export function aaThreshold(size: TextSize): number {
  return size === 'small' ? 4.5 : 3.0;
}
