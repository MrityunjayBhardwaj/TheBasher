// TransformControls gizmo — bound to the currently-selected node.
//
// Binding modes (P2.6 generalization):
//   - Transform / BoxMesh / GltfAsset / Lights / Cameras: any node whose
//     params expose a `position` vec3 gets a translate gizmo at that
//     position. The gizmo emits setParam Ops on every objectChange.
//     Rotate writes to params.rotation when present. Scale writes to
//     params.scale when present.
//     v0.6 #1 (D-01/D-03): BoxMesh/SphereMesh now carry a real `scale` TRS
//     band, so `getManipulable` resolves their `scaleParamPath` to 'scale' —
//     the gizmo scale handle drives the non-destructive transform band,
//     leaving the parametric geometry `size` untouched, with ZERO node-kind
//     special-casing. The object↔data split (#231 D) puts size (geometry) and
//     scale (transform) on different nodes, so a scale handle can never write
//     `size`: the legacy size-as-scale fallback is retired — the conflation is
//     now unrepresentable.
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
//   (the channel-overlaid value), not where it was authored. When
//   the resolver returns null (selectedId not a rendered scene child / not
//   a GltfChild) the branch falls back ENTIRELY to the static
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
import { useThree, useFrame, type ThreeEvent } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { degVec3ToRad, radVec3ToDeg } from '../viewport/rotation';
import { useDagStore } from '../core/dag/store';
import { evaluate } from '../core/dag/evaluator';
import type { Node, Op } from '../core/dag/types';
import type { CharacterValue } from '../nodes/types';
import { buildWalkToOps } from './character/walkTo';
import { useGizmoStore, type GizmoMode } from './stores/gizmoStore';
import { useEditorStore } from './stores/editorStore';
import { isModifierNode, resolveStackBase } from './operatorStack';
import { useSelectionStore } from './stores/selectionStore';
import { useTimeStore } from './stores/timeStore';
import { maybeSnapVec3, maybeSnapTransform, useViewportStore } from './stores/viewportStore';
import { pivotPoint } from './gizmoPivot';
import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import { resolveParentWorldMatrix, resolveWorldTransform } from './resolveWorldTransform';
import { routeAnimatedGrab, autoKeyCommit } from './animate/autoKeyCommit';
import { resolveActiveCameraPoseAt } from './activeCamera';
import { cameraOrientationQuat, lookAtRollFromQuat } from './cameraOrientation';
import { constraintTargetSet, resolveFollowedWorldPosition } from './nodeConstraints';
import { useActiveCurvePoint } from './curvePointSelection';

type Vec3 = [number, number, number];

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/** The node's LOCAL matrix T·R·S (·T(-pivot) for a Group) from the proxy's
 *  currently-seeded local pos/rot°(as radians on the Object3D)/scale — MIRRORS
 *  resolveWorldTransform.localMatrix so a re-anchor composes consistently (#230). */
function localTRSMatrix(
  pos: THREE.Vector3,
  rotRad: THREE.Euler,
  scale: THREE.Vector3,
  pivot: Vec3 | null,
): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rotRad.x, rotRad.y, rotRad.z, 'XYZ'),
  );
  const m = new THREE.Matrix4().compose(pos.clone(), q, scale.clone());
  if (pivot) m.multiply(new THREE.Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
  return m;
}

/** Convert the proxy's WORLD transform back to the node's LOCAL params (#230):
 *  local = parentWorld⁻¹ · proxyWorld, then strip a Group's own -pivot so the
 *  decomposed T·R·S are the position/rotation(deg)/scale params. */
function worldToLocalTRS(
  g: THREE.Group,
  parentWorld: THREE.Matrix4,
  pivot: Vec3 | null,
): { position: Vec3; rotation: Vec3; scale: Vec3 } {
  const proxyWorld = new THREE.Matrix4().compose(
    g.position.clone(),
    g.quaternion.clone(),
    g.scale.clone(),
  );
  const local = parentWorld.clone().invert().multiply(proxyWorld);
  if (pivot) local.multiply(new THREE.Matrix4().makeTranslation(pivot[0], pivot[1], pivot[2]));
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  local.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return {
    position: [p.x, p.y, p.z],
    rotation: radVec3ToDeg([e.x, e.y, e.z]),
    scale: [s.x, s.y, s.z],
  };
}

/** #225 — convert a node's new WORLD matrix back to its LOCAL params:
 *  local = parentWorld⁻¹ · newWorld, then strip a Group's own -pivot. The
 *  matrix sibling of worldToLocalTRS (which reads a live proxy group); used by
 *  MultiGizmo where each node's new world is computed as delta·seedWorld. */
function matrixToLocalTRS(
  newWorld: THREE.Matrix4,
  parentWorld: THREE.Matrix4 | null,
  pivot: Vec3 | null,
): { position: Vec3; rotation: Vec3; scale: Vec3 } {
  const local = (parentWorld ? parentWorld.clone().invert() : new THREE.Matrix4()).multiply(
    newWorld,
  );
  if (pivot) local.multiply(new THREE.Matrix4().makeTranslation(pivot[0], pivot[1], pivot[2]));
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  local.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return {
    position: [p.x, p.y, p.z],
    rotation: radVec3ToDeg([e.x, e.y, e.z]),
    scale: [s.x, s.y, s.z],
  };
}

