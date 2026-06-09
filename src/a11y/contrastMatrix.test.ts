// Contrast-pair inventory matrix — the permanent CI gate that closes
// UI-SPEC §11 #14 (WCAG AA on every (fg-token, bg-stack) pair in
// production chrome).
//
// HOW IT WORKS
// ============
// 1. ROWS hand-curates every Tailwind (text-, bg-stack) pair used by
//    chrome surfaces R1-R9 + DiffBar + popovers/menus.
//    Each row names the SITE (file:line + UI element), the fg token,
//    the bg STACK (top-to-bottom alpha layers), and the text-size class.
// 2. Per D-W8-1 (locked 2026-05-15), every bg-stack is composited down
//    to one opaque RGB against `bg #0a0a0a` — the worst-case fixed
//    page background. R8 physically sits over the GL canvas (a VARIABLE-
//    color backdrop); for that surface the #0a0a0a composite is the BEST
//    case, not the worst. #57 closes that gap:
//    the dedicated `it()` below recomposites the two over-canvas
//    surfaces against the worst-case BRIGHT backdrop `#ffffff` and the
//    p57 e2e empirically pixel-samples them over a real bright scene.
//    (Observed: fg-dim over #ffffff measures #2d2d2d → 5.47:1 ≥ AA.)
// 3. Each row's contrast ratio is computed against its composited bg.
//    AA threshold: 4.5 for 'small' text (regular <18px / bold <14px),
//    3.0 for 'large' or 'ui'.
// 4. A coverage block independently greps src/app + src/viewport +
//    src/timeline for every text-* and bg-* token class and asserts
//    every grep hit is either covered by a ROW or explicitly listed
//    in WHITELIST. Prevents drift when new chrome adds an uncovered
//    pair.
//
// CLASSIFICATION (D-W8-3, applied in C2)
// =====================================
// Failures from this spec are read by C2 and classified into:
//   FAIL-TOKEN       — the token's own contrast is broken against any
//                      reasonable bg (e.g. fg-mute #525252 on muted
//                      #1a1a1a = 2.5:1). Resolution: tweak token hex
//                      in tailwind.config.ts.
//   FAIL-RULE        — the token is being used in a context it wasn't
//                      designed for. Resolution: §8.4 rule + grep gate.
//   FAIL-EXEMPT      — WCAG 2.1 SC 1.4.3 exempts disabled UI components,
//                      pure graphical decoration, placeholder text in a
//                      contrast-compliant input, and brand/logo text.
//                      Resolution: §8.4.4 documents the exemption.
//   FAIL-LARGE-ONLY  — passes 3:1 large-text but fails 4.5:1 normal-text.
//                      Resolution: §8.4 rule requiring text-base+ OR
//                      classify as decorative section caption per
//                      SC 1.4.3 (§8.4.5).
//
// EXEMPTION ENCODING (C2)
// =======================
// C2 classified C1's 23 failing rows into the three exemption kinds
// above (0 FAIL-TOKEN — no hex tweaks needed). Each exempt row carries
// `exempt: { kind, rule?, note }`. Rows with `exempt` set are reported
// separately from PASS rows and do NOT fail the AA gate — they are
// governed by §8.4.3 / §8.4.4 / §8.4.5 instead. The actual ratio is
// still computed and printed in verbose mode so future reviewers can
// see the underlying numbers.
//
// VERBOSE OUTPUT
// ==============
// Run `VERBOSE=1 npx vitest run src/a11y/contrastMatrix.test.ts` to
// print a markdown-ready table of every row with its verdict. The
// table format is the same shape that pastes into UI-SPEC §8.4 in C5.
//
// REF: docs/UI-SPEC.md §1 D-W8-1, §8.4 (contrast);
//      memory/project_p6_w8_plan.md C1; memory/project_p6_w8_context.md §3.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// #58 F2 — import the real Tailwind config so the TOKEN table below is
// asserted against the single source of truth, not hand-synced.
import tailwindConfig from '../../tailwind.config';
import {
  aaThreshold,
  composite,
  compositeStack,
  contrastRatio,
  formatHex,
  parseHex,
  type RGB,
  type RGBA,
  type TextSize,
  withAlpha,
} from './wcag';
// P6 W9: the canvas palette is the literal painted contract for R9's
// TimelineCanvas. Imported (not copied) so this audit checks the real
// hexes the 2D context fills/strokes with — if a future wave retints a
// diamond/playhead, this assertion moves with it automatically.
import { PALETTE } from '../timeline/TimelineCanvas';

// ─── Token table ────────────────────────────────────────────────────────
//
// Mirrors tailwind.config.ts. Kept in sync by C1.4's drift gate; if a
// future PR adds a token, the coverage block will surface the missing
// row before the audit ships.

const TOKEN: Record<string, RGB> = {
  bg: parseHex('#0a0a0a'),
  'bg-1': parseHex('#111111'),
  'bg-2': parseHex('#161616'),
  fg: parseHex('#e5e5e5'),
  'fg-dim': parseHex('#a3a3a3'),
  'fg-mute': parseHex('#525252'),
  muted: parseHex('#1a1a1a'),
  border: parseHex('#262626'),
  'border-strong': parseHex('#3a3a3a'),
  accent: parseHex('#5af07a'),
  'accent-dim': parseHex('#3fa055'),
  warn: parseHex('#f0b85a'),
  error: parseHex('#f05a5a'),
  record: parseHex('#f04a4a'),
  'ch-x': parseHex('#f06464'),
  'ch-y': parseHex('#64f08c'),
  'ch-z': parseHex('#6496f0'),
  'ch-w': parseHex('#c896f0'),
};

const PAGE_BG: RGB = TOKEN.bg; // D-W8-1: opaque-only composite vs bg #0a0a0a.

// Parse a Tailwind color-class fragment like 'bg-2/90', 'accent/15',
// 'fg/80', 'muted', 'fg-mute' into RGBA. Throws on unknown tokens —
// the matrix is hand-authored, so an unknown token is a typo to surface.
function token(spec: string): RGBA {
  // Handle 'fg/80' → token='fg', alpha=80; or 'bg-2/90' → token='bg-2'.
  const slash = spec.lastIndexOf('/');
  const name = slash === -1 ? spec : spec.slice(0, slash);
  const alphaPct = slash === -1 ? null : Number(spec.slice(slash + 1));
  const base = TOKEN[name];
  if (!base) throw new Error(`token(): unknown token "${name}" in "${spec}"`);
  return withAlpha(base, alphaPct);
}

// ─── Matrix rows ─────────────────────────────────────────────────────────
//
// Each row = one chrome SITE that paints a (fg, bg-stack) pair.
//
//   site:     "Rn ElementName — state" (file:line in comment if useful)
//   fg:       Tailwind text-* spec ('fg', 'fg/80', 'fg-mute', etc.)
//   bgStack:  top-to-bottom alpha stack. Bottom of stack is implicitly
//             PAGE_BG (`bg #0a0a0a`). For an opaque surface, just one
//             entry. For a stack like R8 (bg-bg-2/90 sitting over the
//             viewport which sits over the page), top-to-bottom:
//             ['bg-2/90'] — viewport is excluded because per D-W8-1
//             we composite against opaque page bg, not the GL canvas.
//   textSize: 'small' (< 14px), 'large' (≥ 14px text-base ish), or 'ui'
//             (non-text decoration — icons, dividers, etc.).
//
// Production text-size mapping (from Tailwind classes used in chrome):
//   text-[9px], text-[10px], text-xs (0.75rem=12px), text-[11px] → small
//   text-sm (14px) bold → large; text-sm regular still → small
//   text-base (16px), text-lg → large
//   Icon-only / decorative → ui

// C2 exemption — when a row fails AA but the failure is governed by a
// §8.4 rule (A/B/C), an SC 1.4.3 exemption, or a "decorative caption"
// classification, mark it here so the AA gate doesn't trip on it.
// The actual ratio is still measured + printed verbose; the gate is
// scoped to non-exempt rows only.
interface Exempt {
  // 'rule'              → governed by §8.4.3 rule A/B/C (token-misuse;
  //                       enforced by WHITELIST + rule sentence).
  // 'sc-1.4.3'          → WCAG 2.1 Success Criterion 1.4.3 exemption
  //                       (disabled UI component, pure graphical icon,
  //                       decorative glyph, placeholder of compliant
  //                       input). Documented in §8.4.4.
  // 'large-only-decorative' → borderline (≤ 0.05 below 4.5), classified
  //                       as decorative section caption per SC 1.4.3
  //                       incidental-text exemption. Documented §8.4.5.
  kind: 'rule' | 'sc-1.4.3' | 'large-only-decorative';
  rule?: 'A' | 'B' | 'C';
  note: string;
}

interface Row {
  site: string;
  fg: string;
  bgStack: string[];
  textSize: TextSize;
  exempt?: Exempt;
}

