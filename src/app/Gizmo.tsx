// TransformControls gizmo — bound to the currently-selected node.
//
// Binding modes (P2.6 generalization):
//   - Transform / BoxMesh / GltfAsset / Lights / Cameras: any node whose
//     params expose a `position` vec3 gets a translate gizmo at that
//     position. The gizmo emits setParam Ops on every objectChange.
//     Rotate writes to params.rotation when present. Scale writes to
//     params.scale when present, falling back to params.size for nodes
//     where the geometry IS the scale (BoxMesh).
//   - Character: gizmo position seeds from the upstream LocomotionState;
//     on drag END, the macro `buildWalkToOps` emits an atomic chain that
//     walks the character to the new position. Per-frame setParam isn't
//     right for Character — Character has no `position` param; position
//     is a derivation of (path, time, speed). Emitting walkTo on
//     drag-end matches the click-to-move UX exactly.
//   - Anything without a position param (Scene, Group, MaterialOverride,
//     Skeleton, etc.): no gizmo (selection is conceptual).
//
// V1 stays clean: every drag emits a setParam Op through the dispatcher;
// no setState shortcuts.
//
// V8 stays clean by file location: this lives in `src/app/`, not
// `src/viewport/`. Viewport imports + mounts inside the Canvas.
//
// OrbitControls cooperation: while dragging, set `gizmoStore.dragging =
// true` so the camera orbit is suppressed. Without this, gizmo + orbit
// fire simultaneously and the user gets both rotation and translation.
//
// REF: THESIS.md §11, §15, §40; vyapti V1, V8; krama K7.

import { TransformControls } from '@react-three/drei';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDagStore } from '../core/dag/store';
import { evaluate } from '../core/dag/evaluator';
import type { Node } from '../core/dag/types';
import type { CharacterValue } from '../nodes/types';
import { buildWalkToOps } from './character/walkTo';
import { useGizmoStore, type GizmoMode } from './stores/gizmoStore';
import { useSelectionStore } from './stores/selectionStore';
import { useTimeStore } from './stores/timeStore';
import { maybeSnapVec3 } from './stores/viewportStore';

type Vec3 = [number, number, number];

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

interface Manipulable {
  position: Vec3;
  rotation: Vec3 | null;
  scale: Vec3 | null;
  /** Param path the scale handle should write to. 'scale' for nodes that
   *  declare a scale vec3; 'size' for BoxMesh-style nodes whose geometry
   *  IS the scale. null when scale should be hidden. */
  scaleParamPath: 'scale' | 'size' | null;
  scaleSeed: Vec3 | null;
}

/** Inspect a DAG node and return the params the gizmo can drive, or null
 *  when no `position` param exists (gizmo can't anchor anywhere). */
function getManipulable(node: Node | null): Manipulable | null {
  if (!node) return null;
  const p = node.params as Record<string, unknown>;
  if (!isVec3(p.position)) return null;
  const rotation = isVec3(p.rotation) ? (p.rotation as Vec3) : null;
  const explicitScale = isVec3(p.scale) ? (p.scale as Vec3) : null;
  const sizeFallback = isVec3(p.size) ? (p.size as Vec3) : null;
  const scaleParamPath: Manipulable['scaleParamPath'] = explicitScale
    ? 'scale'
    : sizeFallback
      ? 'size'
      : null;
  const scaleSeed = explicitScale ?? sizeFallback;
  return {
    position: p.position as Vec3,
    rotation,
    scale: explicitScale,
    scaleParamPath,
    scaleSeed,
  };
}

