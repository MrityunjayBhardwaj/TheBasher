// InspectorProposed — the inspector's marks for a pending proposal (#1706).
//
// Two read-only marks, both from the same lines the chat lists:
//   - `InspectorProposed`, under the node's header: every change the proposal makes to the selected
//     node (or its data half — a cube's size is the cube's), each `param  old → new`. It is the
//     inspector's mark for every row, including the rows other components draw (the transform
//     stack, the material editor), which it does not reach into.
//   - `ProposedValueMark`, under one param row: `old → new` for that param, amber, the old struck.
//
// Neither writes anything: no op, no driver, no store but the diff store read.
//
// REF: src/agent/diff/proposalLines.ts; src/agent/diff/useProposal.ts; src/app/NPanel.tsx.

import { formatValue, objectOf } from '../agent/diff/proposalLines';
import { usePendingProposal, useProposalLines, useProposedChange } from '../agent/diff/useProposal';
import { PROPOSAL_AMBER } from './proposalStyle';

export function InspectorProposed({ nodeId }: { nodeId: string }) {
  const diff = usePendingProposal();
  const lines = useProposalLines();
  if (!diff) return null;
  const mine = lines.filter((l) => {
    if (!diff.selected[l.opIndex] || !l.marks.includes('inspector')) return false;
    const id = l.target.nodeId;
    return id === nodeId || (id !== null && objectOf(diff.originalState, id) === nodeId);
  });
  if (mine.length === 0) return null;
  return (
    <div
      data-testid="inspector-proposed"
      className="mx-2 my-1.5 rounded border px-2 py-1 text-[11px]"
      style={{ borderColor: `${PROPOSAL_AMBER}66`, background: `${PROPOSAL_AMBER}12` }}
    >
      <div className="mb-0.5 font-semibold" style={{ color: PROPOSAL_AMBER }}>
        Proposed · not applied
      </div>
      {mine.map((l) => (
        <div key={l.opIndex} className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate text-fg">{l.label.split(' › ').pop()}</span>
          {l.before !== undefined ? (
            <s className="font-mono tabular-nums text-fg-dim">{l.before}</s>
          ) : null}
          {l.after !== undefined ? (
            <span className="font-mono tabular-nums" style={{ color: PROPOSAL_AMBER }}>
              → {l.after}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ProposedValueMark({ nodeId, paramPath }: { nodeId: string; paramPath: string }) {
  const change = useProposedChange(nodeId, paramPath);
  if (!change) return null;
  return (
    <div
      data-testid="inspector-row-proposed"
      data-param={paramPath}
      className="mx-3 mb-1 flex items-baseline gap-1.5 border-l-2 pl-2 text-[10px]"
      style={{ borderColor: PROPOSAL_AMBER }}
    >
      <span className="text-fg-dim">proposed</span>
      <s className="font-mono tabular-nums text-fg-dim">{formatValue(change.before)}</s>
      <span className="font-mono tabular-nums" style={{ color: PROPOSAL_AMBER }}>
        → {formatValue(change.after)}
      </span>
    </div>
  );
}