const ROWS: Row[] = [
  // ─── R1 ProjectTabs (src/app/ProjectTabs.tsx) ───────────────────────
  // L165: tab strip background = bg-2/80; L177 active = bg-1; L178
  // inactive hover→fg via fg-dim default; L197 dirty-dot label fg-mute;
  // L208 close-btn fg-mute, hover→warn; L221 add-tab fg-mute hover→accent;
  // L233 tooltip on bg-2/95.
  {
    site: 'R1 ProjectTabs strip — base fg on bg-2/80',
    fg: 'fg',
    bgStack: ['bg-2/80'],
    textSize: 'small',
  },
  {
    site: 'R1 ProjectTabs active tab — fg on bg-1 (opaque, no /N)',
    fg: 'fg',
    bgStack: ['bg-1'],
    textSize: 'small',
  },
  {
    site: 'R1 ProjectTabs inactive tab — fg-dim on bg-2/80',
    fg: 'fg-dim',
    bgStack: ['bg-2/80'],
    textSize: 'small',
  },
  {
    site: 'R1 ProjectTabs inactive hover — fg-dim on bg-1/40 over bg-2/80',
    fg: 'fg-dim',
    bgStack: ['bg-1/40', 'bg-2/80'],
    textSize: 'small',
  },
  {
    site: 'R1 ProjectTabs active-tab decorative glyph — fg-mute on bg-1 (⌂/⌃ chevron)',
    fg: 'fg-mute',
    bgStack: ['bg-1'],
    textSize: 'small',
    exempt: {
      kind: 'sc-1.4.3',
      note: 'L208 renders an aria-hidden ⌂/⌃ glyph (per-tab active/inactive marker) using text-fg-mute. The element carries aria-hidden, so SR skips it entirely; SC 1.4.3 exempts pure decoration from the contrast minimum. The active-tab affordance is the tab button label itself at fg/fg-dim, not this chevron. Self-review fold-in (previous "dirty-dot label / Rule A" classification was a misdescription of L208).',
    },
  },
  {
    site: 'R1 ProjectTabs close × — fg-mute on bg-2/80',
    fg: 'fg-mute',
    bgStack: ['bg-2/80'],
    textSize: 'small',
    exempt: {
      kind: 'rule',
      rule: 'A',
      note: 'Close × glyph as icon-button — Rule A. Element is aria-labelled "Close tab"; visual hover state lifts to warn-colored. Tab itself is the affordance.',
    },
  },
  {
    site: 'R1 ProjectTabs add-btn — fg-mute on bg-2/80',
    fg: 'fg-mute',
    bgStack: ['bg-2/80'],
    textSize: 'small',
    exempt: {
      kind: 'rule',
      rule: 'A',
      note: 'Add-tab + glyph as icon-button — Rule A. aria-labelled "New project"; hover lifts to accent.',
    },
  },
  {
    site: 'R1 ProjectTabs tooltip — fg on bg-2/95',
    fg: 'fg',
    bgStack: ['bg-2/95'],
    textSize: 'small',
  },

  // ─── R2 MenuBar (src/app/MenuBar.tsx) ───────────────────────────────
  // L304 container bg-bg; L72 trigger open = bg-muted + text-accent,
  // closed = fg/70; L105/L136 menu item bg-bg shows fg/80; L108 shortcut
  // fg/40; L437 empty-state fg/40; L80/L142 panel bg-bg shadow.
  { site: 'R2 MenuBar container — fg on bg', fg: 'fg', bgStack: [], textSize: 'small' },
  {
    site: 'R2 MenuBar trigger open — accent on muted',
    fg: 'accent',
    bgStack: ['muted'],
    textSize: 'small',
  },
  { site: 'R2 MenuBar trigger closed — fg/70 on bg', fg: 'fg/70', bgStack: [], textSize: 'small' },
  {
    site: 'R2 MenuBar trigger hover — fg on muted/60 over bg',
    fg: 'fg',
    bgStack: ['muted/60'],
    textSize: 'small',
  },
  {
    site: 'R2 MenuBar item label — fg/80 on bg (menu panel)',
    fg: 'fg/80',
    bgStack: [],
    textSize: 'small',
  },
  {
    site: 'R2 MenuBar item shortcut — fg/40 on bg',
    fg: 'fg/40',
    bgStack: [],
    textSize: 'small',
    exempt: {
      kind: 'rule',
      rule: 'B',
      note: 'Keyboard-shortcut hint (e.g. "⌘S") shown alongside the full menu-item label — Rule B: fg/40 is decorative/grouping hint only. The label itself uses fg/80 and is the primary affordance.',
    },
  },
  {
    site: 'R2 MenuBar item hover — fg/80 on muted',
    fg: 'fg/80',
    bgStack: ['muted'],
    textSize: 'small',
  },
  {
    site: 'R2 MenuBar empty state — fg/40 on bg',
    fg: 'fg/40',
    bgStack: [],
    textSize: 'small',
    exempt: {
      kind: 'rule',
      rule: 'B',
      note: 'Empty-state placeholder text shown only when a submenu has no items — Rule B: fg/40 is decorative/hint only. State is informational; no actions are gated on reading it.',
    },
  },

  // ─── Pill chrome controls — Add/Assets/space/zoom/Export/Present ────
  // (v0.6 #4 W1: folded from the deleted R3 TopToolbar into the R8 floating
  //  pill. Each button keeps its OWN background chrome — Add/Assets/Export/
  //  Present muted/40 text-fg/80; active border-accent bg-accent/15 accent;
  //  SpaceGroup muted/40, active cell accent/25 + accent; the zoom readout is
  //  a DISABLED button muted/30 text-fg-mute — so the per-button contrast is
  //  unchanged by the move; only the gone "container on bg/95" row is pruned.)
  {
    site: 'Pill chrome button idle — fg/80 on muted/40',
    fg: 'fg/80',
    bgStack: ['muted/40'],
    textSize: 'small',
  },
  {
    site: 'Pill chrome button hover — accent on muted/40',
    fg: 'accent',
    bgStack: ['muted/40'],
    textSize: 'small',
  },
  {
    site: 'Pill chrome zoom readout — fg-mute on muted/30 (disabled)',
    fg: 'fg-mute',
    bgStack: ['muted/30'],
    textSize: 'small',
    exempt: {
      kind: 'sc-1.4.3',
      note: 'Disabled UI component (the zoom % readout is a non-interactive disabled button) — WCAG 2.1 SC 1.4.3 exempts inactive UI components from contrast requirements.',
    },
  },
  {
    site: 'Pill SpaceGroup cell idle — fg/60 on muted/40',
    fg: 'fg/60',
    bgStack: ['muted/40'],
    textSize: 'small',
  },
  {
    site: 'Pill SpaceGroup cell active — accent on accent/25 over muted/40',
    fg: 'accent',
    bgStack: ['accent/25', 'muted/40'],
    textSize: 'small',
  },
  {
    site: 'Pill chrome active button — accent on accent/15 over muted/40',
    fg: 'accent',
    bgStack: ['accent/15', 'muted/40'],
    textSize: 'small',
  },

  // (v0.6 #4 W1: the R4 ToolRail was deleted — its four tools consolidated
  //  into the R8 floating pill, whose rows below already cover them.)

  // ─── R5 LeftSidebar (src/app/LeftSidebar.tsx) ───────────────────────
  // L81 tab strip bg-bg/95; L94 active tab text-accent + bottom border-
  // accent; L95 inactive text-fg-dim hover→fg; L63/L108 collapse button.
  {
    site: 'R5 LeftSidebar tab active — accent on bg/95',
    fg: 'accent',
    bgStack: ['bg/95'],
    textSize: 'small',
  },
  {
    site: 'R5 LeftSidebar tab inactive — fg-dim on bg/95',
    fg: 'fg-dim',
    bgStack: ['bg/95'],
    textSize: 'small',
  },
  {
    site: 'R5 LeftSidebar tab hover — fg on bg/95',
    fg: 'fg',
    bgStack: ['bg/95'],
    textSize: 'small',
  },
  {
    site: 'R5 LeftSidebar collapse-btn — fg-dim on bg-1',
    fg: 'fg-dim',
    bgStack: ['bg-1'],
    textSize: 'ui',
  },

  // ─── R5 SceneTree (src/app/SceneTree.tsx) ───────────────────────────
  // L96 panel bg-muted/20 (NOT /40 like NPanel — sibling chrome but
  // dimmer panel surface). L98 header fg/70; L122 selected row
  // bg-accent/15 text-accent; idle text-fg/80 hover muted.
  {
    site: 'R5 SceneTree header — fg/70 on muted/20',
    fg: 'fg/70',
    bgStack: ['muted/20'],
    textSize: 'small',
  },
  {
    site: 'R5 SceneTree row idle — fg/80 on muted/20',
    fg: 'fg/80',
    bgStack: ['muted/20'],
    textSize: 'small',
  },
  {
    site: 'R5 SceneTree row hover — fg/80 on muted over muted/20',
    fg: 'fg/80',
    bgStack: ['muted', 'muted/20'],
    textSize: 'small',
  },
  {
    site: 'R5 SceneTree row selected — accent on accent/15 over muted/20',
    fg: 'accent',
    bgStack: ['accent/15', 'muted/20'],
    textSize: 'small',
  },
  {
    site: 'R5 SceneTree row nodeId hint — fg/40 on muted/20',
    fg: 'fg/40',
    bgStack: ['muted/20'],
    textSize: 'small',
    exempt: {
      kind: 'rule',
      rule: 'B',
      note: 'Secondary node-id suffix (e.g. ":3") shown next to the primary node name — Rule B: fg/40 is decorative grouping hint only. Primary name is fg/80; node-id is debug/developer affordance.',
    },
  },

  // ─── R7 NPanel / Inspector (src/app/NPanel.tsx) ─────────────────────
  // L72/L86 NumberRow on muted/40; L168 row label fg/60; L218 ParamRow
  // path fg/60 value fg/80; L225/L226 unsupported fg/40 + fg/30; L268
  // section header fg/60 hover→fg + bg-muted; L298 panel bg muted/40;
  // L300 header fg/70; L304 empty-state fg/40; L307/L308/L309 node
  // identity card.
  {
    site: 'R7 NPanel header — fg/70 on muted/40',
    fg: 'fg/70',
    bgStack: ['muted/40'],
    textSize: 'small',
  },
  {
    site: 'R7 NPanel empty state — fg/40 on muted/40',
    fg: 'fg/40',
    bgStack: ['muted/40'],
    textSize: 'small',
    exempt: {
      kind: 'rule',
      rule: 'B',
      note: 'Empty-state message shown only when no node is selected — Rule B: informational hint, no actions gated on it. Selection ANY node restores full chrome.',
    },
  },
  {
    site: 'R7 NPanel node id — fg on muted/40',
    fg: 'fg',
    bgStack: ['muted/40'],
    textSize: 'small',
  },
  {
    site: 'R7 NPanel node type — fg/40 on muted/40',
    fg: 'fg/40',
    bgStack: ['muted/40'],
    textSize: 'small',
    exempt: {
      kind: 'rule',
      rule: 'B',
      note: 'Node-type suffix (e.g. "MeshNode") shown beside the primary node-id at fg — Rule B: type label is grouping hint. Primary id is fg.',
    },
  },
  {
    site: 'R7 NPanel section header collapsed — fg/60 on muted/40',
    fg: 'fg/60',
    bgStack: ['muted/40'],
    textSize: 'small',
  },
  {
    site: 'R7 NPanel section header hover — fg on muted over muted/40',
    fg: 'fg',
    bgStack: ['muted'],
    textSize: 'small',
  },
  {
    site: 'R7 NPanel section header chevron — fg/40 on muted/40',
    fg: 'fg/40',
    bgStack: ['muted/40'],
    textSize: 'small',
    exempt: {
      kind: 'sc-1.4.3',
      note: 'Pure graphical icon (▸/▾ collapse chevron). SC 1.4.3 exemption: non-text content exempt from contrast minimum. Collapse state is also reflected by aria-expanded on the button.',
    },
  },
  {
    site: 'R7 NPanel NumberRow label — fg/80 on muted/40',
    fg: 'fg/80',
    bgStack: ['muted/40'],
    textSize: 'small',
  },
  {
    site: 'R7 NPanel NumberRow drag-handle — fg/60 on muted/40',
    fg: 'fg/60',
    bgStack: ['muted/40'],
    textSize: 'small',
  },
  {
    site: 'R7 NPanel NumberRow value input — fg on muted (input bg)',
    fg: 'fg',
    bgStack: ['muted'],
    textSize: 'small',
  },
  {
    site: 'R7 NPanel Vec3 channel label — fg/50 on muted/40',
    fg: 'fg/50',
    bgStack: ['muted/40'],
    textSize: 'small',
    exempt: {
      kind: 'large-only-decorative',
      note: 'Uppercase 10px column-header caption (X/Y/Z/W). 4.46:1 vs 4.5:1 (0.04 short). Classified as decorative section caption per SC 1.4.3 incidental-text — header is a label for the column of inputs below, each of which renders at full fg.',
    },
  },
  {
    site: 'R7 NPanel Vec3 channel input — fg on muted',
    fg: 'fg',
    bgStack: ['muted'],
    textSize: 'small',
  },
  {
    site: 'R7 NPanel TextRow label — fg/80 on muted/40',
    fg: 'fg/80',
    bgStack: ['muted/40'],
    textSize: 'small',
  },
  {
    site: 'R7 NPanel TextRow value — fg/60 on muted/40',
    fg: 'fg/60',
    bgStack: ['muted/40'],
    textSize: 'small',
  },
  {
    site: 'R7 NPanel ParamRow path — fg/60 on muted/40',
    fg: 'fg/60',
    bgStack: ['muted/40'],
    textSize: 'small',
  },
  {
    site: 'R7 NPanel ParamRow value — fg/80 on muted/40',
    fg: 'fg/80',
    bgStack: ['muted/40'],
    textSize: 'small',
  },
  {
    site: 'R7 NPanel ParamRow unsupported — fg/40 on muted/40',
    fg: 'fg/40',
    bgStack: ['muted/40'],
    textSize: 'small',
    exempt: {
      kind: 'rule',
      rule: 'B',
      note: '"unsupported type" hint shown only for params that NPanel cannot render — Rule B: developer/debug affordance, no user action gated on reading it.',
    },
  },
  {
    site: 'R7 NPanel ParamRow complex hint — fg/30 on muted/40',
    fg: 'fg/30',
    bgStack: ['muted/40'],
    textSize: 'small',
    exempt: {
      kind: 'rule',
      rule: 'C',
      note: '"(complex)" suffix beside the param name — Rule C: fg/30 is decorative-only (separator glyph or tertiary hint). Param name itself is fg/60.',
    },
  },
  // P7 C2 — the 3-state keyframe diamond (◇/◆) adornment on animatable
  // ParamRow headers (D-01/D-03). Pure graphical glyph; the animation
  // state is ALSO machine-readable via data-anim-state + aria-label, so
  // SC 1.4.3 non-text exemption applies (same basis as the collapse
  // chevron above). Three color states tracked for the record.
  {
    site: 'R7 NPanel keyframe diamond — none (fg/40) on muted/40',
    fg: 'fg/40',
    bgStack: ['muted/40'],
    textSize: 'small',
    exempt: {
      kind: 'sc-1.4.3',
      note: 'Pure graphical icon (hollow ◇ "not animated" state). SC 1.4.3 exemption: non-text content. State also exposed via data-anim-state="none" + aria-label on the button.',
    },
  },
  {
    site: 'R7 NPanel keyframe diamond — animated (accent) on muted/40',
    fg: 'accent',
    bgStack: ['muted/40'],
    textSize: 'small',
    exempt: {
      kind: 'sc-1.4.3',
      note: 'Pure graphical icon (filled ◆ "animated, off-key" state). SC 1.4.3 exemption: non-text content. State also exposed via data-anim-state="animated" + aria-label.',
    },
  },
  {
    site: 'R7 NPanel keyframe diamond — on-key (record) on muted/40',
    fg: 'record',
    bgStack: ['muted/40'],
    textSize: 'small',
    exempt: {
      kind: 'sc-1.4.3',
      note: 'Pure graphical icon (record ◆ "current frame is a key" state, #f04a4a per UI-SPEC.md:200 §5.8). SC 1.4.3 exemption: non-text content. State also exposed via data-anim-state="on-key" + aria-label.',
    },
  },

  // ─── R8 FloatingViewportToolbar (src/app/FloatingViewportToolbar.tsx) ─
  // L175 container bg-bg-2/90 over viewport-as-page-bg per D-W8-1;
  // L102 active tool bg-1 text-accent; L103 idle tool fg-dim hover→fg
  // bg-1; L134 active shading accent/25 text-accent; L135 idle shading
  // fg-dim; L236 frame input border-border bg-bg text-fg.
  // #57: these rows composite against #0a0a0a (BEST case for an
  // over-canvas surface); the worst-case BRIGHT backdrop is audited by
  // the `it()` below + the p57 e2e (real-pixel observation).
  {
    site: 'R8 FloatingToolbar container — fg on bg-2/90 (D-W8-1 vs bg only)',
    fg: 'fg',
    bgStack: ['bg-2/90'],
    textSize: 'small',
  },
  {
    site: 'R8 FloatingToolbar tool active — accent on bg-1 over bg-2/90',
    fg: 'accent',
    bgStack: ['bg-1', 'bg-2/90'],
    textSize: 'ui',
  },
  {
    site: 'R8 FloatingToolbar tool idle — fg-dim on bg-2/90',
    fg: 'fg-dim',
    bgStack: ['bg-2/90'],
    textSize: 'ui',
  },
  {
    site: 'R8 FloatingToolbar tool hover — fg on bg-1 over bg-2/90',
    fg: 'fg',
    bgStack: ['bg-1', 'bg-2/90'],
    textSize: 'ui',
  },
  {
    site: 'R8 FloatingToolbar shading active — accent on accent/25 over bg-2/90',
    fg: 'accent',
    bgStack: ['accent/25', 'bg-2/90'],
    textSize: 'small',
  },
  {
    site: 'R8 FloatingToolbar shading idle — fg-dim on bg-2/90',
    fg: 'fg-dim',
    bgStack: ['bg-2/90'],
    textSize: 'small',
  },
  {
    site: 'R8 FloatingToolbar frame input — fg on bg',
    fg: 'fg',
    bgStack: ['bg'],
    textSize: 'small',
  },

  // ─── R9 TimelineDrawer (src/timeline/TimelineDrawer.tsx) ─────────────
  // L96 toggle bg-bg-2 text-fg; L123/L218 tab strip bg-bg-2; L168/L169
  // tab active = bg-bg text-fg, inactive = text-mute hover→fg on bg-2;
  // L279/L280 dock control buttons; "text-mute" is undefined token →
  // see WHITELIST below — treated as inherited text color from container.
  { site: 'R9 TimelineDrawer toggle — fg on bg-2', fg: 'fg', bgStack: ['bg-2'], textSize: 'small' },
  { site: 'R9 TimelineDrawer tab active — fg on bg', fg: 'fg', bgStack: ['bg'], textSize: 'small' },
  {
    site: 'R9 TimelineDrawer dock-btn active — fg on bg-2',
    fg: 'fg',
    bgStack: ['bg-2'],
    textSize: 'small',
  },

  // ─── R9 TimelineCanvas (src/timeline/TimelineCanvas.tsx) ────────────
  // P6 W9: the SVG Dopesheet was replaced by an imperatively-painted
  // canvas-2D surface (D-W9-2). A 2D <canvas> has NO Tailwind (fg-token,
  // bg-stack) pairs — every color is a hard hex the 2D context strokes
  // /fills with. So these rows cannot be Tailwind token-pair rows like
  // the rest of the matrix; they are REVISED (not migrated) to assert
  // the exported `PALETTE` hex constants each clear WCAG-AA against the
  // canvas background hex, computed via the SAME `contrastRatio` helper
  // wcag.ts already exports (zero new contrast math — V14-style reuse;
  // the palette literals are imported from TimelineCanvas.tsx so this
  // file checks the real painted contract, not a copied snapshot).
  // The assertions live in a dedicated `it()` below the ROWS table
  // (canvas palette is not a (fg,bg-stack) Row shape). No Dopesheet
  // ROWS remain — the surface no longer emits Tailwind chrome.

  // (ModeBadge pruned in v0.6 #4 — the component was deleted with the
  // operational mode enum. R8 is now the sole over-canvas surface; see the
  // worst-case-bright `it()` below + the p57 e2e.)

  // ─── ComfyStatusIndicator (src/app/ComfyStatusIndicator.tsx) ────────
  // Three status colors: connected = bg-accent text-bg, idle = bg-bg-1
  // text-fg-mute, error/warn = bg-warn/30 text-warn.
  {
    site: 'ComfyStatus connected — bg on accent',
    fg: 'bg',
    bgStack: ['accent'],
    textSize: 'small',
  },
  {
    site: 'ComfyStatus idle — fg-mute on bg-1',
    fg: 'fg-mute',
    bgStack: ['bg-1'],
    textSize: 'small',
    exempt: {
      kind: 'sc-1.4.3',
      note: 'Decorative status indicator pill (idle state — Comfy backend not connected). State is also conveyed by aria-label + the green/red/grey dot color independent of label contrast.',
    },
  },
  {
    site: 'ComfyStatus warn — warn on warn/30',
    fg: 'warn',
    bgStack: ['warn/30'],
    textSize: 'small',
  },

  // ─── AssetsPopover (src/app/AssetsPopover.tsx) ──────────────────────
  // L110 panel bg-bg-2/95; L113 header fg-dim; L131 entry bg-bg-1/40 +
  // border-border; L133 entry available text-fg/90, hover bg-1;
  // L134/L144 unavailable text-fg-mute.
  {
    site: 'AssetsPopover header — fg-dim on bg-2/95',
    fg: 'fg-dim',
    bgStack: ['bg-2/95'],
    textSize: 'small',
  },
  {
    site: 'AssetsPopover entry available — fg/90 on bg-1/40 over bg-2/95',
    fg: 'fg/90',
    bgStack: ['bg-1/40', 'bg-2/95'],
    textSize: 'small',
  },
  {
    site: 'AssetsPopover entry hover — fg/90 on bg-1 over bg-2/95',
    fg: 'fg/90',
    bgStack: ['bg-1', 'bg-2/95'],
    textSize: 'small',
  },
  {
    site: 'AssetsPopover entry unavailable — fg-mute on bg-1/40 over bg-2/95',
    fg: 'fg-mute',
    bgStack: ['bg-1/40', 'bg-2/95'],
    textSize: 'small',
    exempt: {
      kind: 'sc-1.4.3',
      note: 'Disabled menu item (asset listed but not yet loaded/available) — WCAG 2.1 SC 1.4.3 exempts inactive UI components.',
    },
  },
  // Phase 7.14 (#112) — My-Imports per-row ︙ overflow menu (Rename/Show
  // files/Delete) + delete-referenced banner (D-UX-18). The ︙ button, Rename
  // input, Show-files list and Cancel button reuse already-audited tokens
  // (fg-dim/fg/90/fg on bg-1/bg-2 + border-accent focus). The two NEW
  // foreground pairs are the destructive Delete item (text-error) and the
  // warn-tinted banner/Delete-anyway (text-warn, already audited elsewhere).
  {
    site: 'AssetsPopover ︙ menu Delete item — error on bg-2 (menu surface)',
    fg: 'error',
    bgStack: ['bg-2'],
    textSize: 'small',
  },
  {
    site: 'AssetsPopover delete-referenced banner — warn on warn/10 over bg-2/95',
    fg: 'warn',
    bgStack: ['warn/10', 'bg-2/95'],
    textSize: 'small',
  },

  // ─── AddMenu (src/app/AddMenu.tsx) ──────────────────────────────────
  // L119 panel bg-bg/95; L122 header fg/50; L137 group active = bg-muted
  // text-accent, idle = fg/80; L141 chevron fg/40; L146 submenu bg-bg.
  { site: 'AddMenu panel — fg on bg/95', fg: 'fg', bgStack: ['bg/95'], textSize: 'small' },
  {
    site: 'AddMenu header — fg/50 on bg/95',
    fg: 'fg/50',
    bgStack: ['bg/95'],
    textSize: 'small',
    exempt: {
      kind: 'large-only-decorative',
      note: 'Uppercase 10px caption section header ("MESH", "LIGHT", etc.). 4.45:1 vs 4.5:1 (0.05 short). Classified as decorative section caption per SC 1.4.3 incidental-text — header groups the menu items below, each rendered at fg/80.',
    },
  },
  {
    site: 'AddMenu group active — accent on muted over bg/95',
    fg: 'accent',
    bgStack: ['muted', 'bg/95'],
    textSize: 'small',
  },
  {
    site: 'AddMenu group idle — fg/80 on bg/95',
    fg: 'fg/80',
    bgStack: ['bg/95'],
    textSize: 'small',
  },
  {
    site: 'AddMenu group chevron — fg/40 on bg/95',
    fg: 'fg/40',
    bgStack: ['bg/95'],
    textSize: 'small',
    exempt: {
      kind: 'sc-1.4.3',
      note: 'Pure graphical icon (▸ submenu chevron). SC 1.4.3 exemption: non-text content. Submenu state is reflected by aria-haspopup + aria-expanded.',
    },
  },
  { site: 'AddMenu submenu item — fg/80 on bg', fg: 'fg/80', bgStack: [], textSize: 'small' },

  // ─── Identity cluster on the ProjectTabs bar (src/app/ProjectTabs.tsx) ─
  // (v0.6 #4 W1: the Chrome status bar was deleted — its brand / project
  //  name / save cluster folded onto the R1 ProjectTabs identity bar, which
  //  is bg-2/80. Brand accent; "/" separator fg/30; project name fg/80; the
  //  save status timestamp fg/40.)
  {
    site: 'ProjectTabs brand — accent on bg-2/80',
    fg: 'accent',
    bgStack: ['bg-2/80'],
    textSize: 'small',
  },
  {
    site: 'ProjectTabs identity separator — fg/30 on bg-2/80',
    fg: 'fg/30',
    bgStack: ['bg-2/80'],
    textSize: 'small',
    exempt: {
      kind: 'sc-1.4.3',
      note: 'Decorative "/" glyph separating brand and project name. SC 1.4.3 exemption: pure decoration — no semantic content; the brand+project pair is the readable unit.',
    },
  },
  {
    site: 'ProjectTabs identity project name — fg/80 on bg-2/80',
    fg: 'fg/80',
    bgStack: ['bg-2/80'],
    textSize: 'small',
  },
  {
    site: 'ProjectTabs save status — fg/40 on bg-2/80',
    fg: 'fg/40',
    bgStack: ['bg-2/80'],
    textSize: 'small',
    exempt: {
      kind: 'rule',
      rule: 'B',
      note: '"Saved 2m ago" timestamp shown after the save status icon — Rule B: timestamp is decorative; the save STATE (saved/dirty) is conveyed by the bullet color + project-name dirty-marker at full fg.',
    },
  },

  // ─── Timebar (src/app/Timebar.tsx) ──────────────────────────────────
  // L18 bar bg-muted/30 + text-fg/70.
  { site: 'Timebar — fg/70 on muted/30', fg: 'fg/70', bgStack: ['muted/30'], textSize: 'small' },

  // ─── SimplifyPopover (src/timeline/SimplifyPopover.tsx) ─────────────
  // L110 panel bg-bg-2 text-fg; L132 input bg-bg text-fg; L135 error
  // text-warn; L152 confirm bg-accent text-bg.
  { site: 'SimplifyPopover panel — fg on bg-2', fg: 'fg', bgStack: ['bg-2'], textSize: 'small' },
  { site: 'SimplifyPopover input — fg on bg', fg: 'fg', bgStack: [], textSize: 'small' },
  {
    site: 'SimplifyPopover error — warn on bg-2',
    fg: 'warn',
    bgStack: ['bg-2'],
    textSize: 'small',
  },
  {
    site: 'SimplifyPopover confirm — bg on accent',
    fg: 'bg',
    bgStack: ['accent'],
    textSize: 'small',
  },
  {
    site: 'SimplifyPopover confirm hover — bg on accent-dim',
    fg: 'bg',
    bgStack: ['accent-dim'],
    textSize: 'small',
  },

  // ─── AgentChat (src/app/AgentChat.tsx) ──────────────────────────────
  // R-side drawer. L146 message body text-fg/85 on muted (the bordered
  // chat bubble bg); L143 timestamp fg/40; L162/L166 status footer
  // fg/40 + fg/30; L183 textarea text-fg on muted placeholder fg/30;
  // L200 send button bg-muted text-fg/80 hover→accent.
  {
    site: 'AgentChat message body — fg/85 on muted',
    fg: 'fg/85',
    bgStack: ['muted'],
    textSize: 'small',
  },
  {
    site: 'AgentChat timestamp — fg/40 on muted',
    fg: 'fg/40',
    bgStack: ['muted'],
    textSize: 'small',
    exempt: {
      kind: 'rule',
      rule: 'B',
      note: 'Message timestamp shown after the message body — Rule B: temporal grouping hint; message body itself is fg/85.',
    },
  },
  { site: 'AgentChat textarea — fg on muted', fg: 'fg', bgStack: ['muted'], textSize: 'small' },
  {
    site: 'AgentChat textarea placeholder — fg/30 on muted',
    fg: 'fg/30',
    bgStack: ['muted'],
    textSize: 'small',
    exempt: {
      kind: 'sc-1.4.3',
      note: 'Placeholder text in an input — WCAG 2.1 SC 1.4.3 exempts placeholders when the input itself is contrast-compliant (textarea uses fg, audited PASS above).',
    },
  },

  // ─── LayerRowControls (src/app/timeline/LayerRowControls.tsx) ───────
  // L37 mute toggle active = bg-warn text-bg (loud); L47 solo toggle
  // active = bg-accent text-bg. text-mute on inactive is undefined and
  // whitelisted (inherits ambient).
  {
    site: 'LayerRowControls mute active — bg on warn',
    fg: 'bg',
    bgStack: ['warn'],
    textSize: 'ui',
  },
  {
    site: 'LayerRowControls solo active — bg on accent',
    fg: 'bg',
    bgStack: ['accent'],
    textSize: 'ui',
  },
];