interface Manipulable {
  position: Vec3;
  rotation: Vec3 | null;
  scale: Vec3 | null;
  /** Param path the scale handle should write to. 'scale' for nodes that
   *  declare a scale vec3; null when scale should be hidden. (The legacy
   *  'size' variant — geometry-as-scale — is retired: #231 D puts size and
   *  scale on separate nodes, so the gizmo never writes `size`.) */
  scaleParamPath: 'scale' | null;
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
  return {
    position: p.position as Vec3,
    rotation,
    scale: explicitScale,
    scaleParamPath: explicitScale ? 'scale' : null,
    scaleSeed: explicitScale,
  };
}

function SingleGizmo() {
  const primarySelectedId = useSelectionStore((s) => s.primaryNodeId);
  // When a geometry MODIFIER (Array/Mirror) is selected, the gizmo edits the BASE
  // mesh's transform: the modifier inherits the source's TRS and renders the
  // modified result THERE (resolveEvaluatedMesh), so dragging the base moves the
  // whole result. The literal selection stays on the modifier (its stack UI +
  // inspector params); only the gizmo's transform TARGET redirects to the base.
  // Closes the #209 "gizmo inert on a selected modifier" known-limit. For a normal
  // node, or a dangling modifier, this is identity (targets the selection itself).
  const selectedId = useDagStore((s) => {
    if (!primarySelectedId) return null;
    const sel = s.state.nodes[primarySelectedId];
    return isModifierNode(sel) ? resolveStackBase(s.state, primarySelectedId) : primarySelectedId;
  });
  const node = useDagStore((s) => (selectedId ? s.state.nodes[selectedId] : null));
  const mode = useGizmoStore((s) => s.mode);
  // #228 — transform orientation (Blender Global/Local). Maps to three's
  // TransformControls `space`. 'local' aligns the handles to the object's own
  // axes (its proxy quaternion); 'global' to world. v1 limit: a Group-nested
  // child is world-anchored (#230), so 'local' there orients to its WORLD pose,
  // not its true local axes — top-level nodes (the common case) are exact.
  const orientation = useGizmoStore((s) => s.orientation);
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
  // #230 — the selected node's PARENT world matrix (null for top-level / flat
  // light·camera / unresolvable), captured by the seeding effect and read by
  // onObjectChange to convert a world-space drag back to local params. Non-null
  // ⇒ the node is nested under a transformed ancestor (the gizmo runs in world
  // space). Plus the dragged node's own pivot (Group) to strip on write-back.
  const parentWorldRef = useRef<THREE.Matrix4 | null>(null);
  const pivotRef = useRef<Vec3 | null>(null);

  const isCharacter = node?.type === 'Character';
  // The directly-manipulable params (position + rotation/scale-or-size). With
  // the AnimationLayer wrapper retired (#199, V57), every selectable scene child
  // is its OWN node carrying a `position` param, so getManipulable resolves it
  // directly. The old `evalForSelection` synth — which fabricated a manip from
  // the EVALUATED transform when the selected node had NO position param but the
  // resolver resolved it to a rendered child — existed ONLY for the positionless
  // AnimationLayer wrapper (D-01 box-or-layer, #68). That node type is gone, and
  // every surviving positionless-param node (Group → `{children}`, GltfAsset →
  // no position field) produces a value with NO `position`, so
  // resolveEvaluatedTransform returns null for them
  // (resolveEvaluatedTransform.ts:150/257 require `position`) → the synth could
  // never fire again. Removed as dead (#194 follow-up; Chesterton-verified by the
  // value shapes + the gizmo/glTF e2e suite). The ANIMATED gizmo position still
  // comes from the resolver — in the seeding effect below, which is unchanged.
  const manip: Manipulable | null = isCharacter ? null : getManipulable(node);

  // Time — drives the Character path AND (P7.3) the manip resolver re-seed.
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
      // playhead change. The resolver returns the channel-overlaid value
      // (the rendered transform) for an animated node; null when the
      // selection isn't a rendered scene child / GltfChild.
      //
      // No proxy double-write: evalT is computed FIRST, then a SINGLE
      // set() per axis chooses eval-or-static — we never set static then
      // overwrite (which would flash the stale authored value for a frame).
      // evalT non-null ⇒ the overlaid value IS the rendered transform, so
      // seeding all three axes from it is correct-by-construction (the
      // gizmo must sit where the cube renders; overlayChannels preserves
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
      // Per-param: eval rotation when the overlaid value carries one, else
      // the static manip rotation, else identity (byte-identical defaults).
      if (evalT && evalT.rotation) groupNode.rotation.set(...degVec3ToRad(evalT.rotation));
      else if (!evalT && manip.rotation) groupNode.rotation.set(...degVec3ToRad(manip.rotation));
      else groupNode.rotation.set(0, 0, 0);

      // scale — eval scale (explicit or size fallback) when present, else
      // the static scaleSeed, else identity (byte-identical defaults).
      if (evalT && evalT.scale) groupNode.scale.set(...evalT.scale);
      else if (!evalT && manip.scaleSeed) groupNode.scale.set(...manip.scaleSeed);
      else groupNode.scale.set(1, 1, 1);

      // #230 — the proxy now holds the node's LOCAL pose. If the node is nested
      // under a transformed ancestor, RE-ANCHOR it to its WORLD pose so the gizmo
      // sits where it renders (not detached by the parent transform). parentWorld
      // is null for a top-level / flat (light·camera) / unresolvable (GltfChild)
      // node → the local seed above stands, BYTE-IDENTICAL to pre-#230. The
      // node's own pivot (a nested Group) is folded into localTRSMatrix here and
      // stripped on write-back (worldToLocalTRS).
      let parentWorld: THREE.Matrix4 | null = null;
      try {
        parentWorld = resolveParentWorldMatrix(useDagStore.getState().state, selectedId, {
          time: { frame, seconds, normalized },
        });
      } catch {
        parentWorld = null;
      }
      parentWorldRef.current = parentWorld;
      const np = node?.params as { pivot?: unknown } | undefined;
      pivotRef.current = node?.type === 'Group' && isVec3(np?.pivot) ? (np!.pivot as Vec3) : null;
      if (parentWorld) {
        const localM = localTRSMatrix(
          groupNode.position,
          groupNode.rotation,
          groupNode.scale,
          pivotRef.current,
        );
        const worldM = parentWorld.clone().multiply(localM);
        const wp = new THREE.Vector3();
        const wq = new THREE.Quaternion();
        const ws = new THREE.Vector3();
        worldM.decompose(wp, wq, ws);
        groupNode.position.copy(wp);
        groupNode.quaternion.copy(wq);
        groupNode.scale.copy(ws);
      }
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
  }, [groupNode, manip, node, isCharacter, selectedId, seconds, frame, normalized, playing]);

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
    // #230 — when the node is nested, the seeding effect captured its parent
    // world matrix and anchored the proxy in WORLD space; convert the proxy's
    // world transform back to the node's LOCAL params before writing. null ⇒
    // top-level / flat (light·camera) / unresolvable (GltfChild) → the proxy IS
    // local (parent identity), so use its value directly — byte-identical to
    // pre-#230. (Snapping stays per-mode below, on the resolved local value.)
    const parentWorld = parentWorldRef.current;
    const local = parentWorld ? worldToLocalTRS(g, parentWorld, pivotRef.current) : null;
    if (liveMode === 'translate') {
      const value = maybeSnapVec3(
        local ? local.position : [g.position.x, g.position.y, g.position.z],
      );
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
      // Object3D.rotation is radians — params.rotation is degrees. #230: when
      // nested, the local rotation comes from the world→local conversion.
      // #228: snap to the rotate increment (degrees) when Snap ▸ Affect ▸ Rotate.
      const value: Vec3 = maybeSnapTransform(
        'rotate',
        local ? local.rotation : radVec3ToDeg([g.rotation.x, g.rotation.y, g.rotation.z]),
      );
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
    // #230: when nested, the local scale comes from the world→local conversion.
    // #228: snap to the scale increment when Snap ▸ Affect ▸ Scale.
    const value: Vec3 = maybeSnapTransform(
      'scale',
      local ? local.scale : [g.scale.x, g.scale.y, g.scale.z],
    );
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
    if (dragging) {
      // Coalesce the whole drag into ONE undo entry — the per-move onObjectChange
      // dispatches (translate/rotate/scale, incl. the animated-keyframe + GltfChild-
      // override sub-paths) buffer until drag end, so Cmd+Z reverts x:1.2 → x:1 in
      // one step, not incrementally. Character has no per-move dispatch (walkTo fires
      // once on end), so it needs no bracket.
      if (!isCharacter) useDagStore.getState().beginInteraction();
      return;
    }
    if (isCharacter) {
      if (!selectedId || !groupNode) return;
      // End of drag — emit walkTo to the gizmo's current position.
      const g = groupNode;
      const dagState = useDagStore.getState().state;
      const target = maybeSnapVec3([g.position.x, 0, g.position.z]);
      const result = buildWalkToOps(dagState, selectedId, target);
      if (!result) return;
      useDagStore.getState().dispatchAtomic(result.ops, 'user', result.description);
      return;
    }
    // End of a transform drag — flush the coalesced ops as one undo entry. A click
    // with no move flushed nothing (endInteraction self-guards on an empty buffer).
    useDagStore.getState().endInteraction(`gizmo ${useGizmoStore.getState().mode}`);
  }

  return (
    <>
      <group ref={groupRefCb} />
      {groupNode ? (
        <TransformControls
          object={groupNode}
          mode={effectiveMode}
          // #228 — Global/Local orientation (three ignores it for scale, which is
          // always object-local). 'local' aligns handles to the object's axes.
          space={orientation === 'local' ? 'local' : 'world'}
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

// Begin/end a gizmo drag transaction. The drag's per-move dispatches coalesce into
// ONE undo entry (Cmd+Z reverts the whole drag, not each intermediate pixel — the
// history records the committed action, not the in-betweens). Used by the Multi +
// Camera gizmos, whose TransformControls expose raw onMouseDown/Up; SingleGizmo
// brackets inside onDraggingChanged (it has the extra character-walk branch).
// Exported for the curve point gizmo (#322), which is a THIRD TransformControls over the
// same two rules — suppress orbit while dragging, coalesce the drag into one undo entry.
// Shared rather than re-typed so a point drag can never acquire its own undo semantics.
export function startGizmoDrag(): void {
  useGizmoStore.getState().setDragging(true);
  useDagStore.getState().beginInteraction();
}
export function endGizmoDrag(description: string): void {
  useGizmoStore.getState().setDragging(false);
  useDagStore.getState().endInteraction(description);
}

// #225 — the MULTI-object gizmo. When >1 manipulable node is selected, a single
// proxy sits at the MEDIAN of their world positions and a drag applies the
// proxy's incremental world transform to EVERY selected node about that shared
// pivot (Blender's "median point" pivot). The single-node SingleGizmo path is
// untouched (the dispatcher below routes ≤1 there, byte-identical).
//
// Math: seedProxyWorld = T(median). Each frame delta = proxyWorld·seedProxyWorld⁻¹
// (a pure translation in translate mode; a rotation/scale ABOUT the median in
// rotate/scale mode). Each node's new world = delta·seedWorld(node), converted
// back to its LOCAL params (matrixToLocalTRS) — so render==gizmo holds per node
// and the substrate keeps authored-local params (V34/V68 extended to the SET).
//
// KNOWN-LIMITS (v1, documented not silent): the multi path writes PLAIN setParam
// (no per-node routeAnimatedGrab / autoKey / GltfChild-override-flag and no
// snapping) — an animated node renders from its channel so a multi-drag may not
// follow it, and relative spacing is preserved by NOT snapping. Static meshes
// (the common multi-select target) transform correctly. Each onObjectChange is
// one atomic (a drag = many undo entries, same as SingleGizmo).
function MultiGizmo() {
  const selectedIds = useSelectionStore((s) => s.selectedNodeIds);
  const primaryId = useSelectionStore((s) => s.primaryNodeId);
  const mode = useGizmoStore((s) => s.mode);
  // #228 — pivot point (Blender pivot_point/index.rst). Drives WHERE the proxy
  // seeds (median/boundingBox/active) and, for 'individual', that each node
  // rotates/scales about its OWN origin instead of a shared pivot.
  const pivotMode = useViewportStore((s) => s.pivot);
  const seconds = useTimeStore((s) => s.seconds);
  const frame = useTimeStore((s) => s.frame);
  const normalized = useTimeStore((s) => s.normalized);
  const playing = useTimeStore((s) => s.playing);

  const [groupNode, setGroupNode] = useState<THREE.Group | null>(null);
  const groupRefCb = useCallback((g: THREE.Group | null) => setGroupNode(g), []);

  // Captured at seed time: the proxy's seed world + each node's seed world,
  // parent world, pivot, and which TRS params it owns.
  const seedRef = useRef<{
    proxyWorld: THREE.Matrix4;
    /** The active pivot MODE at seed time — `onObjectChange` reads it to decide
     *  the shared-delta path vs the per-origin 'individual' path. */
    pivotMode: typeof pivotMode;
    nodes: {
      id: string;
      seedWorld: THREE.Matrix4;
      parentWorld: THREE.Matrix4 | null;
      pivot: Vec3 | null;
      manip: Manipulable;
    }[];
  } | null>(null);

  // Seed the proxy at the median of the selected nodes' WORLD positions and
  // capture each node's seed world. Re-runs on selection/time change so the
  // group gizmo display-follows animation (like SingleGizmo).
  useEffect(() => {
    if (!groupNode) return;
    const state = useDagStore.getState().state;
    const ctx = { time: { frame, seconds, normalized } };
    const seeds: NonNullable<typeof seedRef.current>['nodes'] = [];
    for (const id of selectedIds) {
      const node = state.nodes[id];
      const manip = getManipulable(node ?? null);
      if (!manip) continue;
      let world: THREE.Matrix4;
      let parentWorld: THREE.Matrix4 | null = null;
      try {
        const wt = resolveWorldTransform(state, id, ctx);
        world = wt
          ? new THREE.Matrix4().fromArray(wt.matrix)
          : new THREE.Matrix4().setPosition(...manip.position);
        // A Follow-Path moves the ORIGIN, and resolveWorldTransform is pure TRS — it applies
        // no band (that purity is what the band's own inputs read). So a follower's seed world
        // must be re-based onto the point it actually renders at, or `origins` below medians a
        // phantom and the whole group orbits a pivot that is nowhere near any object. Position
        // ONLY — the band writes no rotation/scale, so the rest of the matrix stands. Read on
        // top of the pure walk, never folded into it (#348).
        const followed = resolveFollowedWorldPosition(state, id, ctx);
        if (followed) world.setPosition(followed[0], followed[1], followed[2]);
        parentWorld = resolveParentWorldMatrix(state, id, ctx);
      } catch {
        world = new THREE.Matrix4().setPosition(...manip.position);
        parentWorld = null;
      }
      const np = node?.params as { pivot?: unknown } | undefined;
      const pivot = node?.type === 'Group' && isVec3(np?.pivot) ? (np!.pivot as Vec3) : null;
      seeds.push({ id, seedWorld: world, parentWorld, pivot, manip });
    }
    if (seeds.length === 0) {
      seedRef.current = null;
      return;
    }
    // #228 — pivot point: where the proxy seeds + orbits/scales. median /
    // boundingBox / active are computed from the world origins; 'individual'
    // seeds at the median for DISPLAY but applies per-origin in onObjectChange.
    const origins = seeds.map((s) => {
      const p = new THREE.Vector3().setFromMatrixPosition(s.seedWorld);
      return [p.x, p.y, p.z] as Vec3;
    });
    const activeIdx = seeds.findIndex((s) => s.id === primaryId);
    const activeOrigin = activeIdx >= 0 ? origins[activeIdx] : null;
    const pp = pivotPoint(pivotMode, origins, activeOrigin);
    const pivotVec = new THREE.Vector3(pp[0], pp[1], pp[2]);
    groupNode.position.copy(pivotVec);
    groupNode.rotation.set(0, 0, 0);
    groupNode.scale.set(1, 1, 1);
    seedRef.current = {
      proxyWorld: new THREE.Matrix4().setPosition(pivotVec),
      pivotMode,
      nodes: seeds,
    };

    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__basher_gizmo = () => ({
        position: [groupNode.position.x, groupNode.position.y, groupNode.position.z],
        rotation: radVec3ToDeg([groupNode.rotation.x, groupNode.rotation.y, groupNode.rotation.z]),
        scale: [groupNode.scale.x, groupNode.scale.y, groupNode.scale.z],
      });
      w.__basher_gizmo_multi = () => ({
        count: seeds.length,
        pivot: [pivotVec.x, pivotVec.y, pivotVec.z],
        pivotMode,
      });
    }
  }, [groupNode, selectedIds, primaryId, pivotMode, seconds, frame, normalized, playing]);

  function onObjectChange() {
    const g = groupNode;
    const seed = seedRef.current;
    if (!g || !seed) return;
    const liveMode = useGizmoStore.getState().mode;
    const proxyWorld = new THREE.Matrix4().compose(
      g.position.clone(),
      g.quaternion.clone(),
      g.scale.clone(),
    );
    const delta = proxyWorld.clone().multiply(seed.proxyWorld.clone().invert());
    // #228 — 'individual origins': for rotate/scale, apply only the LINEAR part
    // of the delta (translation stripped) about EACH node's own origin, so each
    // rotates/scales in place rather than orbiting the shared pivot. Translate is
    // pivot-independent → it always uses the full shared delta (Blender parity).
    const individual = seed.pivotMode === 'individual' && liveMode !== 'translate';
    const linear = delta.clone().setPosition(0, 0, 0); // rotation/scale about world origin
    const ops: Op[] = [];
    for (const sn of seed.nodes) {
      let newWorld: THREE.Matrix4;
      if (individual) {
        const o = new THREE.Vector3().setFromMatrixPosition(sn.seedWorld);
        // T(o) · linear · T(-o) · seedWorld — rotate/scale about the node's origin.
        newWorld = new THREE.Matrix4()
          .makeTranslation(o.x, o.y, o.z)
          .multiply(linear)
          .multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z))
          .multiply(sn.seedWorld);
      } else {
        newWorld = delta.clone().multiply(sn.seedWorld);
      }
      const local = matrixToLocalTRS(newWorld, sn.parentWorld, sn.pivot);
      // Position changes under translate AND under rotate/scale-about-pivot.
      ops.push({ type: 'setParam', nodeId: sn.id, paramPath: 'position', value: local.position });
      if (liveMode === 'rotate' && sn.manip.rotation) {
        ops.push({ type: 'setParam', nodeId: sn.id, paramPath: 'rotation', value: local.rotation });
      }
      // Only an explicit `scale` band is multi-scaled (never a geometry `size`).
      if (liveMode === 'scale' && sn.manip.scaleParamPath === 'scale') {
        ops.push({ type: 'setParam', nodeId: sn.id, paramPath: 'scale', value: local.scale });
      }
    }
    if (ops.length === 0) return;
    useDagStore
      .getState()
      .dispatchAtomic(ops, 'user', `multi ${liveMode} (${seed.nodes.length} objects)`);
  }

  // Test-observation seam — drive the REAL onObjectChange (mirrors SingleGizmo's
  // __basher_gizmo_grab; only one gizmo is mounted so the name is unambiguous).
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.__basher_gizmo_grab = (m: GizmoMode, target: [number, number, number]) => {
      if (!groupNode) return;
      useEditorStore.getState().setActiveTool(m);
      if (m === 'translate') groupNode.position.set(...target);
      else if (m === 'rotate') groupNode.rotation.set(...degVec3ToRad(target));
      else groupNode.scale.set(...target);
      onObjectChange();
    };
  }

  return (
    <>
      <group ref={groupRefCb} />
      {groupNode ? (
        <TransformControls
          object={groupNode}
          mode={mode}
          enabled={!playing}
          onObjectChange={onObjectChange}
          onMouseDown={startGizmoDrag}
          onMouseUp={() => endGizmoDrag(`multi ${useGizmoStore.getState().mode}`)}
        />
      ) : null}
    </>
  );
}

