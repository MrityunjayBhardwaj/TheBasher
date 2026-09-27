// optionsSelectRows — what a picker over live options DRAWS, as data (#1064).
//
// ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────────────────
//
// A native <select> whose value matches none of its options shows its FIRST option, and a
// React controlled `value` does not change that. Two pickers in this product did it, read off
// the live DOM: Light Studio's switcher showed "Profile 1" for a profile that was gone, and the
// node-reference picker showed "— none —" for a Track-To aimed at a deleted node. The JSX read
// `value={stored}` in both, so nothing in the source looked wrong.
//
// The fix is a row list in which the stored value ALWAYS has a row: when no option carries it,
// a stale row does, marked as not found. It is pure so the rule can be pinned without a DOM;
// `OptionsSelect` only renders it.

import type { ParamOption } from '../nodes/paramWidget';

export interface OptionRow {
  readonly key: string;
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  /** The stored value, which no option offers. */
  readonly stale: boolean;
}

export interface OptionsSelectModel {
  readonly rows: readonly OptionRow[];
  /** True when the stored value is shown through a stale row. */
  readonly stale: boolean;
}

/**
 * The rows for a picker holding `stored`, over `options`.
 *
 * - A **stale** row comes first when `stored` is not empty and no option carries it. It is
 *   disabled: it is there to be seen, not chosen.
 * - A **none** row, value `""`, labelled by `noneLabel` — unless an option already carries
 *   `""`. Then that option IS what `""` selects, and a second row with the same value would
 *   claim a "none" the param cannot express.
 * - Then every option, a disabled one labelled with its reason.
 */
export function optionsSelectRows(
  stored: string,
  options: readonly ParamOption[],
  noneLabel: string,
  staleLabel: (value: string) => string = (v) => `${v} — not found`,
): OptionsSelectModel {
  const rows: OptionRow[] = [];
  const stale = stored !== '' && !options.some((o) => o.value === stored);
  if (stale) {
    rows.push({ key: 'stale', value: stored, label: staleLabel(stored), disabled: true, stale });
  }
  if (!options.some((o) => o.value === '')) {
    rows.push({ key: 'none', value: '', label: noneLabel, disabled: false, stale: false });
  }
  options.forEach((o, i) => {
    rows.push({
      key: `option-${i}`,
      value: o.value,
      label: o.disabledReason === undefined ? o.label : `${o.label} — ${o.disabledReason}`,
      disabled: o.disabledReason !== undefined,
      stale: false,
    });
  });
  return { rows, stale };
}
