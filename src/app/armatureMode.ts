// The ACTIVE armature mode — Object, Edit or Pose — answered in one place (#1335).
//
// Every surface the mode changes asks here: the armature helper (what a click on a bone picks,
// whether the rest pose is drawn), the bone selection (a bone is live only outside object mode),
// the keyboard (Tab, Ctrl+Tab) and the toolbar's mode menu. If any of them asked its own way, a
// bone could light in the viewport while the inspector said object mode.
//
// ONE CONDITION, the one `boneSelection.ts` uses: the mode is live only while its armature is the
// PRIMARY selection. Select a cube while posing a character and you are in object mode again,
// because the thing a mode belongs to is no longer the thing being worked on. Blender keeps the
// mode on the Object, so the same click leaves the armature in pose mode and the cube in object
// mode; with one primary selection the effect on screen is the same.
//
// Only an armature has these modes. Blender accepts EDIT or POSE for `OB_ARMATURE`
// (`editors/object/object_modes.cc:131-135`); here an armature is an Object whose `data` is a
// `Skeleton` node — the same structural test `rigReach` applies, read off the graph without
// evaluating it.
//
// REF: src/app/stores/armatureModeStore.ts (the raw pair); src/app/boneSelection.ts (the
//      precedent and a reader); src/viewport/ArmatureHelper.tsx; issue #1335.

import type { DagState } from '../core/dag/state';
import { useArmatureModeStore, type ArmatureMode } from './stores/armatureModeStore';
import { useDagStore } from '../core/dag/store';
import { useSelectionStore } from './stores/selectionStore';

export type { ArmatureMode };

function refNode(binding: unknown): string | null {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const node = (binding as { node?: unknown }).node;
  return typeof node === 'string' ? node : null;
}

/** Is `nodeId` an armature — an Object whose data is a Skeleton? */
export function isArmatureObject(state: DagState, nodeId: string | null): boolean {
  if (!nodeId) return false;
  const node = state.nodes[nodeId];
  if (!node || node.type !== 'Object') return false;
  const data = refNode(node.inputs.data);
  return data !== null && state.nodes[data]?.type === 'Skeleton';
}

/** The pure core — given the primary selection and the stored pair, which mode is live? */
export function armatureModeOf(
  primaryNodeId: string | null,
  stored: { nodeId: string | null; mode: ArmatureMode },
): ArmatureMode {
  if (!primaryNodeId || stored.nodeId !== primaryNodeId) return 'object';
  return stored.mode;
}

/** Imperative read (event handlers, the helper's per-frame fill). */
export function getArmatureMode(): ArmatureMode {
  return armatureModeOf(
    useSelectionStore.getState().primaryNodeId,
    useArmatureModeStore.getState(),
  );
}

/** The mode `nodeId` is in: object unless it is the armature the live mode belongs to. */
export function armatureModeFor(nodeId: string): ArmatureMode {
  const stored = useArmatureModeStore.getState();
  return stored.nodeId === nodeId ? getArmatureMode() : 'object';
}

/** Reactive read (the toolbar, the inspector). */
export function useArmatureMode(): ArmatureMode {
  const primaryNodeId = useSelectionStore((s) => s.primaryNodeId);
  const nodeId = useArmatureModeStore((s) => s.nodeId);
  const mode = useArmatureModeStore((s) => s.mode);
  return armatureModeOf(primaryNodeId, { nodeId, mode });
}

/** Whether the primary selection is an armature, i.e. whether the mode menu has anything to say. */
export function usePrimaryIsArmature(): boolean {
  const primaryNodeId = useSelectionStore((s) => s.primaryNodeId);
  return useDagStore((s) => isArmatureObject(s.state, primaryNodeId));
}

/**
 * Put the primary selection in `mode`. Refused (false) when it is not an armature and the mode is
 * not object: only an armature has Edit and Pose.
 */
export function setArmatureMode(mode: ArmatureMode): boolean {
  const primary = useSelectionStore.getState().primaryNodeId;
  if (mode === 'object') {
    useArmatureModeStore.getState().clear();
    return true;
  }
  if (!primary || !isArmatureObject(useDagStore.getState().state, primary)) return false;
  useArmatureModeStore.getState().setMode(primary, mode);
  return true;
}

/**
 * Tab and Ctrl+Tab: enter `mode`, or leave it for object mode when already in it. Blender's
 * `object.mode_set` with `toggle`. Returns false when the primary selection is not an armature,
 * so the caller can give the key its other meaning.
 */
export function toggleArmatureMode(mode: 'edit' | 'pose'): boolean {
  const primary = useSelectionStore.getState().primaryNodeId;
  if (!primary || !isArmatureObject(useDagStore.getState().state, primary)) return false;
  return setArmatureMode(getArmatureMode() === mode ? 'object' : mode);
}
