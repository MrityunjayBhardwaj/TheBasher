// ProposalViewportEdge — the 3D viewport's "this is a preview" mark while a proposal waits (#1706).
//
// The issue's call: until accepted, the viewport shows the result with an amber edge. The ghost of
// the proposed scene (DiffOverlay) draws inside the canvas; this frames the slot and says, in one
// line, that what you see is not applied. It takes no pointer events, so the viewport under it
// stays fully usable, and it sits in the 3D slot, so it hides with it in the other spaces (where
// the chat's change list is the mark).
//
// REF: src/viewport/DiffOverlay.tsx; src/app/ProposalCard.tsx.

import { usePendingProposal } from '../agent/diff/useProposal';
import { PROPOSAL_AMBER } from './ProposalCard';

export function ProposalViewportEdge() {
  const diff = usePendingProposal();
  if (!diff) return null;
  return (
    <div
      data-testid="proposal-viewport-edge"
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: 14, boxShadow: `inset 0 0 0 2px ${PROPOSAL_AMBER}` }}
    >
      <span
        className="absolute bottom-16 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-0.5 text-[11px]"
        style={{
          background: 'rgba(20, 16, 8, 0.85)',
          color: PROPOSAL_AMBER,
          border: `1px solid ${PROPOSAL_AMBER}66`,
        }}
      >
        Previewing the proposed change · not applied until you accept it
      </span>
    </div>
  );
}