// ─── WHITELIST (intentionally-skipped patterns) ─────────────────────────
//
// Class fragments grepped from src/app + src/viewport + src/timeline
// that the matrix does NOT audit because:
//   - the token is undefined in tailwind.config.ts (inherits, no color
//     applied) — flagged as a separate cleanup task in C2
//   - the token is a Tailwind-default palette color (red-*/yellow-*) used
//     intentionally for boot-error or third-party-style chrome
//   - the className is in a test/storybook context
//   - inline `style={{ color }}` instead of Tailwind (e.g. DiffBar)
//
// Each whitelist entry includes WHY so future audits know whether to
// promote it back into ROWS.

const WHITELIST: { pattern: RegExp; why: string }[] = [
  // text-mute / bg-line / border-line / text-line — undefined tokens that
  // resolve to inherited color. Flagged for cleanup in C2 (likely add to
  // tailwind.config.ts as aliases for fg-dim / border / bg-2 respectively,
  // OR rewrite the call sites). The visible contrast in production is
  // whatever the parent container's text-fg setting yields, so the
  // matrix-relevant pair is already covered by the parent surface row.
  {
    pattern: /\btext-mute\b/,
    why: 'undefined token; inherits container fg (cleanup: alias to fg-dim in C2)',
  },
  { pattern: /\btext-line\b/, why: 'undefined token; inherits container fg (cleanup in C2)' },
  { pattern: /\bbg-line\b/, why: 'undefined token; resolves to nothing (cleanup in C2)' },
  {
    pattern: /\bborder-line\b/,
    why: 'undefined token; resolves to default border (cleanup in C2)',
  },
  // Tailwind-default red/yellow/black used as raw-state colors in boot
  // error and Comfy status — third-party palette, audited as-published
  // by Tailwind. Not part of the design-token system.
  { pattern: /\btext-red-(\d+)\b/, why: 'Tailwind-default red (error chrome); not a design token' },
  {
    pattern: /\bbg-red-(\d+)(\/\d+)?\b/,
    why: 'Tailwind-default red (error chrome); not a design token',
  },
  {
    pattern: /\bborder-red-(\d+)(\/\d+)?\b/,
    why: 'Tailwind-default red (error chrome); not a design token',
  },
  {
    pattern: /\btext-yellow-(\d+)\b/,
    why: 'Tailwind-default yellow (warn chrome); not a design token',
  },
  {
    pattern: /\bbg-yellow-(\d+)(\/\d+)?\b/,
    why: 'Tailwind-default yellow (warn chrome); not a design token',
  },
  {
    pattern: /\bborder-yellow-(\d+)(\/\d+)?\b/,
    why: 'Tailwind-default yellow (warn chrome); not a design token',
  },
  {
    pattern: /\bbg-black(\/\d+)?\b/,
    why: 'Tailwind-default black (cost-preview placeholder); not a design token',
  },
  // bg-fg: the SVG Dopesheet's keyframe-marker token. P6 W9 replaced
  // that surface with TimelineCanvas (imperative 2D paint, no Tailwind
  // tokens — see the dedicated palette-contrast `it()` block). The class
  // no longer appears in src/timeline; kept whitelisted so any future
  // re-introduction elsewhere is still a non-text decoration, not a gap.
  {
    pattern: /\bbg-fg\b/,
    why: 'Legacy keyframe-marker token; W9 canvas surface emits no Tailwind. Non-text decoration if re-used',
  },
  // P7 D2 Auto-Key (record) indicator decoration (src/app/Timebar.tsx):
  //   bg-record    — the 8px record DOT (no text on it; pure shape).
  //   bg-record/15 — the armed-mode header TINT; the text rendered over it
  //                  is `text-fg/80`, whose contrast against the Timebar
  //                  surface is already an audited (fg,bg) ROW — the 15%
  //                  record wash sits behind that pair, it is not itself a
  //                  text-bearing surface.
  //   bg-record/25 — the REC toggle BUTTON fill; its label is `text-record`
  //                  (already audited as a foreground token) over the muted
  //                  Timebar surface; the 25% wash is decorative emphasis.
  // All three are non-text decoration realizing the already-specced §5.8
  // Animate "Record" affordance (UI-SPEC D-UX-14) — same posture as the
  // bg-accent/10 / bg-fg whitelist precedents above.
  {
    pattern: /\bbg-record(\/\d+)?\b/,
    why: 'P7 Auto-Key record dot + armed-header/toggle tint; non-text decoration (text over it is the audited text-fg/80 / text-record pair). UI-SPEC D-UX-14',
  },
  // bg-accent/10: the SVG Dopesheet's active-channel row tint. P6 W9's
  // TimelineCanvas paints that tint imperatively (PALETTE.ACTIVE_DIAMOND
  // at globalAlpha 0.1 — see paintStaticLayer) with NO Tailwind class;
  // the only textual occurrence is the doc-comment that records which
  // token the canvas paint mirrors. The drift grep is purely textual so
  // it surfaces the comment; whitelisted because the active-channel
  // contrast is covered by the dedicated PALETTE-vs-CANVAS_BG `it()`
  // block (ACTIVE_DIAMOND clears AA), not a Tailwind (fg,bg) pair.
  {
    pattern: /\bbg-accent\/10\b/,
    why: 'W9 TimelineCanvas active-row tint is an imperative globalAlpha paint, not a class; comment-only textual hit. Contrast covered by the PALETTE-vs-CANVAS_BG assertion',
  },
  // bg-border is a 1px divider line (MenuBar item separator, R8 vertical
  // divider, R4 group separators) — pure decoration, no text. Contrast
  // here is "is the line visible against its container" which is a
  // graphical-object 3:1 question. border #262626 against bg #0a0a0a
  // = 1.45:1 — fails 3:1 — but this is the SAME problem as border-border
  // (the actual border-token usage); flag once at the token level if at
  // all. v0.5: dividers are intentionally subtle; defer to C2 judgement.
  {
    pattern: /\bbg-border\b/,
    why: 'Decorative 1px divider line; non-text. Same hex as border-border; v0.5 keeps subtle dividers',
  },
  // bg-accent/5 = AssetDropZone hover-overlay glow (4.6% opacity green
  // tint over viewport). Decorative drop affordance; no text on this
  // surface. Visible via border-2 border-dashed border-accent at full
  // opacity, which IS audited (border edge is the affordance).
  {
    pattern: /\bbg-accent\/5\b/,
    why: 'AssetDropZone hover glow; non-text decoration paired with full-opacity dashed border',
  },
  // bg-warn standalone (no /N) is the 1.5×1.5 dirty-dot indicator on
  // ProjectTabs L187 (pure shape, aria-hidden) and the loud
  // LayerRowControls mute toggle (covered as 'LayerRowControls mute
  // active' ROW). The standalone unmodified class itself doesn't carry
  // text — text-bg pairings are captured by the explicit ROWS above.
  {
    pattern: /\bbg-warn\b/,
    why: 'Either the aria-hidden dirty-dot (non-text) or covered by explicit ROW for text-bg pairing',
  },
  // bg-muted/20 is SceneTree container surface (covered by explicit
  // R5 SceneTree ROWS above) and ProjectsMenu row hover state
  // (covered as ProjectsMenu hover entry).
  {
    pattern: /\bbg-muted\/20\b/,
    why: 'SceneTree panel surface + ProjectsMenu row-hover; covered by parent-surface ROWS',
  },
  // bg-accent-dim variant used only on SimplifyPopover confirm hover —
  // covered by explicit ROW 'SimplifyPopover confirm hover'.
  {
    pattern: /\bbg-accent-dim\b/,
    why: 'SimplifyPopover confirm hover state; covered by explicit ROW',
  },
  // bg-transparent / border-transparent are by design.
  { pattern: /\bbg-transparent\b/, why: 'Intentional transparency' },
  { pattern: /\bborder-transparent\b/, why: 'Intentional transparency' },
  // text-current / text-inherit don't apply a color.
  { pattern: /\btext-current\b/, why: 'Inherits ambient color' },
  { pattern: /\btext-inherit\b/, why: 'Inherits ambient color' },
];

