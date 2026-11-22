// #1935 — which viewport toolbar groups sit inline and which live in the ⋯ menu.
//
// The decided board (editor design v1, `Main.jpg`) keeps the everyday groups in the pill —
// select/move/rotate/scale, + Add, the shading pills (Studio / Wire / Rendered) and Camera view —
// and puts the less-used ones (assets, space, play, framing, pivot, orientation, snap, timeline,
// render/export/present) behind a ⋯ button at its end.
//
// Inline is a wish, not a promise: the pill sits in the clear band between the side islands and
// that band can be narrower than the everyday groups (the chat column and both open panels leave
// ~310 px at 1280). So the inline groups are fitted to the MEASURED width, and whatever does not
// fit goes into ⋯ too. Nothing is ever clipped or scrolled out of reach: a control is either in
// the pill or in the menu.
//
// This file holds only the decision (pure, unit-tested). FloatingViewportToolbar measures the
// widths with a ResizeObserver and renders the answer.

export type ToolbarGroupId =
  | 'tools'
  | 'add'
  | 'armature'
  | 'shading'
  | 'camera'
  | 'assets'
  | 'space'
  | 'play'
  | 'view'
  | 'pivot'
  | 'orientation'
  | 'snap'
  | 'timeline'
  | 'output';

export interface ToolbarGroupDef {
  readonly id: ToolbarGroupId;
  /** The heading the group carries inside the ⋯ menu. */
  readonly label: string;
  /** `inline`: shown in the pill while it fits. `menu`: always in ⋯. */
  readonly placement: 'inline' | 'menu';
  /** Inline groups only — lower stays longer when space runs out. */
  readonly keep?: number;
}

/** Every toolbar group, in display order (pill left → right, then menu top → bottom). */
export const TOOLBAR_GROUPS: readonly ToolbarGroupDef[] = [
  { id: 'tools', label: 'Tools', placement: 'inline', keep: 0 },
  { id: 'add', label: 'Create', placement: 'inline', keep: 1 },
  // #1335 — contextual: only present while an armature is the primary selection.
  { id: 'armature', label: 'Armature', placement: 'inline', keep: 4 },
  { id: 'shading', label: 'Shading', placement: 'inline', keep: 2 },
  { id: 'camera', label: 'Camera', placement: 'inline', keep: 3 },
  { id: 'assets', label: 'Assets', placement: 'menu' },
  { id: 'space', label: 'Space', placement: 'menu' },
  { id: 'play', label: 'Playback', placement: 'menu' },
  { id: 'view', label: 'View', placement: 'menu' },
  { id: 'pivot', label: 'Pivot', placement: 'menu' },
  { id: 'orientation', label: 'Orientation', placement: 'menu' },
  { id: 'snap', label: 'Snap', placement: 'menu' },
  { id: 'timeline', label: 'Timeline', placement: 'menu' },
  { id: 'output', label: 'Output', placement: 'menu' },
];

export interface FitCandidate {
  readonly id: string;
  /** The group's rendered width in px (its leading divider included). */
  readonly width: number;
  readonly keep: number;
}

export interface FitInput {
  /** The inline candidates, in display order. */
  readonly candidates: readonly FitCandidate[];
  /** Width the pill's content may take, px (band width minus the pill's padding + border). */
  readonly available: number;
  /** The flex gap between the pill's children, px. */
  readonly gap: number;
  /** The ⋯ button's width (its divider included), px. */
  readonly moreWidth: number;
  /** True when the ⋯ button shows regardless (menu-only groups exist). */
  readonly alwaysMore: boolean;
}

export interface FitResult {
  /** Candidate ids that stay in the pill, display order. */
  readonly inline: string[];
  /** Candidate ids that go into ⋯, display order. */
  readonly overflow: string[];
}

/** Total content width of a pill holding `widths` plus (when `more`) the ⋯ button. */
function rowWidth(
  widths: readonly number[],
  more: boolean,
  gap: number,
  moreWidth: number,
): number {
  const items = widths.length + (more ? 1 : 0);
  const sum = widths.reduce((a, b) => a + b, 0) + (more ? moreWidth : 0);
  return sum + Math.max(0, items - 1) * gap;
}

/**
 * Keep as many inline candidates as fit `available`, dropping the lowest-priority one (highest
 * `keep`; on a tie, the later one) until the row fits. Once anything is dropped the ⋯ button
 * shows, and its width counts against the row.
 */
export function fitToolbar(input: FitInput): FitResult {
  const { candidates, available, gap, moreWidth, alwaysMore } = input;
  const kept = candidates.map((c, index) => ({ ...c, index }));
  const dropped = new Set<string>();
  const fits = (): boolean =>
    rowWidth(
      kept.map((c) => c.width),
      alwaysMore || dropped.size > 0,
      gap,
      moreWidth,
    ) <= available;
  while (kept.length > 0 && !fits()) {
    let victim = 0;
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i]!;
      const b = kept[victim]!;
      if (a.keep > b.keep || (a.keep === b.keep && a.index > b.index)) victim = i;
    }
    dropped.add(kept[victim]!.id);
    kept.splice(victim, 1);
  }
  return {
    inline: candidates.filter((c) => !dropped.has(c.id)).map((c) => c.id),
    overflow: candidates.filter((c) => dropped.has(c.id)).map((c) => c.id),
  };
}
