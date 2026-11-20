// ProposalCard — the agent's pending proposal as a change list in the chat column (#1706).
//
// The user's call (2026-10-20 design review, board 10; issue #1706): a proposal lands where it
// takes effect. The chat lists one line per change (`Cube › position  0, 0, 0 → 2, 0, 0`), each
// with a checkbox bound to the diff's own per-op `selected[]`; clicking a line opens the editor it
// lands in. Accept / Reject sit under the list and REPLACE the separate diff bar, which used to be
// mounted inside the 3D slot — so in the 2D View, the Spreadsheet or any other space a pending
// proposal could be neither seen nor accepted. The chat column is on screen in every space (only
// present mode hides it), so this is the one accept surface, reachable from all of them.
//
// Accept is the store's `acceptSelectedOps` — ONE `dispatchAtomic`, so one ⌘Z undoes the whole
// proposal (a partial accept is relabelled `(partial)` there). Nothing here re-implements it.
//
// The warnings, scope and time-range rows are the old diff bar's, from the same helpers.
//
// REF: src/agent/diff/proposalLines.ts; src/agent/diff/store.ts; src/app/DiffBar.helpers.ts;
// src/app/goToProposal.ts; #327 (an accept surface must be reachable, not just visible).

import { useState } from 'react';
import { acceptSelectedOps, useDiffStore } from '../agent/diff';
import type { ProposalLine } from '../agent/diff/proposalLines';
import {
  useProposalLines,
  useProposalTabCounts,
  usePendingProposal,
} from '../agent/diff/useProposal';
import { useDagStore } from '../core/dag/store';
import type { Reportable } from '../core/dag/ops';
import { badgeLabel } from './badges';
import { countBySource, extractTimeRange, formatTimeRange } from './DiffBar.helpers';
import { goToProposalLine } from './goToProposal';
import { useIsNarrowLayout } from './hooks/useIsNarrowLayout';

/** The proposal amber (the design's "previewing, not applied" colour). */
export const PROPOSAL_AMBER = '#e8a33d';

const TAB_LABEL = {
  dopesheet: 'Dopesheet',
  curve: 'Curves',
  nla: 'NLA',
  nodes: 'Nodes',
  shots: 'Shots',
} as const;