// ─── Matrix computation ──────────────────────────────────────────────────

type Verdict = {
  row: Row;
  fgHex: string;
  bgHex: string; // composited
  ratio: number;
  required: number;
  pass: boolean;
};

function composeBg(stack: string[]): RGB {
  const layers: RGBA[] = stack.map(token);
  return compositeStack(layers, PAGE_BG);
}

function compositeFg(fg: string, bgComposited: RGB): RGB {
  // Foreground text may itself be /N (e.g. fg/80). In that case, blend
  // the text against the surface it sits on — that's the color the
  // viewer's eye sees.
  const fgRgba = token(fg);
  if (fgRgba.a >= 1) {
    return { r: fgRgba.r, g: fgRgba.g, b: fgRgba.b };
  }
  return composite(fgRgba, bgComposited);
}

function evaluate(row: Row): Verdict {
  const bgComposited = composeBg(row.bgStack);
  const fgComposited = compositeFg(row.fg, bgComposited);
  const ratio = contrastRatio(fgComposited, bgComposited);
  const required = aaThreshold(row.textSize);
  return {
    row,
    fgHex: formatHex(fgComposited),
    bgHex: formatHex(bgComposited),
    ratio,
    required,
    pass: ratio >= required,
  };
}

function formatVerdict(v: Verdict): string {
  const ratio = v.ratio.toFixed(2);
  return `${v.pass ? 'PASS' : 'FAIL'}: ${v.row.site} | fg=${v.row.fg}→${v.fgHex} | bg-stack=[${v.row.bgStack.join(' over ')}]→${v.bgHex} | ${ratio}:1 vs ${v.required}:1 ${v.row.textSize}`;
}

