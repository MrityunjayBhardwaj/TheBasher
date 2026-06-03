// TransformControls gizmo — bound to the currently-selected node.
//
// Binding modes (P2.6 generalization):
//   - Transform / BoxMesh / GltfAsset / Lights / Cameras: any node whose
//     params expose a `position` vec3 gets a translate gizmo at that
//     position. The gizmo emits setParam Ops on every objectChange.
//     Rotate writes to params.rotation when present. Scale writes to
//     params.scale when present.
//     v0.6 #1 (D-01/D-03): BoxMesh/SphereMesh now carry a real `scale` TRS
//     band, so `getManipulable` resolves their `scaleParamPath` to 'scale'
//     (NOT 'size') — the gizmo scale handle drives the non-destructive
//     transform band, leaving the parametric geometry `size` untouched, with
//     ZERO node-kind special-casing. The `size` fallback below is now a LEGACY
//     path retained only for any node that still has size-but-no-scale (none
//     for primitives after v0.6 #1).
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { degVec3ToRad, radVec3ToDeg } from '../viewport/rotation';
import { useDagStore } from '../core/dag/store';
import { evaluate } from '../core/dag/evaluator';
import type { Node } from '../core/dag/types';
import type { CharacterValue } from '../nodes/types';
import { buildWalkToOps } from './character/walkTo';
import { useGizmoStore, type GizmoMode } from './stores/gizmoStore';
import { useEditorStore } from './stores/editorStore';
import { useSelectionStore } from './stores/selectionStore';
import { useTimeStore } from './stores/timeStore';
import { maybeSnapVec3 } from './stores/viewportStore';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { routeAnimatedGrab, autoKeyCommit } from './animate/autoKeyCommit';

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
  const rawManip = isCharacter ? null : getManipulable(node);

  // Time — drives the Character path AND (P7.3) the manip resolver re-seed.
  const seconds = useTimeStore((s) => s.seconds);
  const frame = useTimeStore((s) => s.frame);
  const normalized = useTimeStore((s) => s.normalized);

  // D-01 (LOCKED, CONTEXT.md:46-54): selecting the box OR its wrapping
  // AnimationLayer must BOTH show ONE gizmo at the cube's evaluated
  // transform. An AnimationLayer node has NO `position` param, so
  // getManipulable(layerNode) returns null — pre-7.3 that meant NO gizmo
  // for a layer selection (the CONTEXT-documented symptom). To honor the
  // locked D-01 and the non-deferrable D-06 gate (boundary-pair for box
  // AND layer), synthesize a manip from the EVALUATED transform when the
  // raw node has none but the resolver resolves selectedId to a rendered
  // child. (This supersedes the Task-3-step-4 guard NOTE, which was
  // internally inconsistent with the LOCKED D-01 — the locked decision +
  // the phase gate win.) The animated transform param for the P7
  // box→layer shape is `position` (the #68 symptom); rotation/scale ride
  // the same resolver. When the resolver returns null (genuinely
  // non-anchorable selection) we still fall through to NO gizmo — the
  // Task-3 intent for nodes that don't render via a wrapper.
  const evalForSelection = useMemo(() => {
    if (rawManip || isCharacter || !selectedId) return null;
    try {
      return resolveEvaluatedTransform(useDagStore.getState().state, selectedId, {
        time: { frame, seconds, normalized },
      });
    } catch {
      return null;
    }
  }, [rawManip, isCharacter, selectedId, frame, seconds, normalized]);

  const manip: Manipulable | null =
    rawManip ??
    (evalForSelection
      ? {
          position: evalForSelection.position,
          rotation: evalForSelection.rotation,
          scale: evalForSelection.scale,
          // D-01: the wrapped target's animated transform param is
          // 'position'; scale handle writes 'scale' when the eval value
          // carries one (BoxMesh-style 'size' is not gizmo-grabbable via
          // a layer selection — the channel paramPath governs the route).
          scaleParamPath: evalForSelection.scale ? 'scale' : null,
          scaleSeed: evalForSelection.scale,
        }
      : null);
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
      // NOTE: no early return here — fall through to the FLAG-C tail mirror
      // so the dev-only proxy attr reflects whichever branch committed.
    } else if (isCharacter) {
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

    // *** FLAG-C — test-observation hook, dev-guarded, NOT user chrome ***
    // The FINAL statement of the seeding effect: AFTER both the
    // manip/resolver branch AND the Character branch have committed
    // `groupNode`. Reflects the ACTUAL committed proxy transform
    // regardless of which branch ran (never a mid-effect intermediate).
    // The D-06 boundary-pair e2e reads this to observe the GIZMO side of
    // the boundary (the side P7's E2 never observed — the #68 gap). It is
    // a data-attr mirror on the proxy group, recorded in the B11 line as
    // a test-only attr — no UI-SPEC delta, no new chrome surface.
    if (import.meta.env.DEV) {
      const p = groupNode.position;
      const r = groupNode.rotation;
      const s = groupNode.scale;
      const el = groupNode as unknown as { userData: Record<string, unknown> };
      el.userData.__basher_gizmo = {
        position: [p.x, p.y, p.z],
        // radians on the Object3D — report degrees to match params/eval.
        rotation: radVec3ToDeg([r.x, r.y, r.z]),
        scale: [s.x, s.y, s.z],
      };
      const w = window as unknown as Record<string, unknown>;
      w.__basher_gizmo = () =>
        (groupNode as unknown as { userData: Record<string, unknown> }).userData.__basher_gizmo ??
        null;
    }
  }, [groupNode, manip, isCharacter, selectedId, seconds, frame, normalized, playing]);

  if (!selectedId) return null;
  if (!isCharacter && !manip) return null;

  // P7.3 (#68 / D-02) — the grab-route decision. Made BEFORE the raw
  // setParam for EVERY param (H36: re-route INSTEAD of the raw setParam,
  // never in addition — a double-write would key the channel AND write the
  // dead source value, producing a snap-back ghost).
  //
  // P7.4 W5.1 / D-05: `routeAnimatedGrab` was lifted to the shared
  // `./animate/autoKeyCommit` module so it has TWO callers (this gizmo grab
  // AND the NPanel inspector commit handlers — one chokepoint, two callers;
  // Domain-Aligned-Abstraction consolidation, Chesterton: the gate already
  // existed, do not duplicate it). The extraction is behaviour-identical —
  // `selectedId` is now passed explicitly instead of read from this
  // component's closure; the branch order + FLAG-A reject are preserved
  // verbatim in the shared module. See its docstring for the full contract.

  // P7.7 (#91 / D-02) — the GltfChild manual-layer write. A GltfChild is the
  // manual override layer over the per-child clip/base layering (R-4). Writing
  // the TRS value WITHOUT flipping its `overridden[field]` flag is the C2 trap:
  // the next renderer re-layer would let the clip/base re-win and the gizmo
  // would snap back (the H36 snap-back ghost in a new guise). So the value and
  // the flag must land in ONE atomic dispatch (one Cmd+Z) — applySetParam
  // supports the dotted nested paramPath 'overridden.<field>' (ops.ts setAtPath
  // clone-on-write + whole-object re-validation). For every non-GltfChild node
  // this returns false and the caller's existing single setParam fires,
  // byte-identical to pre-7.7.
  function writeGltfChildOverride(field: 'position' | 'rotation' | 'scale', value: Vec3): boolean {
    if (!selectedId) return false;
    const sel = useDagStore.getState().state.nodes[selectedId];
    if (sel?.type !== 'GltfChild') return false;
    useDagStore.getState().dispatchAtomic(
      [
        { type: 'setParam', nodeId: selectedId, paramPath: field, value },
        { type: 'setParam', nodeId: selectedId, paramPath: `overridden.${field}`, value: true },
      ],
      'user',
      `gizmo ${field} (glTF child override)`,
    );
    return true;
  }

  function onObjectChange() {
    // Character: no per-frame dispatch — walkTo fires on drag end only.
    if (isCharacter) return;
    if (!manip) return;
    const g = groupNode;
    if (!g || !selectedId) return;
    const liveMode = useGizmoStore.getState().mode;
    if (liveMode === 'translate') {
      const value = maybeSnapVec3([g.position.x, g.position.y, g.position.z]);
      if (routeAnimatedGrab(selectedId, 'position', value)) return; // D-02: re-route BEFORE setParam
      // P7.7: a GltfChild has NO keyframe channel (the clip lives on the asset),
      // so routeAnimatedGrab returns false and we land here — the manual layer.
      // Write value + overridden flag atomically (no snap-back).
      if (writeGltfChildOverride('position', value)) return;
      useDagStore
        .getState()
        .dispatch(
          { type: 'setParam', nodeId: selectedId, paramPath: 'position', value },
          'user',
          'gizmo translate',
        );
      // #141: un-animated first-key path — symmetric with the NPanel inspector
      // (which commits setParam THEN autoKeyCommit). routeAnimatedGrab returned
      // false above (un-animated) so this is mutually exclusive with its
      // animated-param keying — no H36 double-write. autoKeyCommit self-gates on
      // Auto-Key OFF (returns immediately), so record-off stays byte-identical.
      autoKeyCommit(selectedId, 'position', value);
      return;
    }
    if (liveMode === 'rotate') {
      if (!manip.rotation) return; // node has no rotation param — no-op
      // Object3D.rotation is radians — params.rotation is degrees.
      const value: Vec3 = radVec3ToDeg([g.rotation.x, g.rotation.y, g.rotation.z]);
      if (routeAnimatedGrab(selectedId, 'rotation', value)) return; // D-02: re-route BEFORE setParam
      if (writeGltfChildOverride('rotation', value)) return; // P7.7 manual layer
      useDagStore
        .getState()
        .dispatch(
          { type: 'setParam', nodeId: selectedId, paramPath: 'rotation', value },
          'user',
          'gizmo rotate',
        );
      autoKeyCommit(selectedId, 'rotation', value); // #141 un-animated first-key (see translate)
      return;
    }
    // scale
    if (!manip.scaleParamPath) return;
    const value: Vec3 = [g.scale.x, g.scale.y, g.scale.z];
    if (routeAnimatedGrab(selectedId, manip.scaleParamPath, value)) return; // D-02: re-route BEFORE setParam
    // P7.7: a GltfChild declares `scale` (never `size`), so scaleParamPath is
    // 'scale' and the override flag is `overridden.scale`.
    if (manip.scaleParamPath === 'scale' && writeGltfChildOverride('scale', value)) return;
    useDagStore
      .getState()
      .dispatch(
        { type: 'setParam', nodeId: selectedId, paramPath: manip.scaleParamPath, value },
        'user',
        `gizmo scale (${manip.scaleParamPath})`,
      );
    autoKeyCommit(selectedId, manip.scaleParamPath, value); // #141 un-animated first-key (see translate)
  }

  // *** D-06 grab observation seam — dev-guarded, NOT user chrome ***
  // Pointer-event simulation through THREE's TransformControls is fragile
  // in headless Chromium (H3 lesson; p26-acceptance.spec.ts:368-370 takes
  // the same stance). To OBSERVE the real grab path (routeAnimatedGrab —
  // the D-02 decision under test) without a brittle 3D drag, this seam
  // moves the proxy to a target then invokes the REAL onObjectChange.
  // It exercises the actual gizmo code path (NOT a dispatch that bypasses
  // it), so the boundary-pair test observes the gizmo side honestly.
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.__basher_gizmo_grab = (mode: GizmoMode, target: [number, number, number]) => {
      if (!groupNode) return;
      // V19: gizmo mode changes flow through editorStore.setActiveTool —
      // the ONE canonical writer that propagates to gizmoStore.setMode.
      // The seam must NOT call setMode directly (V19 grep gate + the
      // shared-dispatcher invariant).
      useEditorStore.getState().setActiveTool(mode);
      if (mode === 'translate') groupNode.position.set(...target);
      else if (mode === 'rotate') groupNode.rotation.set(...degVec3ToRad(target));
      else groupNode.scale.set(...target);
      onObjectChange();
    };
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
          // D-03 (visible half): while playing the gizmo still display-
          // follows (the Wave-2 effect re-seeds on the `playing` dep + every
          // frame) but cannot be grabbed. Wave-3's onObjectChange
          // playing-return is the data-integrity half (belt-and-suspenders:
          // even if a drag slips through, no op fires). `playing` is
          // subscribed at component scope (Wave 2).
          enabled={!playing}
          onObjectChange={onObjectChange}
          onMouseDown={() => onDraggingChanged(true)}
          onMouseUp={() => onDraggingChanged(false)}
        />
      ) : null}
    </>
  );
}
