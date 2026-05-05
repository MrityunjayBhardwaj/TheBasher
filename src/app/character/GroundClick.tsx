// GroundClick — invisible R3F mesh that captures pointer-down events on
// the navmesh ground plane and routes them through `character.walkTo`.
//
// File-rooted V8: this component lives in `src/app/`, not `src/viewport/`,
// so its `dispatch(...)` is allowed even though it renders inside the
// Canvas. Imports from src/app are the established escape hatch (see
// AssetDropZone, Gizmo).
//
// Gizmo precedence: when a Transform is selected and the gizmo is active,
// click-to-move is suppressed. Rule: only fire when no node is selected.
// Cleanest precedence — the user explicitly deselects to walk the
// character; selection means manipulation, not navigation.
//
// REF: THESIS.md §40, vyapti V1, V8, krama K7.

import type { ThreeEvent } from '@react-three/fiber';
import { useDagStore } from '../../core/dag/store';
import type { NodeId } from '../../core/dag/types';
import { useSelectionStore } from '../stores/selectionStore';
import { buildWalkToOps } from './walkTo';

interface GroundClickProps {
  /** Half-extents of the click-capture plane. Should match the navmesh's. */
  halfSize?: readonly [number, number];
}

function findFirstCharacterId(): NodeId | null {
  const state = useDagStore.getState().state;
  for (const [id, node] of Object.entries(state.nodes)) {
    if (node.type === 'Character') return id;
  }
  return null;
}

export function GroundClick({ halfSize = [10, 10] }: GroundClickProps) {
  return (
    <mesh
      data-testid="ground-click"
      rotation={[-Math.PI / 2, 0, 0]}
      onPointerDown={(e: ThreeEvent<PointerEvent>) => {
        // Gizmo precedence: don't intercept while a node is selected
        // (Transform-controls owns its drag; selection-aware UIs are
        // adjacent to the gizmo, not competing).
        if (useSelectionStore.getState().selectedNodeId !== null) return;
        const characterId = findFirstCharacterId();
        if (!characterId) return;
        // Stop the event so OrbitControls / fallthrough handlers don't
        // also act on this click. ThreeEvent has both event and native
        // propagation channels.
        e.stopPropagation();
        const point = e.point;
        const dagState = useDagStore.getState().state;
        const result = buildWalkToOps(dagState, characterId, [point.x, 0, point.z]);
        if (!result) return;
        useDagStore.getState().dispatchAtomic(result.ops, 'user', result.description);
      }}
    >
      <planeGeometry args={[halfSize[0] * 2, halfSize[1] * 2]} />
      {/* visible: false keeps the plane interaction-only — no pixels */}
      <meshBasicMaterial visible={false} />
    </mesh>
  );
}