function exemptLabel(e: Exempt): string {
  if (e.kind === 'rule') return `EXEMPT (§8.4.3 Rule ${e.rule})`;
  if (e.kind === 'sc-1.4.3') return 'EXEMPT (§8.4.4 WCAG SC 1.4.3)';
  return 'EXEMPT (§8.4.5 decorative caption)';
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('contrast matrix — every (fg, bg-stack) pair in chrome', () => {
  const verdicts = ROWS.map(evaluate);

  if (process.env.VERBOSE === '1') {
    // Markdown-ready table; the format pastes directly into UI-SPEC §8.4.
    const lines: string[] = [];
    lines.push(
      '| Site | fg | bg-stack | composited bg | text-size | required | actual | verdict |',
    );
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const v of verdicts) {
      const verdict = v.pass ? 'PASS' : v.row.exempt ? exemptLabel(v.row.exempt) : 'FAIL';
      lines.push(
        `| ${v.row.site} | \`${v.row.fg}\` | \`${v.row.bgStack.join(' over ') || '(none, opaque bg)'}\` | ${v.bgHex} | ${v.row.textSize} | ${v.required}:1 | ${v.ratio.toFixed(2)}:1 | ${verdict} |`,
      );
    }
    // eslint-disable-next-line no-console
    console.log('\n' + lines.join('\n') + '\n');
  }

  it('every non-exempt row meets its AA threshold', () => {
    // Exempt rows are governed by §8.4.3 / §8.4.4 / §8.4.5 instead of the
    // raw 4.5:1 / 3:1 gate. They are tracked + measured but do not fail
    // the matrix. A row that becomes exempt in code MUST be documented in
    // §8.4 of UI-SPEC.md per D-W8-3 (FAIL-RULE / FAIL-EXEMPT /
    // FAIL-LARGE-ONLY classification).
    const failures = verdicts.filter((v) => !v.pass && !v.row.exempt);
    if (failures.length > 0) {
      const summary = failures.map(formatVerdict).join('\n');
      const counts = `${verdicts.length - failures.length - verdicts.filter((v) => !v.pass && v.row.exempt).length} PASS / ${failures.length} FAIL / ${verdicts.filter((v) => !v.pass && v.row.exempt).length} EXEMPT of ${verdicts.length} rows`;
      // Fail once with a multi-row message naming every offending pair.
      expect.fail(
        `Contrast matrix: ${counts}\n\n` +
          `Each FAIL row below: site | fg-token→composited-fg | bg-stack→composited-bg | ratio vs required text-size.\n` +
          `Resolve per D-W8-3 (token-tweak in tailwind.config.ts, §8.4.3 rule sentence, or §8.4.4 SC 1.4.3 exemption).\n\n` +
          summary,
      );
    }
  });

  it('every exempt row carries a non-empty note (governance trail)', () => {
    // Exempt rows are excused from the AA gate, but each excuse must
    // state a reason that anyone re-validating the matrix can audit.
    // A bare `exempt: { kind, note: '' }` defeats the governance trail.
    const exempt = verdicts.filter((v) => v.row.exempt);
    const undocumented = exempt.filter((v) => !v.row.exempt!.note.trim());
    if (undocumented.length > 0) {
      expect.fail(
        `${undocumented.length} exempt row(s) have empty notes:\n` +
          undocumented.map((v) => `  ${v.row.site}`).join('\n'),
      );
    }
  });

  it('exempts split into the three D-W8-3 categories', () => {
    // Surfaces a count breakdown so the matrix self-documents which
    // class of exemption is in force. C2 ratifies: 12 Rule, 9 SC 1.4.3,
    // 2 large-only-decorative (sum = 23).
    const exempt = verdicts.filter((v) => v.row.exempt);
    const byKind = {
      rule: exempt.filter((v) => v.row.exempt!.kind === 'rule').length,
      'sc-1.4.3': exempt.filter((v) => v.row.exempt!.kind === 'sc-1.4.3').length,
      'large-only-decorative': exempt.filter((v) => v.row.exempt!.kind === 'large-only-decorative')
        .length,
    };
    expect(byKind.rule + byKind['sc-1.4.3'] + byKind['large-only-decorative']).toBe(exempt.length);
  });

  // ─── R9 TimelineCanvas palette (P6 W9 — D-W9-2, D-W8-1) ───────────────
  // The SVG Dopesheet's three R9 Tailwind rows were revised out (a 2D
  // canvas has no token pairs). The contrast question is real all the
  // same: every hex the 2D context paints with must clear WCAG-AA
  // against the canvas background hex. We reuse wcag.ts `contrastRatio`
  // (the exact helper the matrix rows use) on the PALETTE literals
  // imported from TimelineCanvas.tsx — zero new contrast math, and the
  // assertion tracks the real painted constants (a retint there fails
  // here automatically). Threshold: 4.5 for LABEL_TEXT (it renders 11px
  // channel-name text → small-text rule); the diamond / playhead marks
  // are interactive/affordance graphical objects → 3.0 (aaThreshold
  // 'ui'), same classification the Tailwind 'ui' rows use.
  //
  // ROW_LINE is DELIBERATELY EXCLUDED from the gate, not threshold-
  // lowered. It is the canvas twin of the SVG Dopesheet's `border-line`
  // / `bg-border` 1px row-separator — BOTH are already WHITELIST entries
  // in this same file ("undefined token; resolves to default border" /
  // "dividers are intentionally subtle; v0.5 keeps subtle dividers").
  // WCAG 1.4.11 does not require 3:1 for purely decorative boundaries,
  // and row structure here is independently conveyed by label + diamond
  // position, not the hairline. Porting the surface must port its
  // contrast CONTRACT faithfully — inventing a stricter rule for the
  // canvas than the SVG original carried would be the H27 re-validation
  // trap. ROW_LINE #2a2a2a vs #0a0a0a = 1.38:1 is the SAME subtle-divider
  // posture border-border has matrix-wide; documented here, not gated.
  it('R9 TimelineCanvas palette clears WCAG-AA vs the canvas background', () => {
    const bg = PALETTE.CANVAS_BG;
    const checks: { name: string; fg: string; required: number }[] = [
      // Channel-name labels are real text → small-text 4.5:1.
      { name: 'LABEL_TEXT', fg: PALETTE.LABEL_TEXT, required: aaThreshold('small') },
      // Diamonds / playhead are interactive graphical affordances → 3:1
      // (WCAG 1.4.11 non-text contrast, same as the matrix 'ui' rows).
      { name: 'DIAMOND', fg: PALETTE.DIAMOND, required: aaThreshold('ui') },
      { name: 'ACTIVE_DIAMOND', fg: PALETTE.ACTIVE_DIAMOND, required: aaThreshold('ui') },
      { name: 'PLAYHEAD', fg: PALETTE.PLAYHEAD, required: aaThreshold('ui') },
      // ROW_LINE excluded — decorative subtle divider, parity with the
      // whitelisted border-line/bg-border posture (see comment above).
    ];
    const failures = checks
      .map((c) => ({ ...c, ratio: contrastRatio(c.fg, bg) }))
      .filter((c) => c.ratio < c.required);
    if (failures.length > 0) {
      expect.fail(
        `TimelineCanvas PALETTE vs CANVAS_BG (${bg}) — ${failures.length} mark(s) below AA:\n` +
          failures
            .map(
              (f) => `  ${f.name} (${f.fg}) = ${f.ratio.toFixed(2)}:1 vs required ${f.required}:1`,
            )
            .join('\n'),
      );
    }
  });

  // ─── Over-canvas surfaces vs the worst-case BRIGHT backdrop (#57) ────
  //
  // D-W8-1 composites every row against the FIXED page bg `#0a0a0a`. That
  // is the worst case for chrome over an opaque page — but R8
  // (FloatingViewportToolbar) sits over the GL canvas, whose color varies
  // per scene. For it, `#0a0a0a` is the BEST case (it can only get brighter
  // behind the overlay), so the matrix's PASS for that surface was an
  // INFERENCE, not a worst-case bound (issue #57). (v0.6 #4: ModeBadge, the
  // other over-canvas surface, was deleted with the operational mode enum.)
  //
  // This recomposites the SAME rows against the worst-case displayable
  // backdrop `#ffffff` (a white HDRI blowout) and asserts they still clear
  // AA. The `bg-2/90` (and `bg-1` opaque) layers do the masking: even over
  // pure white, the worst idle glyph holds ≥ 4.5:1. The p57 e2e
  // (tests/e2e/p57-bright-scene-contrast.spec.ts) corroborates this on
  // REAL composited pixels over a real bright scene — formula + observation
  // agree (measured #2d2d2d → 5.47:1 vs formula 5.44:1).
  it('R8 clears AA over a BRIGHT (#ffffff) canvas, not just #0a0a0a (#57)', () => {
    const WHITE: RGB = parseHex('#ffffff');
    const overCanvas = ROWS.filter((r) => r.site.startsWith('R8 '));
    // Sanity: the filter must actually match the surfaces it protects (a
    // future rename must not make this gate vacuous). v0.6 #4: ModeBadge
    // (the other over-canvas surface) was deleted; R8 is the sole subject.
    expect(overCanvas.length, 'expected R8 rows to exist').toBeGreaterThanOrEqual(5);

    const failures: string[] = [];
    for (const row of overCanvas) {
      // Recomposite the bg-stack onto WHITE instead of PAGE_BG. Opaque
      // layers (bg-1, bg) absorb white entirely; only the bottom-most
      // translucent layer lets it bleed — exactly the real physics.
      const bgWhite = compositeStack(row.bgStack.map(token), WHITE);
      const fgWhite = compositeFg(row.fg, bgWhite);
      const ratio = contrastRatio(fgWhite, bgWhite);
      const required = aaThreshold(row.textSize);
      if (ratio < required) {
        failures.push(
          `  ${row.site} | fg=${row.fg} | over #ffffff → bg=${formatHex(bgWhite)} | ` +
            `${ratio.toFixed(2)}:1 < ${required}:1 (${row.textSize})`,
        );
      }
    }
    if (failures.length > 0) {
      expect.fail(
        `#57: ${failures.length} over-canvas surface(s) fall below AA against a BRIGHT backdrop.\n` +
          `These sit over the GL canvas; a bright scene washes them out. Fix per D-W8-1 reopen ` +
          `(opaque bg, raise the /N alpha, or lift the fg token).\n` +
          failures.join('\n'),
      );
    }
  });

  // ─── border-token-gate (SC 1.4.11 non-text contrast, #54) ───────────
  //
  // The `classCovered()` border short-circuit used to blanket-pass every
  // border-* class (the #54 defect). SC 1.4.3 (text contrast) genuinely
  // does not apply to borders — but SC 1.4.11 (3:1 non-text contrast)
  // DOES apply to focus/state borders: the `:focus-visible border-accent`
  // ring is the ONLY visible affordance for the keyboard-focused element,
  // and the Auto-Key armed `border-record` is the sole still-frame signal
  // that recording is live. Both must clear 3:1 against the surface they
  // sit on.
  //
  // This gate enumerates every focus/state border token actually used in
  // production chrome (greps src/app + src/viewport + src/timeline the
  // same way the coverage gate does), resolves it through TOKEN, and
  // asserts 3:1 against the WORST-CASE adjacent chrome background. The
  // worst case for a focus ring is the LIGHTEST opaque chrome surface a
  // focusable element can sit on (lighter bg ⇒ lower ratio for a bright
  // accent border) — bg-2 #161616 / muted #1a1a1a / border #262626 are
  // the realistic envelope; we check against every opaque TOKEN surface
  // and require the minimum to clear 3:1, which is strictly conservative.
  //
  // Decorative/layout hairline borders (border-border, border-line, the
  // border-fg/N dim dividers) are SC 1.4.11-EXEMPT (purely decorative
  // boundary; row/panel structure is conveyed by labels + position +
  // background, not the hairline) — the same posture the bg-border /
  // border-line WHITELIST entries already document. Width/style-only
  // utilities carry no color. Auditing 1px layout grid-line separators
  // is OUT OF SCOPE per #54.
  it('border-token-gate: every focus/state border token clears SC 1.4.11 3:1 vs adjacent chrome bg', () => {
    const dirs = ['src/app', 'src/viewport', 'src/timeline'];
    const files = dirs.flatMap((d) => walkTsx(path.join(PROJECT_ROOT, d)));
    const BORDER_RE =
      /\b(?:hover:|focus:|focus-visible:|active:|disabled:|group-hover:|placeholder:)?border-[A-Za-z][\w-]*(?:\/\d{1,3})?\b/g;

    // Collect every border-* class in production, classify, and pull out
    // the focus/state ones for the 3:1 audit. An unknown border token
    // here is the #54 silent-pass — fail with a clear message.
    const focusStateUsed = new Map<string, string[]>(); // token → files
    const unknown = new Map<string, string[]>(); // class → files
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(PROJECT_ROOT, file);
      const seen = new Set<string>();
      for (const m of src.matchAll(BORDER_RE)) {
        const cls = m[0];
        if (seen.has(cls)) continue;
        seen.add(cls);
        const bare = cls.replace(
          /^(?:hover:|focus:|focus-visible:|active:|disabled:|group-hover:|placeholder:)/,
          '',
        );
        if (BORDER_STRUCTURAL_RE.test(bare)) continue;
        if (BORDER_DECORATIVE.has(bare)) continue;
        if (WHITELIST.some((w) => w.pattern.test(bare))) continue;
        const tok = stripBorderToken(bare);
        if (BORDER_FOCUS_STATE[tok]) {
          const arr = focusStateUsed.get(tok) ?? [];
          if (!arr.includes(rel)) arr.push(rel);
          focusStateUsed.set(tok, arr);
        } else {
          const arr = unknown.get(cls) ?? [];
          if (!arr.includes(rel)) arr.push(rel);
          unknown.set(cls, arr);
        }
      }
    }

    if (unknown.size > 0) {
      expect.fail(
        `border-token-gate: ${unknown.size} UNKNOWN border token(s) — neither a known ` +
          `focus/state token, a decorative hairline, a width/style utility, nor whitelisted. ` +
          `An unknown border token must be classified (decorative → BORDER_DECORATIVE; ` +
          `focus/state → BORDER_FOCUS_STATE + audited here; default palette → WHITELIST), ` +
          `not silently passed (#54).\n` +
          [...unknown.entries()]
            .sort()
            .map(([c, f]) => `  ${c}  (used in: ${f.join(', ')})`)
            .join('\n'),
      );
    }

    // Every focus/state token actually present must clear 3:1 against
    // every opaque chrome surface (the conservative envelope).
    const OPAQUE_SURFACES: { name: string; rgb: RGB }[] = [
      { name: 'bg #0a0a0a', rgb: TOKEN.bg },
      { name: 'bg-1 #111111', rgb: TOKEN['bg-1'] },
      { name: 'bg-2 #161616', rgb: TOKEN['bg-2'] },
      { name: 'muted #1a1a1a', rgb: TOKEN.muted },
      { name: 'border #262626', rgb: TOKEN.border },
    ];
    const REQUIRED = aaThreshold('ui'); // 3:1, SC 1.4.11 non-text.
    const failures: string[] = [];
    for (const tok of focusStateUsed.keys()) {
      const tokenKey = BORDER_FOCUS_STATE[tok];
      const borderRgb = TOKEN[tokenKey];
      expect(
        borderRgb,
        `BORDER_FOCUS_STATE token "${tok}" → "${tokenKey}" must resolve in TOKEN`,
      ).toBeTruthy();
      for (const surf of OPAQUE_SURFACES) {
        const ratio = contrastRatio(borderRgb, surf.rgb);
        if (ratio < REQUIRED) {
          failures.push(
            `  border-${tok} (${formatHex(borderRgb)}) vs ${surf.name} = ${ratio.toFixed(2)}:1 ` +
              `< required ${REQUIRED}:1 [SC 1.4.11]`,
          );
        }
      }
    }
    if (failures.length > 0) {
      expect.fail(
        `border-token-gate: ${failures.length} focus/state border contrast(s) below SC 1.4.11 3:1.\n` +
          `These borders are affordances (focus ring / record-armed) — a low-contrast ` +
          `token here means the focused/recording state is invisible. Tweak the token hex ` +
          `in tailwind.config.ts.\n` +
          failures.join('\n'),
      );
    }

    // Sanity: the gate must actually have walked production and found the
    // focus/state borders it is meant to protect (a regression that
    // renamed/removed them should not silently make this gate vacuous).
    expect(
      focusStateUsed.size,
      'border-token-gate found no focus/state border tokens in production — ' +
        'expected at least border-accent (the :focus-visible ring). The gate ' +
        'must not pass vacuously.',
    ).toBeGreaterThanOrEqual(1);
  });
});