// #229 — the CAMERA gizmo. A Basher camera aims via position + lookAt (a POINT)
// + roll, NOT an Euler rotation (V56), so the generic SingleGizmo can only
// translate it (its `rotation` param is null → rotate coerces to translate, and
// the lookAt aim point has no handle). CameraGizmo maps Blender's two camera
// idioms onto Basher's lookAt model:
//   - ROTATE the camera body (Blender "press R to rotate the camera object"):
//     the rotate gizmo seeds from the camera's world ORIENTATION
//     (cameraOrientationQuat) and a drag is converted BACK to authored lookAt +
//     roll via lookAtRollFromQuat (V68 — manipulate in render/world space, store
//     authored params), keeping the aim DISTANCE fixed so the aim orbits the
//     camera (yaw/pitch re-aim, roll about the view axis banks).
//   - DRAG THE AIM TARGET: a second translate handle at the world lookAt point;
//     dragging it re-aims the camera (writes lookAt directly — the user's chosen
//     "write lookAt directly", not a Track-To constraint).
//   - TRANSLATE the body moves `position` only; the lookAt POINT stays put so the
//     camera re-aims at it (the aim handle is how you move WHAT it looks at).
// Every write funnels through the SAME routeAnimatedGrab → setParam →
// autoKeyCommit chokepoint the generic gizmo + #190 camera authoring use (V1).
// #231 Inc 3.3 — a camera CAN now be nested in a Group. The proxies seed at the
// camera's WORLD pose (resolveActiveCameraPoseAt composes the parent), so a drag
// must convert the world manipulation BACK to the camera's LOCAL params before
// writing (the #230 round-trip, applied to the camera's point-based lookAt model).
// `parentWorld` is null for a top-level camera → the proxy world IS the local pose,
// byte-identical to the pre-Inc-3.3 (#229) direct write.
// #247 — the camera lookAt is a "Point of Interest" TARGET RETICLE, not a second
// transform gizmo. The #245 twin-triad still read as "2 gizmos"; a categorically
// different glyph (a billboarded ring + centre dot, fixed screen size) can never
// be mistaken for the body's arrow/ring triad. Free (amber) = draggable; bound
// (blue) = Track-To-linked to an object → read-only, follows that object.
const RETICLE_COLOR = '#ffb020';
const RETICLE_BOUND_COLOR = '#5b9dff';
/** local→world scale factor so the reticle holds a ~constant on-screen size,
 *  mirroring how TransformControls keeps its handles a fixed pixel size. */
