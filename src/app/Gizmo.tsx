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
//
// P7.3 (#68 — gizmo tracks the EVALUATED transform):
//   The manip branch no longer early-returns from the seeding effect on
//   the static `node.params`. Like the Character branch, it now evaluates
//   the render tree (via resolveEvaluatedTransform) and re-seeds the proxy
//   on every playhead change so the gizmo sits where the cube RENDERS
//   (the AnimationLayer patched clone), not where it was authored. When
//   the resolver returns null (selectedId not a rendered scene child / not
//   a wrapped layer target) the branch falls back ENTIRELY to the static
//   params — today's behavior, no crash (D-04 per-param-when-null).
//   `playing` is subscribed (D-03): the gizmo display-follows during
//   playback and is interactive only when paused.
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
import { useCallback, useEffect, useState } from 'react';
import * as THREE from 'three';
import { degVec3ToRad, radVec3ToDeg } from '../viewport/rotation';
import { useDagStore } from '../core/dag/store';
import { evaluate } from '../core/dag/evaluator';
import type { Node } from '../core/dag/types';
import type { CharacterValue } from '../nodes/types';
import { buildWalkToOps } from './character/walkTo';
import { useGizmoStore, type GizmoMode } from './stores/gizmoStore';
import { useSelectionStore } from './stores/selectionStore';
import { useTimeStore } from './stores/timeStore';
import { maybeSnapVec3 } from './stores/viewportStore';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';

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
  // ref-as-state — setting `groupNode` triggers a re-render so the
  // TransformControls mounts the moment the proxy <group> attaches.
  // A bare useRef would silently break the deselect → re-select cycle:
  // groupRef.current goes null on unmount; the new ref attaches AFTER
  // the next render commits, but ref writes don't cause a re-render, so
  // the conditional `<TransformControls>` block (which gates on the
  // ref) never re-evaluates. Using state closes that loop.
  const [groupNode, setGroupNode] = useState<THREE.Group | null>(null);
  const groupRefCb = useCallback((g: THREE.Group | null) => {
    setGroupNode(g);
  }, []);

  const isCharacter = node?.type === 'Character';
  const manip = isCharacter ? null : getManipulable(node);

  // Time is needed only for the Character path (evaluate the locomotion
  // chain). Subscribing here keeps the seeding effect in sync with the
  // playhead.
  const seconds = useTimeStore((s) => s.seconds);
  const frame = useTimeStore((s) => s.frame);
  const normalized = useTimeStore((s) => s.normalized);
  // D-03: reuse the EXISTING play/pause state (no new flag). Subscribed at
  // component scope (V20 — a React store subscription, NOT a currentFrameRef
  // read) so the seeding effect re-runs across the play/pause transition
  // and Wave 4's `enabled={!playing}` re-renders.
  const playing = useTimeStore((s) => s.playing);

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
    if (!groupNode || !selectedId) return;
    if (manip) {
      // P7.3 (#68): mirror the Character branch — evaluate the render tree
      // and seed the proxy to the EVALUATED transform, re-running on every
      // playhead change. The resolver returns the AnimationLayer patched
      // clone (the rendered transform) for an animated node; null when the
      // selection isn't a rendered scene child / wrapped target.
      //
      // No proxy double-write: evalT is computed FIRST, then a SINGLE
      // set() per axis chooses eval-or-static — we never set static then
      // overwrite (which would flash the stale authored value for a frame).
      // evalT non-null ⇒ the patched clone IS the rendered transform, so
      // seeding all three axes from it is correct-by-construction (the
      // gizmo must sit where the cube renders; patchTarget preserves
      // un-channelled fields). evalT null ⇒ FULL static fallback — today's
      // behavior exactly (D-04 per-param-when-null).
      let evalT: ReturnType<typeof resolveEvaluatedTransform> = null;
      try {
        evalT = resolveEvaluatedTransform(useDagStore.getState().state, selectedId, {
          time: { frame, seconds, normalized },
        });
      } catch {
        evalT = null; // fall back entirely to static (Character-branch shape)
      }

      // position
      if (evalT) groupNode.position.set(...evalT.position);
      else groupNode.position.set(...manip.position);

      // rotation — params/eval rotation are DEGREES; Object3D wants RADIANS.
      // Per-param: eval rotation when the patched clone carries one, else
      // the static manip rotation, else identity (byte-identical defaults).
      if (evalT && evalT.rotation) groupNode.rotation.set(...degVec3ToRad(evalT.rotation));
      else if (!evalT && manip.rotation) groupNode.rotation.set(...degVec3ToRad(manip.rotation));
      else groupNode.rotation.set(0, 0, 0);

      // scale — eval scale (explicit or size fallback) when present, else
      // the static scaleSeed, else identity (byte-identical defaults).
      if (evalT && evalT.scale) groupNode.scale.set(...evalT.scale);
      else if (!evalT && manip.scaleSeed) groupNode.scale.set(...manip.scaleSeed);
      else groupNode.scale.set(1, 1, 1);
      return;
    }
    if (isCharacter) {
      const dagState = useDagStore.getState().state;
      try {
        const result = evaluate(dagState, selectedId, {
          ctx: { time: { frame, seconds, normalized } },
        });
        const v = result.value as CharacterValue;
        groupNode.position.set(...v.position);
        groupNode.rotation.set(0, v.heading, 0);
        groupNode.scale.set(1, 1, 1);
      } catch {
        // node missing or eval error — leave gizmo unmounted
      }
    }
  }, [groupNode, manip, isCharacter, selectedId, seconds, frame, normalized, playing]);

  if (!selectedId) return null;
  if (!isCharacter && !manip) return null;

  function onObjectChange() {
    // Character: no per-frame dispatch — walkTo fires on drag end only.
    if (isCharacter) return;
    if (!manip) return;
    const g = groupNode;
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
      // Object3D.rotation is radians — params.rotation is degrees.
      const value: Vec3 = radVec3ToDeg([g.rotation.x, g.rotation.y, g.rotation.z]);
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
    if (!isCharacter || !selectedId || !groupNode) return;
    // End of drag — emit walkTo to the gizmo's current position.
    const g = groupNode;
    const dagState = useDagStore.getState().state;
    const target = maybeSnapVec3([g.position.x, 0, g.position.z]);
    const result = buildWalkToOps(dagState, selectedId, target);
    if (!result) return;
    useDagStore.getState().dispatchAtomic(result.ops, 'user', result.description);
  }

  return (
    <>
      <group ref={groupRefCb} />
      {groupNode ? (
        <TransformControls
          object={groupNode}
          mode={effectiveMode}
          onObjectChange={onObjectChange}
          onMouseDown={() => onDraggingChanged(true)}
          onMouseUp={() => onDraggingChanged(false)}
        />
      ) : null}
    </>
  );
}