export function ProposalCard() {
  const isNarrow = useIsNarrowLayout();
  const diff = usePendingProposal();
  const lines = useProposalLines();
  const tabCounts = useProposalTabCounts();
  const toggleOp = useDiffStore((s) => s.toggleOp);
  const selectAll = useDiffStore((s) => s.selectAll);
  const reject = useDiffStore((s) => s.reject);
  const [accepting, setAccepting] = useState(false);

  if (!diff) return null;

  const total = diff.ops.length;
  const selectedCount = diff.selected.filter(Boolean).length;
  const sourceCounts = countBySource(diff.opSources, total);
  const closureNodeCount = diff.closure?.nodes.size ?? 0;
  const closureRoots = diff.closure?.spec.rootSelectors ?? [];
  const warnings = diff.warnings ?? [];
  // #423 — per-op REPORTABLE no-ops (a write the target's schema stripped), named by the badge
  // registry so the label lives in one place.
  const reportableLines = (diff.reportable ?? [])
    .filter((r): r is Reportable => r !== null)
    .map((r) => badgeLabel(r.badge, r));
  const timeRange = extractTimeRange(diff.ops);

  const handleAccept = () => {
    setAccepting(true);
    try {
      const dag = useDagStore.getState();
      acceptSelectedOps(dag.dispatchAtomic.bind(dag));
    } finally {
      setAccepting(false);
    }
  };

  return (
    <section
      data-testid="proposal-card"
      aria-label="Proposed change"
      className="mx-2 mb-2 flex max-h-[60%] shrink-0 flex-col overflow-hidden rounded-lg border bg-bg-2 text-[11px] text-fg"
      style={{ borderColor: `${PROPOSAL_AMBER}66` }}
    >
      <header
        className="flex items-center gap-2 border-b px-2.5 py-1.5"
        style={{ borderColor: `${PROPOSAL_AMBER}33` }}
      >
        <span className="font-semibold" style={{ color: PROPOSAL_AMBER }}>
          Proposed · {total} change{total === 1 ? '' : 's'}
        </span>
        <span className="flex-1" />
        <span data-testid="proposal-tab-counts" className="flex gap-2 text-fg-dim">
          {(Object.keys(TAB_LABEL) as (keyof typeof TAB_LABEL)[])
            .filter((t) => tabCounts[t])
            .map((t) => (
              <span key={t}>
                {TAB_LABEL[t]} {tabCounts[t]}
              </span>
            ))}
        </span>
      </header>

      {/* #1612 — what the proposal does in plain words; the tools behind it are on hover. */}
      <div
        data-testid="proposal-description"
        className="truncate px-2.5 pt-1.5 text-fg-dim"
        title={sourceCounts
          .map((s) => `${s.source.replace(/^agent:/, '')} ×${s.count}`)
          .join(' · ')}
      >
        {diff.description}
      </div>

      <ul className="min-h-0 flex-1 overflow-auto px-1.5 py-1" aria-label="Changes">
        {lines.map((line) => (
          <ProposalLineRow
            key={line.opIndex}
            line={line}
            checked={diff.selected[line.opIndex]}
            onToggle={() => toggleOp(line.opIndex)}
            onGo={() => goToProposalLine(line, { isNarrow })}
          />
        ))}
      </ul>

      {closureNodeCount > 0 || timeRange || warnings.length > 0 || reportableLines.length > 0 ? (
        <div className="flex flex-col gap-0.5 border-t border-border px-2.5 py-1 text-[10px] text-fg-dim">
          {closureNodeCount > 0 && (
            <span data-testid="proposal-closure">
              Scope: {closureNodeCount} node{closureNodeCount === 1 ? '' : 's'}
              {closureRoots.length > 0 ? ` from ${closureRoots.join(', ')}` : ''}
            </span>
          )}
          {timeRange && (
            <span data-testid="proposal-time-range">Time: {formatTimeRange(timeRange)}</span>
          )}
          {warnings.length > 0 && (
            <span data-testid="proposal-warnings" style={{ color: PROPOSAL_AMBER }}>
              ⚠ {warnings.join(' · ')}
            </span>
          )}
          {reportableLines.length > 0 && (
            <span data-testid="proposal-reportable" style={{ color: PROPOSAL_AMBER }}>
              ⚠ {reportableLines.join(' · ')}
            </span>
          )}
        </div>
      ) : null}

      <footer
        className="flex items-center gap-2 border-t px-2.5 py-1.5"
        style={{ borderColor: `${PROPOSAL_AMBER}33` }}
      >
        <button
          type="button"
          data-testid="proposal-accept"
          onClick={handleAccept}
          disabled={accepting || selectedCount === 0}
          className="rounded px-3 py-1 font-semibold disabled:opacity-40"
          style={{ background: PROPOSAL_AMBER, color: '#1a1306' }}
        >
          {accepting
            ? 'Accepting…'
            : `Accept${selectedCount < total ? ` ${selectedCount} of ${total}` : ''}`}
        </button>
        <button
          type="button"
          data-testid="proposal-reject"
          onClick={() => reject()}
          className="rounded border border-border px-3 py-1 text-fg hover:text-fg"
        >
          Reject
        </button>
        {selectedCount !== total ? (
          <button
            type="button"
            data-testid="proposal-select-all"
            onClick={() => selectAll(true)}
            className="text-fg-dim hover:text-fg"
          >
            Select all
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="text-[10px] text-fg-dim">one undo step</span>
      </footer>
    </section>
  );
}

function ProposalLineRow({
  line,
  checked,
  onToggle,
  onGo,
}: {
  line: ProposalLine;
  checked: boolean;
  onToggle: () => void;
  onGo: () => void;
}) {
  return (
    <li
      data-testid="proposal-line"
      data-op-kind={line.kind}
      data-checked={checked}
      className="flex items-start gap-1.5 rounded px-1 py-0.5 hover:bg-muted/40"
    >
      <input
        type="checkbox"
        data-testid="proposal-line-check"
        checked={checked}
        onChange={onToggle}
        aria-label={`Include: ${line.label}`}
        className="mt-0.5 shrink-0"
        style={{ accentColor: PROPOSAL_AMBER }}
      />
      <button
        type="button"
        data-testid="proposal-line-go"
        onClick={onGo}
        title={`Show in ${line.target.editor}`}
        className={`flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 text-left ${checked ? 'text-fg' : 'text-fg-dim line-through'}`}
      >
        <span className="min-w-0 break-words">{line.label}</span>
        {line.before !== undefined || line.after !== undefined ? (
          <span className="ml-auto flex shrink-0 items-baseline gap-1.5 font-mono tabular-nums">
            {line.before !== undefined ? (
              <s data-testid="proposal-line-before" className="text-fg-dim">
                {line.before}
              </s>
            ) : null}
            {line.after !== undefined ? (
              <span data-testid="proposal-line-after" style={{ color: PROPOSAL_AMBER }}>
                {line.after}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
    </li>
  );
}
