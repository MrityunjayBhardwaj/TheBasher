// OptionsSelect — the ONE picker over live options (#1064).
//
// Draws `optionsSelectRows`, so a stored value no option offers is shown as not found instead
// of as the first option. Commits through the caller, which owns what a choice writes (a raw
// string, a `{node}` ref). `data-stale` marks the not-found state for anything reading the DOM.

import type { ParamOption } from '../nodes/paramWidget';
import { optionsSelectRows } from './optionsSelectRows';

const SELECT_CLASS =
  'max-w-[60%] rounded border border-border bg-bg-2 px-1 py-0.5 font-mono text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

export function OptionsSelect({
  testid,
  value,
  options,
  noneLabel,
  staleLabel,
  onCommit,
}: {
  testid: string;
  /** The stored value, `""` for none. */
  value: string;
  options: readonly ParamOption[];
  /** Null when the param cannot be empty: no none row is offered. */
  noneLabel: string | null;
  staleLabel?: (value: string) => string;
  onCommit: (value: string) => void;
}) {
  const { rows, stale } = optionsSelectRows(value, options, noneLabel, staleLabel);
  return (
    <select
      value={value}
      data-testid={testid}
      data-stale={stale ? 'true' : undefined}
      aria-invalid={stale || undefined}
      className={SELECT_CLASS}
      onChange={(e) => onCommit(e.target.value)}
    >
      {rows.map((r) => (
        <option key={r.key} value={r.value} disabled={r.disabled}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