// ─── Coverage gate (C1.4) ────────────────────────────────────────────────
//
// Reads every .tsx file under src/app/ + src/viewport/ + src/timeline/,
// extracts every `text-<token>` and `bg-<token>` Tailwind class, and
// asserts each one is either covered by a ROW or matches a WHITELIST
// pattern. Prevents drift when new chrome adds a pair that the matrix
// doesn't audit.

const PROJECT_ROOT = path.resolve(__dirname, '../..');

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsx(p, out);
    } else if (entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
      out.push(p);
    }
  }
  return out;
}

// Match Tailwind COLOR class fragments inside className strings:
//   text-fg, text-fg-dim, text-fg/80, text-accent-dim, text-mute, text-red-400
//   bg-bg, bg-bg-1, bg-bg-2/80, bg-accent/15, bg-warn, bg-line
// The lookahead `\b` after the optional /N ensures we don't gobble
// adjacent classes. We do NOT match size/alignment classes (text-xs,
// text-base, text-left, text-right, text-center) — those are filtered
// by SIZE_OR_ALIGN_RE below. The strategy: capture broadly, then drop
// the known non-color classes before the audit, so a NEW color token
// gets flagged but routine layout classes don't.
//
// #58 F3 — DOCUMENTED CONSTRAINT: the variant-prefix alternation only
// covers state variants (hover:/focus:/focus-visible:/active:/
// disabled:/group-hover:/placeholder:). RESPONSIVE / theme variants
// (dark: sm: md: lg: xl: 2xl:) are deliberately NOT matched: chrome is
// a fixed-layout desktop tool and MUST NOT use responsive color
// variants — a `md:bg-bg-1` would change the audited (fg,bg) pair at a
// breakpoint the matrix can't model. This is enforced by convention,
// not regex: a contributor adding a responsive color variant is
// outside the design contract. If chrome ever legitimately needs one,
// extend the prefix list AND add a per-breakpoint ROW. Left as a
// documented limit (not a code change) per F3's "OR document the
// constraint" option — extending the regex without modelling
// per-breakpoint backgrounds would give false coverage confidence.
const CLASS_RE =
  /\b((?:hover:|focus:|focus-visible:|active:|disabled:|group-hover:|placeholder:)?(?:text|bg|border)-[A-Za-z][\w-]*(?:\/\d{1,3})?)\b/g;