const RETICLE_SCREEN_SCALE = 0.05;

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();

/** The billboarded lookAt reticle. Owns its own screen-plane drag (window
 *  pointer capture) so dragging works even when the pointer leaves the small
 *  glyph. Writes the new world lookAt through `onDrag`; `onDragStart/End` bracket
 *  the gizmo interaction (orbit-suppress + undo coalesce). */
function CameraAimReticle({
  bound,
  disabled,
  onDragStart,
  onDrag,
  onDragEnd,
}: {
  bound: boolean;
  disabled: boolean;
  onDragStart: () => void;
  onDrag: (world: Vec3) => void;
  onDragEnd: () => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const group = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);
  const drag = useRef({ active: false, plane: new THREE.Plane(), rc: new THREE.Raycaster() });

  // The reticle draws ON TOP (depthTest off), so its picking must ignore depth too
  // — otherwise a lookAt sitting inside/behind geometry (the default scene: origin
  // is behind the cube's front face) can be SEEN but not grabbed. Report a
  // near-zero distance so the disc wins the pick within its small screen circle,
  // matching what the user sees (the same trick TransformControls uses internally).
  const discRaycast = useMemo(
    () =>
      function (this: THREE.Mesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
        const hits: THREE.Intersection[] = [];
        THREE.Mesh.prototype.raycast.call(this, raycaster, hits);
        if (hits.length) intersects.push({ ...hits[0], distance: 0.0001 });
      },
    [],
  );

  // Billboard (face the camera) + constant screen size, every frame.
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.quaternion.copy(camera.quaternion);
    const d = camera.position.distanceTo(g.getWorldPosition(_v0)) || 1;
    g.scale.setScalar(d * RETICLE_SCREEN_SCALE);
  });

  // Stable window listeners that call the latest closures — so a mid-drag
  // re-render (hover, param write) can't strand a stale handler on the window.
  const moveRef = useRef<(e: PointerEvent) => void>(() => {});
  const upRef = useRef<() => void>(() => {});
  const winMove = useRef((e: PointerEvent) => moveRef.current(e)).current;
  const winUp = useRef(() => upRef.current()).current;
  moveRef.current = (ev: PointerEvent) => {
    if (!drag.current.active) return;
    const rect = gl.domElement.getBoundingClientRect();
    const ndc = _v1.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      0,
    );
    drag.current.rc.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const hit = drag.current.rc.ray.intersectPlane(drag.current.plane, new THREE.Vector3());
    if (hit) onDrag([hit.x, hit.y, hit.z]);
  };
  upRef.current = () => {
    if (!drag.current.active) return;
    drag.current.active = false;
    window.removeEventListener('pointermove', winMove);
    window.removeEventListener('pointerup', winUp);
    onDragEnd();
  };

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (bound || disabled) return;
    e.stopPropagation();
    const g = group.current;
    if (!g) return;
    // Drag on a screen-parallel plane through the current lookAt (view normal).
    drag.current.plane.setFromNormalAndCoplanarPoint(
      camera.getWorldDirection(_v0),
      g.getWorldPosition(_v1),
    );
    drag.current.active = true;
    onDragStart();
    window.addEventListener('pointermove', winMove);
    window.addEventListener('pointerup', winUp);
  };

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', winMove);
      window.removeEventListener('pointerup', winUp);
    },
    [winMove, winUp],
  );

  const color = bound ? RETICLE_BOUND_COLOR : RETICLE_COLOR;
  const opacity = bound ? 0.75 : hovered ? 1 : 0.85;
  return (
    <group ref={group}>
      {/* Invisible hit disc — the draggable surface (raycast ON). Only grabbable
          when free; bound reticles pass the click through (return without
          stopPropagation) so selection still works underneath. */}
      <mesh
        onPointerDown={onDown}
        onPointerOver={() => !bound && !disabled && setHovered(true)}
        onPointerOut={() => setHovered(false)}
        raycast={bound || disabled ? () => null : discRaycast}
      >
        <circleGeometry args={[1.1, 32]} />
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
      {/* Ring — the reticle body. */}
      <mesh renderOrder={999} raycast={() => null}>
        <ringGeometry args={[0.72, 0.9, 48]} />
        <meshBasicMaterial
          color={color}
          depthTest={false}
          transparent
          opacity={opacity}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Centre dot — marks the exact aim point. */}
      <mesh renderOrder={999} raycast={() => null}>
        <circleGeometry args={[0.14, 20]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={opacity} />
      </mesh>
    </group>
  );
}

