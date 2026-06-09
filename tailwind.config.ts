import type { Config } from 'tailwindcss';

export default {
  // Test files are excluded — they sometimes contain class-like string
  // tokens (e.g. focusRingGate.test.ts's grep regex over the legacy
  // focus pseudo-class) that destabilize Tailwind's content extractor.
  // Production CSS doesn't need styles from test sources. (P6 W8 C3.)
  content: ['./index.html', './src/**/*.{ts,tsx}', '!./src/**/*.test.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // v0.6 #4 W3 (D-07) — calm LIGHT palette, Spline-true. The neutral
      // ramp inverted dark→light (dark ink on light surfaces, low-contrast
      // and faintly cool/lavender per SPLINE-UI-REFERENCE §1-2). Elevation
      // reads "lighter = higher": bg (page base) is the softest gray, bg-2
      // (floating toolbar / popovers / tooltips) is the lightest, muted is a
      // slightly-recessed input/hover fill. The SEMANTIC hues keep their
      // MEANING (green=accent, amber=warn, red=error/record) but darkened so
      // they clear WCAG-AA as text AND SC 1.4.11 3:1 as the focus ring / fill
      // knockout on a LIGHT background — a neon dark-mode hue lands ~1.3:1 on
      // light (see contrastMatrix.test.ts). The channel hues (ch-*) are NOT
      // touched: they paint the timeline 2D canvas, audited against that
      // surface's own dark CANVAS_BG (TimelineCanvas.tsx), insulated from the
      // chrome palette. Mirror EVERY change in contrastMatrix.test.ts TOKEN
      // (the F2 drift gate asserts they match).
      colors: {
        bg: '#ececf2',
        'bg-1': '#f3f3f8',
        'bg-2': '#fafafc',
        fg: '#141419',
        'fg-dim': '#54555f',
        'fg-mute': '#9a9ba6',
        muted: '#e6e6ee',
        border: '#d6d6e0',
        'border-strong': '#bcbdc9',
        accent: {
          DEFAULT: '#134f27',
          dim: '#104a24',
        },
        warn: '#664400',
        error: '#c01f2b',
        record: '#cc2222',
        'ch-x': '#f06464',
        'ch-y': '#64f08c',
        'ch-z': '#6496f0',
        'ch-w': '#c896f0',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Geist Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
