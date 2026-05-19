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
      colors: {
        bg: '#0a0a0a',
        'bg-1': '#111111',
        'bg-2': '#161616',
        fg: '#e5e5e5',
        'fg-dim': '#a3a3a3',
        'fg-mute': '#525252',
        muted: '#1a1a1a',
        border: '#262626',
        'border-strong': '#3a3a3a',
        accent: {
          DEFAULT: '#5af07a',
          dim: '#3fa055',
        },
        warn: '#f0b85a',
        error: '#f05a5a',
        record: '#f04a4a',
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