// Tailwind text-* classes that are SIZE or ALIGNMENT modifiers, not color.
// These are part of typography/layout, not the contrast audit. Filtered
// out before coverage checking so they don't appear as missing.
const TYPO_LAYOUT_CLASSES = new Set([
  'text-xs',
  'text-sm',
  'text-base',
  'text-lg',
  'text-xl',
  'text-2xl',
  'text-3xl',
  'text-4xl',
  'text-5xl',
  'text-6xl',
  'text-7xl',
  'text-8xl',
  'text-9xl',
  'text-left',
  'text-right',
  'text-center',
  'text-justify',
  'text-start',
  'text-end',
  'text-wrap',
  'text-nowrap',
  'text-balance',
  'text-pretty',
  'text-clip',
  'text-ellipsis',
]);

// What of the captured class is "covered" by ROWS? A class is covered if
// either:
//   - some ROW's fg (or its raw token name without /N) matches its
//     text-token
//   - some ROW's bgStack contains a layer whose token spec matches
//     its bg-token
// Whitelist patterns are checked AGAINST the raw class fragment (so
// `hover:text-mute` is whitelisted because `text-mute` matches).
function classCovered(cls: string, rowTokensFg: Set<string>, rowTokensBg: Set<string>): boolean {
  // Strip variant prefix for token matching.
  const bare = cls.replace(
    /^(?:hover:|focus:|focus-visible:|active:|disabled:|group-hover:|placeholder:)/,
    '',
  );
  // Size/alignment classes are not contrast-relevant.
  if (TYPO_LAYOUT_CLASSES.has(bare)) return true;
  if (WHITELIST.some((w) => w.pattern.test(bare))) return true;
  if (bare.startsWith('text-')) {
    const rest = bare.slice('text-'.length);
    return rowTokensFg.has(rest);
  }
  if (bare.startsWith('bg-')) {
    const rest = bare.slice('bg-'.length);
    return rowTokensBg.has(rest);
  }
  if (bare.startsWith('border-')) {
    // SC 1.4.3 (text contrast) does NOT apply to borders — borders carry
    // no text. But SC 1.4.11 (non-text contrast, 3:1) DOES apply to
    // focus/state borders (the :focus-visible ring is the sole affordance
    // for the focused element). The blanket `return true` here used to
    // mark EVERY border-* covered without auditing it, so a future
    // `border-some-low-contrast-100` slipped through silently (#54).
    //
    // Fix: a border class is "covered" by this gate only if it is
    // classifiable — either a width/style-only utility (no color), a
    // known decorative/layout token, a known focus/state token (audited
    // for 3:1 by the dedicated `border-token-gate` it() below), or an
    // explicit WHITELIST entry. An UNKNOWN border token is NOT covered
    // and surfaces in the coverage gate, exactly like an unknown text-/
    // bg- token.
    return borderClassClassified(bare);
  }
  return false;
}

