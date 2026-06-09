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
      // Spline-exact DARK palette (the "make it like Spline 3D" redesign — Wave
      // A). Reverts the W3 calm-LIGHT ramp to a near-black, ambient-lit Spline
      // shell. Elevation reads "lighter = higher": bg (#0e0e11) is the page base
      // (the ambient corner-glow is painted on top in index.css), bg-1 a slight
      // lift, bg-2 (#1c1c22) the floating panels / toolbar / popovers, muted a
      // recessed input/hover fill. The accent flips dark-green → Spline SELECTION
      // BLUE (the cursor tool, the selected outliner row, the segmented "Object"
      // snapping fill in the reference). On dark, a BRIGHT accent clears WCAG-AA
      // as TEXT on the panels AND ≥3:1 as the focus ring; filled accent buttons
      // knock out with `text-bg` (near-black) which reads on the bright blue —
      // the auto-invert mechanism is the same as W3, just flipped polarity
      // (V36). The channel hues (ch-*) are NOT touched: they paint the timeline
      // 2D canvas, audited against that surface's own dark CANVAS_BG, insulated
      // from the chrome palette. Mirror EVERY change in contrastMatrix.test.ts
      // TOKEN (the F2 drift gate asserts they match).
      colors: {
        bg: '#0e0e11',
        'bg-1': '#16161a',
        'bg-2': '#1c1c22',
        fg: '#ededf2',
        'fg-dim': '#9b9ca6',
        'fg-mute': '#65656f',
        muted: '#22222a',
        border: '#2a2a33',
        'border-strong': '#3a3a46',
        accent: {
          DEFAULT: '#5c9dff',
          dim: '#4d8ef0',
        },
        warn: '#e0a83a',
        error: '#f0556a',
        record: '#ff4d4d',
        'ch-x': '#f06464',
        'ch-y': '#64f08c',
        'ch-z': '#6496f0',
        'ch-w': '#c896f0',
      },
      fontFamily: {
        // Spline uses a clean UI sans, not a monospace. We self-host nothing new
        // here (THESIS §48 — no CDN): a system-sans stack renders SF Pro on
        // macOS / Segoe on Windows / Roboto on Linux — clean and Spline-adjacent.
        // `mono` is repointed to the SAME sans stack so the ~17 existing
        // `font-mono` chrome classes flip to sans globally without a rename
        // churn this wave (token name is legacy; a later cleanup renames the
        // class). A true `mono` is kept available for genuinely numeric/code UI.
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;