export function Gizmo() {
  const selectedId = useSelectionStore((s) => s.primaryNodeId);
  const node = useDagStore((s) => (selectedId ? s.state.nodes[selectedId] : null));
  const mode = useGizmoStore((s) => s.mode);
  const groupRef = useRef<THREE.Group>(null);
  const [ready, setReady] = useState(false);

  const isCharacter = node?.type === 'Character';
  const manip = isCharacter ? null : getManipulable(node);

  // Time is needed only for the Character path (evaluate the locomotion
  // chain). Subscribing here keeps the seeding effect in sync with the
  // playhead.
  const seconds = useTimeStore((s) => s.seconds);
  const frame = useTimeStore((s) => s.frame);
  const normalized = useTimeStore((s) => s.normalized);

  // Some node types don't have a rotation/scale param — when the user
  // is in those modes, fall back to translate so the gizmo still shows.
  // Mode coercion happens here, not in the store, so the user's chosen
  // mode is restored when they pick a node that supports it.
  const effectiveMode: GizmoMode = isCharacter
    ? 'translate'
    : !manip
      ? 'translate'
      : mode === 'rotate' && !manip.rotation
        ? 'translate'
        : mode === 'scale' && !manip.scaleParamPath
          ? 'translate'
          : mode;

  useEffect(() => {
    if (!groupRef.current || !selectedId) return;
    if (manip) {
      groupRef.current.position.set(...manip.position);
      if (manip.rotation) groupRef.current.rotation.set(...manip.rotation);
      else groupRef.current.rotation.set(0, 0, 0);
      if (manip.scaleSeed) groupRef.current.scale.set(...manip.scaleSeed);
      else groupRef.current.scale.set(1, 1, 1);
      setReady(true);
      return;
    }
    if (isCharacter) {
      const dagState = useDagStore.getState().state;
      try {
        const result = evaluate(dagState, selectedId, {
          ctx: { time: { frame, seconds, normalized } },
        });
        const v = result.value as CharacterValue;
        groupRef.current.position.set(...v.position);
        groupRef.current.rotation.set(0, v.heading, 0);
        groupRef.current.scale.set(1, 1, 1);
        setReady(true);
      } catch {
        // node missing or eval error — leave gizmo unmounted
      }
      return;
    }
    setReady(false);
  }, [manip, isCharacter, selectedId, seconds, frame, normalized]);

  if (!selectedId) return null;
  if (!isCharacter && !manip) return null;

  function onObjectChange() {
    // Character: no per-frame dispatch — walkTo fires on drag end only.
    if (isCharacter) return;
    if (!manip) return;
    const g = groupRef.current;
    if (!g || !selectedId) return;
    const liveMode = useGizmoStore.getState().mode;
    if (liveMode === 'translate') {
      const value = maybeSnapVec3([g.position.x, g.position.y, g.position.z]);
      useDagStore
        .getState()
        .dispatch(
          { type: 'setParam', nodeId: selectedId, paramPath: 'position', value },
          'user',
          'gizmo translate',
        );
      return;
    }
    if (liveMode === 'rotate') {
      if (!manip.rotation) return; // node has no rotation param — no-op
      const value: Vec3 = [g.rotation.x, g.rotation.y, g.rotation.z];
      useDagStore
        .getState()
        .dispatch(
          { type: 'setParam', nodeId: selectedId, paramPath: 'rotation', value },
          'user',
          'gizmo rotate',
        );
      return;
    }
    // scale
    if (!manip.scaleParamPath) return;
    const value: Vec3 = [g.scale.x, g.scale.y, g.scale.z];
    useDagStore
      .getState()
      .dispatch(
        { type: 'setParam', nodeId: selectedId, paramPath: manip.scaleParamPath, value },
        'user',
        `gizmo scale (${manip.scaleParamPath})`,
      );
  }

  function onDraggingChanged(dragging: boolean) {
    useGizmoStore.getState().setDragging(dragging);
    if (dragging) return; // start: nothing to dispatch
    if (!isCharacter || !selectedId || !groupRef.current) return;
    // End of drag — emit walkTo to the gizmo's current position.
    const g = groupRef.current;
    const dagState = useDagStore.getState().state;
    const target = maybeSnapVec3([g.position.x, 0, g.position.z]);
    const result = buildWalkToOps(dagState, selectedId, target);
    if (!result) return;
    useDagStore.getState().dispatchAtomic(result.ops, 'user', result.description);
  }

  return (
    <>
      <group ref={groupRef} />
      {ready && groupRef.current ? (
        <TransformControls
          object={groupRef.current}
          mode={effectiveMode}
          onObjectChange={onObjectChange}
          onMouseDown={() => onDraggingChanged(true)}
          onMouseUp={() => onDraggingChanged(false)}
        />
      ) : null}
    </>
  );
}