/** A thin connector line camera → lookAt, so the reticle reads unambiguously as
 *  "what this camera aims at". Updated per-frame from the two proxy groups. */
function AimConnector({
  from,
  to,
  color,
}: {
  from: THREE.Object3D | null;
  to: THREE.Object3D | null;
  color: string;
}) {
  const line = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.4,
      depthTest: false,
    });
    const l = new THREE.Line(geom, mat);
    l.renderOrder = 998;
    l.raycast = () => {};
    return l;
  }, [color]);
  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    },
    [line],
  );
  useFrame(() => {
    if (!from || !to) return;
    const a = from.getWorldPosition(_v0);
    const b = to.getWorldPosition(_v1);
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
  });
  return <primitive object={line} />;
}

function CameraGizmo() {
  const camId = useSelectionStore((s) => s.primaryNodeId);
  const mode = useGizmoStore((s) => s.mode);
  const orientation = useGizmoStore((s) => s.orientation);
  const seconds = useTimeStore((s) => s.seconds);
  const frame = useTimeStore((s) => s.frame);
  const normalized = useTimeStore((s) => s.normalized);
  const playing = useTimeStore((s) => s.playing);

  const [bodyNode, setBodyNode] = useState<THREE.Group | null>(null);
  const [aimNode, setAimNode] = useState<THREE.Group | null>(null);
  const bodyRefCb = useCallback((g: THREE.Group | null) => setBodyNode(g), []);
  const aimRefCb = useCallback((g: THREE.Group | null) => setAimNode(g), []);

  // #247 — is the camera's lookAt Track-To-BOUND to an object? Then the reticle
  // follows that object (resolveCameraPoseAt already derives lookAt from it) and
  // is read-only. Subscribe to nodes so add/remove of the constraint re-renders.
  const nodes = useDagStore((s) => s.state.nodes);
  const bound = useMemo(
    () => (camId ? constraintTargetSet(nodes).has(camId) : false),
    [nodes, camId],
  );

  // Captured at seed time: the camera's evaluated position + the aim DISTANCE, so
  // a rotate keeps the lookAt the same distance from the camera (the aim orbits,
  // it does not slide toward/away).
  const seedRef = useRef<{
    position: Vec3;
    distance: number;
    /** #231 Inc 3.3 — the parent Group's world matrix when the camera is nested
     *  (null = top-level → world == local, the #229 direct path). Captured at seed
     *  so the drag handlers convert world → local before writing authored params. */
    parentWorld: THREE.Matrix4 | null;
  } | null>(null);

  // Seed both proxies from the EVALUATED camera pose so the gizmo display-follows
  // animation/scrub (the SingleGizmo discipline). The body proxy carries the
  // camera's world ORIENTATION (so rotate spins from the rendered orientation);
  // the aim proxy sits at the world lookAt point.
  useEffect(() => {
    if (!camId) return;
    let pose;
    try {
      pose = resolveActiveCameraPoseAt(useDagStore.getState().state, seconds);
    } catch {
      return;
    }
    const distance =
      Math.hypot(
        pose.lookAt[0] - pose.position[0],
        pose.lookAt[1] - pose.position[1],
        pose.lookAt[2] - pose.position[2],
      ) || 1;
    // #231 Inc 3.3 — the parent Group world (null for a top-level camera). The pose
    // above is already in WORLD space (resolveActiveCameraPoseAt composed it), so
    // the drag handlers undo this matrix to recover the LOCAL authored params.
    const parentWorld = resolveParentWorldMatrix(useDagStore.getState().state, camId, {
      time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
    });
    seedRef.current = { position: pose.position, distance, parentWorld };
    if (bodyNode) {
      bodyNode.position.set(...pose.position);
      bodyNode.quaternion.copy(cameraOrientationQuat(pose.position, pose.lookAt, pose.roll));
      bodyNode.scale.set(1, 1, 1);
    }
    if (aimNode) {
      aimNode.position.set(...pose.lookAt);
      aimNode.quaternion.identity();
      aimNode.scale.set(1, 1, 1);
    }
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__basher_camera_gizmo = () => ({
        position: bodyNode ? [bodyNode.position.x, bodyNode.position.y, bodyNode.position.z] : null,
        aim: aimNode ? [aimNode.position.x, aimNode.position.y, aimNode.position.z] : null,
        // #247 — the aim is a target RETICLE (not a triad); `bound` = Track-To
        // linked to an object (read-only, follows it).
        reticle: true,
        bound,
      });
    }
  }, [camId, bodyNode, aimNode, seconds, frame, normalized, playing, bound]);

  // ONE write chokepoint per camera param — animated → re-route (channel keyed),
  // else raw setParam + autoKey first-key (mirrors the generic gizmo per-param,
  // H36 single-write: route XOR setParam, never both).
  function writeCameraParam(path: 'position' | 'lookAt' | 'roll', value: unknown) {
    if (!camId) return;
    if (routeAnimatedGrab(camId, path, value)) return;
    useDagStore
      .getState()
      .dispatch(
        { type: 'setParam', nodeId: camId, paramPath: path, value },
        'user',
        `camera ${path}`,
      );
    autoKeyCommit(camId, path, value);
  }

  // #231 Inc 3.3 — a world-space point → the camera's LOCAL space when nested
  // (parentWorld⁻¹ · world), else unchanged (top-level camera, world == local).
  function toLocalPoint(world: Vec3): Vec3 {
    const pw = seedRef.current?.parentWorld;
    if (!pw) return world;
    const v = new THREE.Vector3(world[0], world[1], world[2]).applyMatrix4(pw.clone().invert());
    return [v.x, v.y, v.z];
  }

  function onBodyChange() {
    const g = bodyNode;
    const seed = seedRef.current;
    if (!g || !seed || !camId) return;
    const liveMode = useGizmoStore.getState().mode;
    if (liveMode === 'rotate') {
      // Convert the dragged WORLD orientation back to authored lookAt + roll,
      // keeping the seeded aim distance. Two params → two routed writes (a drag is
      // many undo entries, same as SingleGizmo; documented). #231 Inc 3.3 — for a
      // nested camera, strip the parent rotation and recover the lookAt about the
      // LOCAL position so the authored params stay in the camera's own space.
      const localPos = toLocalPoint(seed.position);
      let quat = g.quaternion;
      if (seed.parentWorld) {
        const pQuat = new THREE.Quaternion();
        seed.parentWorld.decompose(new THREE.Vector3(), pQuat, new THREE.Vector3());
        quat = pQuat.clone().invert().multiply(g.quaternion);
      }
      const { lookAt, roll } = lookAtRollFromQuat(quat, localPos, seed.distance);
      writeCameraParam('lookAt', lookAt);
      writeCameraParam('roll', roll);
    } else {
      // translate (scale coerces here — cameras have no scale): move position
      // only; the lookAt POINT stays put so the camera re-aims at it.
      writeCameraParam(
        'position',
        maybeSnapVec3(toLocalPoint([g.position.x, g.position.y, g.position.z])),
      );
    }
  }

  function onAimChange() {
    const g = aimNode;
    if (!g || !camId) return;
    writeCameraParam(
      'lookAt',
      maybeSnapVec3(toLocalPoint([g.position.x, g.position.y, g.position.z])),
    );
  }

  // #247 — the reticle drag delivers a WORLD lookAt point. Move the proxy
  // immediately (the seed effect only re-runs on scrub/selection, not on a param
  // write, so the reticle would otherwise lag the pointer), then author the LOCAL
  // lookAt through the same chokepoint.
  function onReticleDrag(world: Vec3) {
    if (!aimNode || !camId) return;
    aimNode.position.set(world[0], world[1], world[2]);
    writeCameraParam('lookAt', maybeSnapVec3(toLocalPoint(world)));
  }

  // *** D-06 grab observation seam — dev-guarded (mirrors SingleGizmo). Drives the
  // REAL onBodyChange/onAimChange so the boundary-pair observes the gizmo's own
  // write path. kind='rotate' takes an absolute euler (deg); 'translate'/'aim'
  // take a world point. ***
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.__basher_camera_gizmo_grab = (
      kind: 'rotate' | 'translate' | 'aim',
      target: [number, number, number],
    ) => {
      if (kind === 'aim') {
        if (!aimNode) return;
        aimNode.position.set(...target);
        onAimChange();
        return;
      }
      if (!bodyNode) return;
      useEditorStore.getState().setActiveTool(kind === 'rotate' ? 'rotate' : 'translate');
      if (kind === 'rotate') bodyNode.rotation.set(...degVec3ToRad(target));
      else bodyNode.position.set(...target);
      onBodyChange();
    };
  }

  if (!camId) return null;
  // The body gizmo is the ONE transform gizmo (rotate or translate; scale coerces
  // to translate — cameras have no scale). The lookAt is a target RETICLE (#247),
  // never a second triad.
  const bodyMode: GizmoMode = mode === 'rotate' ? 'rotate' : 'translate';
  return (
    <>
      <group ref={bodyRefCb} />
      {/* The aim proxy carries the billboarded lookAt reticle; its position is
          seeded to the (Track-To-resolved) lookAt, so a bound camera's reticle
          follows its target for free. */}
      <group ref={aimRefCb}>
        <CameraAimReticle
          bound={bound}
          disabled={playing}
          onDragStart={startGizmoDrag}
          onDrag={onReticleDrag}
          onDragEnd={() => endGizmoDrag('camera aim')}
        />
      </group>
      <AimConnector
        from={bodyNode}
        to={aimNode}
        color={bound ? RETICLE_BOUND_COLOR : RETICLE_COLOR}
      />
      {bodyNode ? (
        <TransformControls
          object={bodyNode}
          mode={bodyMode}
          space={orientation === 'local' ? 'local' : 'world'}
          enabled={!playing}
          onObjectChange={onBodyChange}
          onMouseDown={startGizmoDrag}
          onMouseUp={() => endGizmoDrag(`camera ${useGizmoStore.getState().mode}`)}
        />
      ) : null}
    </>
  );
}

