// The ACTIVE bone — the one datum the highlight and the inspector have to agree
// on (#973).
//
// Two surfaces read it: the armature helper, which draws the selected bone in a
// second colour, and the inspector, which names it and its chain. If either
// asked its own way they would sooner or later disagree — the highlight on one
// bone and the name of another is worse than no highlight at all, because it
// answers the director's question with a lie rather than with silence.
//
// ONE CONDITION, and it is not the obvious one. The pair is not re-resolved
// against the DAG. A bone as DRAWN comes from the live three.js tree, whose
// names are sanitised differently from the DAG projection's — `mixamorigHips`
// against `mixamorig_Hips` — so "look the name up in the skeleton param" would
// have to re-run that reconciliation, and a second implementation of it is
// exactly what silently broke the reference rig in #977. What is checked here is
// the thing that actually goes stale in practice: that the rig whose bone is
// selected is still the PRIMARY object selection. Select a cube while a bone was
// selected and the bone selection stops being live, the same rule
// `curvePointSelection` applies to a control point.
//
// The other staleness — the rig itself being swapped or reloaded under a stable
// node id — is cleared at the source: the helper drops the bone selection when
// its armature scan signature changes, which is the same signal it already uses
// to know the set of bones changed.
//
// REF: src/app/stores/boneSelectionStore.ts (the raw triple);
//      src/app/curvePointSelection.ts (the precedent this mirrors);
//      src/viewport/ArmatureHelper.tsx (both the writer and the highlight);
//      issue #973.

import { useBoneSelectionStore } from './stores/boneSelectionStore';
import { useSelectionStore } from './stores/selectionStore';

export interface ActiveBone {
  readonly nodeId: string;
  readonly boneName: string;
  /** Root first, the selected bone last. */
  readonly chain: readonly string[];
}

/** The pure core — given the two states, is there a live bone selection? */
function activeBone(
  primaryNodeId: string | null,
  selection: { nodeId: string | null; boneName: string | null; chain: readonly string[] },
): ActiveBone | null {
  if (!primaryNodeId || selection.nodeId !== primaryNodeId) return null;
  if (!selection.boneName) return null;
  return { nodeId: selection.nodeId, boneName: selection.boneName, chain: selection.chain };
}

/** Imperative read (the helper's per-frame fill — no React context in useFrame). */
export function getActiveBone(): ActiveBone | null {
  const sel = useBoneSelectionStore.getState();
  return activeBone(useSelectionStore.getState().primaryNodeId, sel);
}

/** Reactive read (the inspector). */
export function useActiveBone(): ActiveBone | null {
  const primaryNodeId = useSelectionStore((s) => s.primaryNodeId);
  const nodeId = useBoneSelectionStore((s) => s.nodeId);
  const boneName = useBoneSelectionStore((s) => s.boneName);
  const chain = useBoneSelectionStore((s) => s.chain);
  return activeBone(primaryNodeId, { nodeId, boneName, chain });
}

export { activeBone };
