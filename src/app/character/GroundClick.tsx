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
import { maybeSnapVec3 } from '../stores/viewportStore';
import { buildWalkToOps } from './walkTo';

function hasCharacter(state: ReturnType<typeof useDagStore.getState>['state']): boolean {
  for (const node of Object.values(state.nodes)) {
    if (node.type === 'Character') return true;
  }
  return false;
}

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
  // Mount the ground-click plane only when at least one Character lives in
  // the DAG. This keeps the canonical default project's rasterized output
  // unchanged (acceptance #7 PostFx pixel-diff stays bit-exact for the
  // P0/P1 baseline) and makes click-to-move appear precisely when a
  // character exists for it to drive. Subscribing via useDagStore re-runs
  // when the DAG mutates.
  const present = useDagStore((s) => hasCharacter(s.state));
  if (!present) return null;
  return (
    <mesh
      // No data-testid — R3F's reconciler routes this prop to THREE.Mesh
      // which throws on unknown DOM-style attributes. E2E tests drive the
      // walkTo macro through `__basher_dag.dispatchAtomic` directly (the
      // canonical H3 lesson: bypass headless-Chromium pointer events for
      // anything inside the Canvas).
      userData={{ basherTestid: 'ground-click' }}
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
        const target = maybeSnapVec3([point.x, 0, point.z]);
        const result = buildWalkToOps(dagState, characterId, target);
        if (!result) return;
        useDagStore.getState().dispatchAtomic(result.ops, 'user', result.description);
      }}
    >
      <planeGeometry args={[halfSize[0] * 2, halfSize[1] * 2]} />
      {/* Fully transparent so click-pickup works but no pixels are drawn. */}
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}