// Dispatcher — route to the multi gizmo when >1 manipulable node is selected, a
// dedicated camera gizmo when the single selection is a camera (#229), else the
// single-node gizmo (byte-identical to pre-#225). Keeping the branch at the
// component boundary (not inside one body) honors rules-of-hooks: each
// sub-component owns its own hook set.
export function Gizmo() {
  // Reactively read BOTH stores so the dispatcher re-evaluates on either a
  // selection change or a DAG change (a node losing/gaining a position param).
  const selectedIds = useSelectionStore((s) => s.selectedNodeIds);
  const primaryId = useSelectionStore((s) => s.primaryNodeId);
  const nodes = useDagStore((s) => s.state.nodes);
  // #322 — THE ELEMENT-GIZMO GATE (Blender's object→element swap). When a control point of
  // the selected Curve is picked, the OBJECT gizmo yields: CurvePointHandles mounts a
  // translate gizmo on the POINT instead. Two TransformControls in one viewport would fight
  // over the pointer, and the director would have no way to tell which one a drag moves.
  // The one accessor decides (curvePointSelection.ts) — never a second read of the raw
  // store, so what hides the gizmo and what mounts the point gizmo are the same fact.
  const curvePoint = useActiveCurvePoint();
  let manipCount = 0;
  for (const id of selectedIds) if (getManipulable(nodes[id] ?? null)) manipCount++;
  if (curvePoint) return null;
  if (manipCount > 1) return <MultiGizmo />;
  const primary = primaryId ? nodes[primaryId] : null;
  if (primary && (primary.type === 'PerspectiveCamera' || primary.type === 'OrthographicCamera')) {
    return <CameraGizmo />;
  }
  return <SingleGizmo />;
}
