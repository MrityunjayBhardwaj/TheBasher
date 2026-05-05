import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0a',
        fg: '#e5e5e5',
        muted: '#1a1a1a',
        border: '#262626',
        accent: {
          DEFAULT: '#5af07a',
          dim: '#3fa055',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Geist Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
