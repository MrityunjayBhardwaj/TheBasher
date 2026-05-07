// Agent diff barrel.

export {
  useDiffStore,
  acceptSelectedOps,
  rejectDiff,
  type PendingDiff,
  type DiffStatus,
} from './store';
export { createFork, cloneState } from './forkedDag';
export type { ForkResult } from './forkedDag';
export {
  ClosurePreservationError,
  expandClosure,
  isFreshAddNode,
  opTargetNodeId,
} from '../closure/expand';
export type { ClosureSet, ClosureSpec, EdgeKind, ClosureEdge } from '../closure/types';
