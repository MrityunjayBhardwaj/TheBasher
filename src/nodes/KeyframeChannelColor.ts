// KeyframeChannelColor — hex color animation channel.
//
// HSL-lerp interpolation. Lerping in RGB space passes through muddy greys at
// the midpoint of complementary colors; HSL keeps saturation high and picks
// the shorter hue arc. Cubic easing applies smoothstep to the lerp parameter.
//
// V0.5 keeps color handles deferred (color bezier is unusual in production
// tools — a well-eased linear hue ramp covers the common case). The schema
// can grow when a real authoring need appears.
//
// REF: THESIS §42, project_p3_plan, vyapti V2/V3.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { Easing, KeyframeChannelColorValue, TimeValue } from './types';

export const KeyframeChannelColorParams = z.object({
  name: z.string().default('channel'),
  target: z.string().default(''),
  paramPath: z.string().default(''),
  keyframes: z
    .array(
      z.object({
        time: z.number().nonnegative(),
        value: z.string(),
        easing: z.enum(['linear', 'cubic']).default('cubic'),
      }),
    )
    .default([]),
});
export type KeyframeChannelColorParams = z.infer<typeof KeyframeChannelColorParams>;

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

/** Parse a 6- or 3-digit hex color into [r, g, b] in [0, 1]. Falls through to black on bad input. */
function hexToRgb(hex: string): readonly [number, number, number] {
  const h = hex.trim().replace(/^#/, '');
  let r = 0;
  let g = 0;
  let b = 0;
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else if (h.length === 6) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return [0, 0, 0];
  return [r / 255, g / 255, b / 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));
  const toHex = (x: number) => clamp(x).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToHsl(
  r: number,
  g: number,
  b: number,
): readonly [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(
  h: number,
  s: number,
  l: number,
): readonly [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}

/** Shortest-arc hue lerp on the hue circle [0, 1). */
function lerpHue(a: number, b: number, u: number): number {
  let d = b - a;
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  let h = a + d * u;
  if (h < 0) h += 1;
  if (h >= 1) h -= 1;
  return h;
}

function interpHex(aHex: string, bHex: string, u: number, easing: Easing): string {
  const t = easing === 'cubic' ? smoothstep(u) : u;
  const [ar, ag, ab] = hexToRgb(aHex);
  const [br, bg, bb] = hexToRgb(bHex);
  const [ah, as, al] = rgbToHsl(ar, ag, ab);
  const [bh, bs, bl] = rgbToHsl(br, bg, bb);
  const h = lerpHue(ah, bh, t);
  const s = as + (bs - as) * t;
  const l = al + (bl - al) * t;
  const [r, g, blue] = hslToRgb(h, s, l);
  return rgbToHex(r, g, blue);
}

function sample(keyframes: KeyframeChannelColorParams['keyframes'], t: number): string {
  if (keyframes.length === 0) return '#000000';
  if (t <= keyframes[0].time) return keyframes[0].value;
  const last = keyframes[keyframes.length - 1];
  if (t >= last.time) return last.value;
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const u = span > 0 ? (t - a.time) / span : 0;
      return interpHex(a.value, b.value, u, b.easing);
    }
  }
  return last.value;
}

export const KeyframeChannelColorNode: NodeDefinition<
  KeyframeChannelColorParams,
  KeyframeChannelColorValue
> = {
  type: 'KeyframeChannelColor',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: KeyframeChannelColorParams,
  inputs: {
    time: { type: 'Time', cardinality: 'single' },
  },
  outputs: { out: { type: 'KeyframeChannel', cardinality: 'single' } },
  evaluate(params, inputs: ResolvedInputs) {
    const time = inputs.time as TimeValue | undefined;
    const tSeconds = time?.seconds ?? 0;
    const sorted = [...params.keyframes].sort((a, b) => a.time - b.time);
    const value = sample(sorted, tSeconds);
    return {
      kind: 'KeyframeChannel',
      valueType: 'color',
      name: params.name,
      target: params.target,
      paramPath: params.paramPath,
      value,
    };
  },
};