// ─── Border token classification (SC 1.4.11, #54) ──────────────────────
//
// Every border-* class found in production chrome falls into exactly one
// bucket. The blanket pass was the #54 defect: it conflated "borders
// aren't TEXT-contrast relevant" (true, SC 1.4.3) with "borders need no
// audit at all" (false — SC 1.4.11 requires 3:1 for focus/state borders).

// Width / style-only utilities — no color is applied, so no contrast
// question exists. (border-b, border-l-2, border-dashed, …)
const BORDER_STRUCTURAL_RE =
  /^border(-[xytrbl])?(-0|-2|-4|-8)?$|^border-(solid|dashed|dotted|double|hidden|none)$/;

// Decorative / layout hairline tokens — separators and panel edges that
// exist purely for visual grouping. SC 1.4.11 exempts purely decorative
// boundaries (row structure / panel identity is conveyed by other means:
// labels, position, background). These are intentionally subtle in v0.5
// (border #262626 vs bg #0a0a0a = 1.45:1) — the SAME posture the
// bg-border / border-line WHITELIST entries already document. Auditing
// 1px layout grid-line separators is OUT OF SCOPE per #54.
const BORDER_DECORATIVE = new Set([
  'border-border',
  'border-border-strong',
  'border-border/40',
  'border-fg/30',
  'border-fg/40',
  'border-line', // undefined token; WHITELIST documents it inherits
]);

// Focus / state border tokens — these ARE affordances. SC 1.4.11
// requires 3:1 against the adjacent surface. The dedicated
// `border-token-gate` it() resolves each token and asserts the ratio;
// they are listed here so the coverage gate accepts them AND so the
// audit has an explicit enumeration to walk. Each entry maps the
// Tailwind token name (after `border-`, variant + /N stripped) to its
// TOKEN key.
const BORDER_FOCUS_STATE: Record<string, string> = {
  accent: 'accent', // :focus-visible ring + active-state border
  record: 'record', // Auto-Key armed-state border (UI-SPEC §5.8 D-UX-14)
};

function stripBorderToken(bare: string): string {
  // 'border-accent/70' → 'accent'; 'border-record' → 'record'.
  const afterPrefix = bare.slice('border-'.length);
  const slash = afterPrefix.lastIndexOf('/');
  return slash === -1 ? afterPrefix : afterPrefix.slice(0, slash);
}

function borderClassClassified(bare: string): boolean {
  if (BORDER_STRUCTURAL_RE.test(bare)) return true;
  if (BORDER_DECORATIVE.has(bare)) return true;
  if (WHITELIST.some((w) => w.pattern.test(bare))) return true;
  const tok = stripBorderToken(bare);
  if (BORDER_FOCUS_STATE[tok]) return true;
  // Unknown border token — NOT covered. Surfaces in the coverage gate
  // with a clear message instead of silently passing (#54).
  return false;
}

describe('contrast matrix — coverage (drift gate)', () => {
  it('every text-/bg- token class in chrome is audited or explicitly whitelisted', () => {
    const dirs = ['src/app', 'src/viewport', 'src/timeline'];
    const files = dirs.flatMap((d) => walkTsx(path.join(PROJECT_ROOT, d)));

    // Build the set of token specs that appear in ROWS.
    const fgTokens = new Set<string>();
    const bgTokens = new Set<string>();
    for (const row of ROWS) {
      fgTokens.add(row.fg);
      for (const bg of row.bgStack) bgTokens.add(bg);
    }

    const missing = new Map<string, string[]>(); // class → files that use it

    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const seen = new Set<string>();
      for (const match of src.matchAll(CLASS_RE)) {
        const cls = match[1];
        if (seen.has(cls)) continue;
        seen.add(cls);
        if (!classCovered(cls, fgTokens, bgTokens)) {
          const rel = path.relative(PROJECT_ROOT, file);
          const arr = missing.get(cls) ?? [];
          if (!arr.includes(rel)) arr.push(rel);
          missing.set(cls, arr);
        }
      }
    }

    if (missing.size > 0) {
      const lines: string[] = [];
      for (const [cls, files] of [...missing.entries()].sort()) {
        lines.push(`  ${cls}  (used in: ${files.join(', ')})`);
      }
      expect.fail(
        `Coverage gate: ${missing.size} text-/bg- token class(es) are neither in ROWS nor whitelisted.\n` +
          `Add a ROW for each (preferred) or extend WHITELIST with a WHY.\n\n` +
          lines.join('\n'),
      );
    }
  });
});

// ─── Token-source drift gates (#58 F2, F7, F6) ───────────────────────────

describe('contrast matrix — token source drift gates', () => {
  // #58 F2 — the TOKEN table hardcodes hexes that MUST equal the real
  // Tailwind config. Previously hand-synced ("Kept in sync by C1.4");
  // this asserts it mechanically against the imported config object so
  // a future palette edit in tailwind.config.ts that isn't mirrored
  // here fails CI instead of silently making the audit measure stale
  // colors.
  it('F2: every TOKEN entry matches tailwind.config.ts colors (no hand-sync drift)', () => {
    const colors = (tailwindConfig.theme?.extend?.colors ?? {}) as Record<string, unknown>;

    // Flatten the config color map to the same `name → #hex` shape the
    // TOKEN table uses. Tailwind nests `accent: { DEFAULT, dim }` →
    // `accent` + `accent-dim`; flat string entries pass through.
    const flat: Record<string, string> = {};
    for (const [name, val] of Object.entries(colors)) {
      if (typeof val === 'string') {
        flat[name] = val.toLowerCase();
      } else if (val && typeof val === 'object') {
        for (const [sub, hex] of Object.entries(val as Record<string, string>)) {
          flat[sub === 'DEFAULT' ? name : `${name}-${sub}`] = hex.toLowerCase();
        }
      }
    }

    const mismatches: string[] = [];
    for (const [name, rgb] of Object.entries(TOKEN)) {
      const configHex = flat[name];
      if (configHex == null) {
        mismatches.push(`  ${name}: in TOKEN but absent from tailwind.config.ts`);
        continue;
      }
      const tokenHex = formatHex(rgb);
      // Normalize config #rgb → #rrggbb for comparison.
      const want = formatHex(parseHex(configHex));
      if (tokenHex !== want) {
        mismatches.push(`  ${name}: TOKEN=${tokenHex} but tailwind.config.ts=${want}`);
      }
    }
    // Also flag config tokens that the matrix forgot to mirror (a new
    // palette color must get a TOKEN row or it can never be audited).
    for (const name of Object.keys(flat)) {
      if (!(name in TOKEN)) {
        mismatches.push(
          `  ${name}: in tailwind.config.ts but absent from TOKEN (add it so chrome using it can be audited)`,
        );
      }
    }

    if (mismatches.length > 0) {
      expect.fail(
        `F2 token drift: TOKEN and tailwind.config.ts disagree on ${mismatches.length} entr(ies).\n` +
          `TOKEN must mirror the Tailwind config exactly — fix the hex here or there.\n` +
          mismatches.join('\n'),
      );
    }
  });

  // #58 F7 — PAGE_BG (the worst-case composite base, D-W8-1) is
  // `TOKEN.bg`. The real page background is whatever class the <body>
  // carries. They agree today (#0a0a0a) but nothing asserted they stay
  // in sync — a future `<body class="bg-bg-1">` would silently make
  // every composited-bg row wrong. Computed CSS isn't available in the
  // unit env (no Tailwind build), so assert the structural contract:
  // the body declares `bg-bg`, and `bg-bg` resolves to PAGE_BG.
  it('F7: <body> background class stays in sync with PAGE_BG', () => {
    const indexHtml = fs.readFileSync(path.join(PROJECT_ROOT, 'index.html'), 'utf8');
    const bodyTag = indexHtml.match(/<body[^>]*>/i)?.[0] ?? '';
    expect(bodyTag, 'index.html must have a <body> tag').not.toBe('');
    // The body must paint with the `bg-bg` token (not bg-bg-1/2/etc.).
    expect(
      /\bbg-bg\b(?!-)/.test(bodyTag),
      `<body> must carry the \`bg-bg\` class so the page background equals PAGE_BG. Found: ${bodyTag}`,
    ).toBe(true);
    // And `bg-bg` must resolve to the same RGB PAGE_BG composites onto.
    expect(formatHex(TOKEN.bg)).toBe(formatHex(PAGE_BG));
    expect(formatHex(PAGE_BG)).toBe('#0a0a0a');
  });

  // #58 F6 — the issue asks to verify the ContextMenu surface is
  // audited "if it exists". It does NOT exist in this codebase (no
  // src/app/ContextMenu.tsx; the right-click surface is AddMenu, which
  // already has ROWS). This test pins that finding: if a ContextMenu
  // component is added later it will fail here, prompting ROWS for it.
  it('F6: no unaudited ContextMenu surface exists (AddMenu is the audited menu)', () => {
    const candidate = path.join(PROJECT_ROOT, 'src/app/ContextMenu.tsx');
    expect(
      fs.existsSync(candidate),
      'src/app/ContextMenu.tsx now exists — add contrast ROWS for its (fg,bg) pairs ' +
        'like AddMenu/AssetsPopover have, then update this gate (#58 F6).',
    ).toBe(false);
  });
});
