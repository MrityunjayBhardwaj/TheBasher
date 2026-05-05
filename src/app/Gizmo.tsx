// TransformControls gizmo — bound to the currently-selected node.
//
// Two binding modes (P2):
//   - Transform node selected: live setParam Ops on every objectChange,
//     same path as P1.
//   - Character node selected: gizmo position seeds from the upstream
//     LocomotionState; on drag END (mouseup / dragging-changed → false),
//     the macro `buildWalkToOps` emits an atomic chain that walks the
//     character to the new position. Per-frame setParam isn't right for
//     Character — Character has no `position` param; position is a
//     derivation of (path, time, speed). Emitting walkTo on drag-end
//     matches the click-to-move UX exactly.
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
import type { CharacterValue } from '../nodes/types';
import type { TransformParams } from '../nodes/Transform';
import { buildWalkToOps } from './character/walkTo';
import { useGizmoStore } from './stores/gizmoStore';
import { useSelectionStore } from './stores/selectionStore';
import { useTimeStore } from './stores/timeStore';
import { maybeSnapVec3 } from './stores/viewportStore';

export function Gizmo() {
  const selectedId = useSelectionStore((s) => s.primaryNodeId);
  const node = useDagStore((s) => (selectedId ? s.state.nodes[selectedId] : null));
  const mode = useGizmoStore((s) => s.mode);
  const groupRef = useRef<THREE.Group>(null);
  const [ready, setReady] = useState(false);

  const isTransform = node?.type === 'Transform';
  const isCharacter = node?.type === 'Character';
  const params = isTransform ? (node!.params as TransformParams) : null;

  // Seed the proxy group from the underlying node's position.
  //   - Transform: read params (cheap).
  //   - Character: evaluate the node at the current scrub time and read
  //     CharacterValue.position (the derivation chain's output).
  const seconds = useTimeStore((s) => s.seconds);
  const frame = useTimeStore((s) => s.frame);
  const normalized = useTimeStore((s) => s.normalized);

  useEffect(() => {
    if (!groupRef.current || !selectedId) return;
    if (isTransform && params) {
      groupRef.current.position.set(...params.position);
      groupRef.current.rotation.set(...params.rotation);
      groupRef.current.scale.set(...params.scale);
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
  }, [isTransform, isCharacter, params, selectedId, seconds, frame, normalized]);

  if ((!isTransform && !isCharacter) || !selectedId) return null;

  function onObjectChange() {
    // Transform: per-frame setParam (P1 behavior). Character: no-op while
    // dragging — we only emit walkTo on drag end.
    if (!isTransform) return;
    const g = groupRef.current;
    if (!g || !selectedId) return;
    const mode = useGizmoStore.getState().mode;
    const paramPath = mode === 'translate' ? 'position' : mode === 'rotate' ? 'rotation' : 'scale';
    // Snap applies to translation only — rotation + scale stay continuous in
    // v0.5 (NEXT_SESSION.md decision default).
    const value =
      mode === 'translate'
        ? maybeSnapVec3([g.position.x, g.position.y, g.position.z])
        : mode === 'rotate'
          ? [g.rotation.x, g.rotation.y, g.rotation.z]
          : [g.scale.x, g.scale.y, g.scale.z];
    useDagStore
      .getState()
      .dispatch(
        { type: 'setParam', nodeId: selectedId, paramPath, value },
        'user',
        `gizmo ${mode}`,
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

  // drei's TransformControls forwards a `dragging-changed` event from
  // the underlying THREE.TransformControls. The handler signature is
  // (event: { value: boolean }).
  return (
    <>
      <group ref={groupRef} />
      {ready && groupRef.current ? (
        <TransformControls
          object={groupRef.current}
          // Character can only be repositioned via walkTo — rotate/scale
          // are nonsense for a path-driven entity. Force translate.
          mode={isCharacter ? 'translate' : mode}
          onObjectChange={onObjectChange}
          onMouseDown={() => onDraggingChanged(true)}
          onMouseUp={() => onDraggingChanged(false)}
        />
      ) : null}
    </>
  );
}
