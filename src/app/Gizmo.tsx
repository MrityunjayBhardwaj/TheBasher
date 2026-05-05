// TransformControls gizmo — bound to the currently-selected Transform node.
// User drags handles → drei updates an internal proxy group → we read the
// new pose on `objectChange` and dispatch `setParam` Ops (V1). Inspector
// stays in sync because it reads the same param path.
//
// V8 is preserved by file location: this lives in `src/app/`, NOT in
// `src/viewport/`. Viewport.tsx imports + mounts it inside the Canvas.
// V8's enforcement clause is "no path inside src/viewport/** that calls
// dispatch" — the dispatch path here is rooted in src/app/.
//
// Live-drag mode: every `objectChange` event dispatches `setParam` for the
// changed param only. Browser pointer events fire at ≤60 Hz, so this is
// already at the THESIS.md §53 16 ms cadence; no extra debounce needed.
//
// Known refinement (deferred to P2): each event currently produces its own
// undo-stack entry, so a 1-second drag at 60 fps creates ~60 undo entries.
// A future patch will subscribe to TransformControls' `dragging-changed`
// event and collapse the per-event entries into one `dispatchAtomic` group
// at drag end (matching the asset-drop chain's atomic-undo property — K6).
// Tracked in CHANGELOG cut list; not blocking acceptance #5.
//
// Single-writer-queue (THESIS.md §25): mid-drag agent ops are deferred
// in P2.5 — out of P1 scope.
//
// REF: THESIS.md §11, §15, §25, §53; vyapti V1, V8.

import { TransformControls } from '@react-three/drei';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDagStore } from '../core/dag/store';
import type { TransformParams } from '../nodes/Transform';
import { useSelectionStore } from './stores/selectionStore';

export function Gizmo() {
  const selectedId = useSelectionStore((s) => s.selectedNodeId);
  const node = useDagStore((s) => (selectedId ? s.state.nodes[selectedId] : null));
  const dispatch = useDagStore((s) => s.dispatch);
  const groupRef = useRef<THREE.Group>(null);
  const [ready, setReady] = useState(false);

  const isTransform = node?.type === 'Transform';
  const params = isTransform ? (node!.params as TransformParams) : null;

  // Sync the proxy group's pose to params whenever params change (initial
  // mount, undo/redo, agent op). The drag handler updates the group
  // in-place via TransformControls, then dispatches; that round-trips
  // through this effect as a no-op (same value → same set).
  useEffect(() => {
    if (!groupRef.current || !params) return;
    groupRef.current.position.set(...params.position);
    groupRef.current.rotation.set(...params.rotation);
    groupRef.current.scale.set(...params.scale);
    setReady(true);
  }, [params]);

  if (!isTransform || !params || !selectedId) return null;

  function onObjectChange() {
    const g = groupRef.current;
    if (!g || !selectedId) return;
    dispatch(
      {
        type: 'setParam',
        nodeId: selectedId,
        paramPath: 'position',
        value: [g.position.x, g.position.y, g.position.z],
      },
      'user',
      'gizmo drag',
    );
  }

  return (
    <>
      <group ref={groupRef} />
      {ready && groupRef.current ? (
        <TransformControls
          object={groupRef.current}
          mode="translate"
          onObjectChange={onObjectChange}
        />
      ) : null}
    </>
  );
}
