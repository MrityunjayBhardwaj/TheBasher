// useProposal — the read-only hooks every editor uses to mark a pending proposal (#1706).
//
// Each reads the diff store and answers from `proposalLines`; none writes anything. A proposal is
// "pending" only while the store's status is `pending`: after Accept the store keeps the diff with
// status `applied`, and that must mark nothing.
//
// REF: src/agent/diff/proposalLines.ts; src/agent/diff/store.ts.

import { useMemo } from 'react';
import type { NodeId } from '../../core/dag/types';
import { useDiffStore, type PendingDiff } from './store';
import {
  proposalLines,
  proposalTabCounts,
  proposedChange,
  proposedNodeIds,
  type DrawerMarkTab,
  type MarkEditor,
  type ProposalLine,
} from './proposalLines';

/** The diff while it waits for Accept / Reject, else null. */
export function usePendingProposal(): PendingDiff | null {
  return useDiffStore((s) => (s.status === 'pending' ? s.pendingDiff : null));
}

/** One line per op of the pending proposal (empty when none). */
export function useProposalLines(): ProposalLine[] {
  const diff = usePendingProposal();
  return useMemo(() => (diff ? proposalLines(diff) : []), [diff]);
}

/**
 * A node's — or one of its params' — value before and after the pending proposal, or null when no
 * ticked op of the proposal touches it.
 */
export function useProposedChange(
  nodeId: NodeId | null | undefined,
  param?: string,
): { before: unknown; after: unknown } | null {
  const diff = usePendingProposal();
  return useMemo(
    () => (diff && nodeId ? proposedChange(diff, nodeId, param) : null),
    [diff, nodeId, param],
  );
}

const EMPTY = new Set<NodeId>();

/** The nodes the pending proposal marks in one editor (ticked ops only). */
export function useProposedNodeIds(editor: MarkEditor): ReadonlySet<NodeId> {
  const diff = usePendingProposal();
  return useMemo(() => (diff ? proposedNodeIds(diff, editor) : EMPTY), [diff, editor]);
}

/** How many ticked changes each drawer tab marks. */
export function useProposalTabCounts(): Partial<Record<DrawerMarkTab, number>> {
  const diff = usePendingProposal();
  return useMemo(() => (diff ? proposalTabCounts(diff) : {}), [diff]);
}
