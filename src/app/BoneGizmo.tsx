// The pose-mode bone gizmo (#1336): move, rotate and scale the selected bone in the viewport.
//
// Shown in Pose mode with a bone selected; the object gizmo yields then (Gizmo.tsx), as it yields to
// a picked curve point (#322), so two gizmos never fight over a drag. The gizmo stands at the bone's
// head with the bone's world rotation — where Blender's pose-mode gizmo stands — and follows the
// pose as it plays.
//
// THE WRITE IS THE PANEL'S. A drag turns into the bone's new local transform (`boneGizmoMath.ts`)
// and goes through `commitObjectBonePose`, the function the inspector's pose row calls, which
// dispatches the agent's `mutator.animate.poseBone` (or a key, with Auto-Key on a keyed component).
// So the gizmo, the panel and the agent produce the same ops for the same pose. The whole drag is
// one undo step (`startGizmoDrag` / `endGizmoDrag`, shared with every other gizmo).
//
// #1337 — a drag places the bone as it is DRAWN, after every layer has blended, so the value is
// solved back through the layer stack (`layerValueForDrawn`) before it is stored or keyed: into an
// additive layer, or one at half weight, the bone then stays where the hand left it.
//
// The target is read from the graph at each move rather than taken from the last render, so a move
// acts on the graph as it is then. (The layer a write lands in does not depend on it:
// `handPoseOps` finds the layer itself.) Not pinned by a test: no case measured yet tells the two
// apart. Nor is the no-re-seed-mid-drag rule below, whose effect runs after a render, past the
// seam's reach; it keeps a scale drag from snapping the proxy back to scale 1 under the pointer.
//
// REF: src/app/boneGizmoMath.ts (the arithmetic); src/app/CurvePointHandles.tsx (the element-gizmo
//      precedent); src/app/animate/autoKeyCommit.ts; issue #1336.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { TransformGizmo } from './TransformGizmo';
import { endGizmoDrag, startGizmoDrag } from './Gizmo';
import { useDagStore } from '../core/dag/store';
import { useArmatureMode } from './armatureMode';
import { useActiveBone } from './boneSelection';
import { collectSkeletonObjects } from './skeletonObjects';
import { uiEvaluatorCache } from './uiEvaluatorCache';
import { useTimeStore } from './stores/timeStore';
import { useGizmoStore, type GizmoMode } from './stores/gizmoStore';
import { useNotificationStore } from './stores/notificationStore';
import { posedBoneMatrices } from '../nodes/armatureDeform';
import { poseTargetForBone, type PoseComponent } from './animate/poseTargetForBone';
import { commitObjectBonePose } from './animate/autoKeyCommit';
import { boneDragLocal, boneGizmoSeed, memberDegrees } from './boneGizmoMath';
import { layerValueForDrawn } from './animate/invertPoseStack';
import type { Quat, Vec3 } from '../nodes/types';
import type { PoseLayerParams } from '../nodes/PoseLayer';
import { eulerXYZFromQuat, type EulerOrder } from '../nodes/bonePose';
import { editSkeletonFromUI } from './skeletonEditActions';
import { useArmatureModeStore } from './stores/armatureModeStore';

const COMPONENT_OF: Record<GizmoMode, PoseComponent> = {
  translate: 'position',
  rotate: 'rotation',
  scale: 'scale',
};

/** The bone and its parent in the world at `seconds`, posed as drawn. */
function boneFrames(
  object: ReturnType<typeof collectSkeletonObjects>[number],
  index: number,
  seconds: number,
): { bone: THREE.Matrix4; parent: THREE.Matrix4 } {
  const world = new THREE.Matrix4().fromArray(object.world as number[]);
  const posed = posedBoneMatrices(object.bones, object.pose, seconds);
  const p = object.bones[index].parent;
  return {
    bone: world.clone().multiply(posed[index]),
    parent: p >= 0 && p < posed.length ? world.clone().multiply(posed[p]) : world,
  };
}

export function BoneGizmo() {
  const mode = useArmatureMode();
  const active = useActiveBone();
  const state = useDagStore((s) => s.state);
  const seconds = useTimeStore((s) => s.seconds);
  const playing = useTimeStore((s) => s.playing);
  const gizmoMode = useGizmoStore((s) => s.mode);
  const orientation = useGizmoStore((s) => s.orientation);

  const [proxy, setProxy] = useState<THREE.Group | null>(null);
  const proxyRefCb = useCallback((g: THREE.Group | null) => setProxy(g), []);
  /** The drag's frame of reference, captured at its start. */
  const dragRef = useRef<{
    bone: THREE.Matrix4;
    parent: THREE.Matrix4;
    proxy: THREE.Matrix4;
  } | null>(null);
  /** A refusal is said once per drag, not on every move. */
  const saidRef = useRef(false);

  // #1339 — Edit mode too: there the gizmo moves the bone's REST joint.
  const editing = mode === 'edit';
  const live = (mode === 'pose' || editing) && active !== null ? active : null;
  const object = useMemo(
    () =>
      live
        ? (collectSkeletonObjects(state, uiEvaluatorCache).find((o) => o.id === live.nodeId) ??
          null)
        : null,
    [state, live],
  );
  const target = useMemo(
    () => (live ? poseTargetForBone(state, live.nodeId, live.boneName, seconds) : null),
    [state, live, seconds],
  );
  const index = object && target ? object.bones.findIndex((b) => b.name === target.bone) : -1;
  const frames = useMemo(
    () =>
      object && index >= 0
        ? boneFrames(editing ? { ...object, pose: null } : object, index, seconds)
        : null,
    [object, index, seconds, editing],
  );

  // Seed the proxy where the bone stands, and re-seed as the pose plays — never mid-drag, where
  // the proxy is the director's hand and the bone follows it.
  useEffect(() => {
    if (!proxy || !frames || dragRef.current) return;
    boneGizmoSeed(frames.bone).decompose(proxy.position, proxy.quaternion, proxy.scale);
    proxy.updateMatrixWorld(true);
  }, [proxy, frames]);

  const begin = useCallback(() => {
    if (!proxy || !frames) return;
    proxy.updateMatrixWorld(true);
    dragRef.current = {
      bone: frames.bone,
      parent: frames.parent,
      proxy: proxy.matrixWorld.clone(),
    };
    saidRef.current = false;
    startGizmoDrag();
  }, [proxy, frames]);

  const end = useCallback(() => {
    dragRef.current = null;
    endGizmoDrag(`${editing ? 'edit' : 'pose'} ${live?.boneName ?? 'bone'}`);
  }, [live, editing]);

  const onObjectChange = useCallback(() => {
    const d = dragRef.current;
    if (!proxy || !d || !live) return;
    proxy.updateMatrixWorld(true);
    if (editing) {
      // #1339 — a rest edit: the joint's new local rest under its parent's rest, through the road
      // the Edit-mode keys and panel take. Children follow or stay per the inspector's toggle.
      const local = boneDragLocal(d.bone, d.proxy, proxy.matrixWorld, d.parent);
      const component = COMPONENT_OF[useGizmoStore.getState().mode];
      const value =
        component === 'rotation'
          ? eulerXYZFromQuat(local.quaternion)
          : component === 'position'
            ? local.position
            : local.scale;
      const res = editSkeletonFromUI(
        live.nodeId,
        {
          op: 'transform',
          bone: live.boneName,
          [component]: value,
          children: useArmatureModeStore.getState().editChildren,
        },
        `edit ${live.boneName}`,
      );
      if (!res.ok && !saidRef.current) {
        saidRef.current = true;
        useNotificationStore.getState().notify({ severity: 'info', message: res.reason });
      }
      return;
    }
    const now = poseTargetForBone(
      useDagStore.getState().state,
      live.nodeId,
      live.boneName,
      useTimeStore.getState().seconds,
    );
    if (!now) return;
    proxy.updateMatrixWorld(true);
    const component = COMPONENT_OF[useGizmoStore.getState().mode];
    const layer = now.layerId ? useDagStore.getState().state.nodes[now.layerId] : null;
    const member = (layer?.params as PoseLayerParams | undefined)?.members.find(
      (m) => m.bone === now.bone,
    );
    const order: EulerOrder =
      member && member.rotationMode !== 'quaternion' ? member.rotationMode : 'ZYX';
    const local = boneDragLocal(d.bone, d.proxy, proxy.matrixWorld, d.parent);
    const drawn = component === 'rotation' ? local.quaternion : local[component];
    // #1337 — what the layer must store so the bone is DRAWN where the hand put it, through every
    // layer's blend. No layer yet: the first pose inserts an override at weight 1 on top, which
    // stores the drawn value as it is.
    const solved = now.layerId
      ? layerValueForDrawn(
          useDagStore.getState().state,
          now.objectId,
          now.layerId,
          now.bone,
          component,
          drawn,
          useTimeStore.getState().seconds,
          uiEvaluatorCache,
        )
      : ({ ok: true, value: drawn } as const);
    const res = solved.ok
      ? commitObjectBonePose(
          now,
          component,
          component === 'rotation'
            ? memberDegrees(solved.value as Quat, order)
            : (solved.value as Vec3),
        )
      : solved;
    if (!res.ok && !saidRef.current) {
      saidRef.current = true;
      useNotificationStore.getState().notify({ severity: 'info', message: res.reason });
    }
  }, [proxy, live, editing]);

  // *** Dev-only observation seams — NOT user chrome (the curve point gizmo's shape). ***
  // Pointer simulation through TransformControls is fragile in headless Chromium, so e2e drives the
  // REAL code path: `grab` puts the proxy where a drag would leave it and calls the real
  // `begin` / `onObjectChange` / `end`, never a shortcut dispatch.
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.__basher_bone_gizmo = () =>
      proxy && frames
        ? {
            bone: target?.bone ?? null,
            position: proxy.position.toArray(),
            quaternion: proxy.quaternion.toArray(),
          }
        : null;
    w.__basher_bone_grab = (to: {
      position?: [number, number, number];
      quaternion?: [number, number, number, number];
      scale?: [number, number, number];
    }) => {
      if (!proxy || !frames) return false;
      begin();
      if (to.position) proxy.position.set(...to.position);
      if (to.quaternion) proxy.quaternion.set(...to.quaternion);
      if (to.scale) proxy.scale.set(...to.scale);
      onObjectChange();
      end();
      return true;
    };
  }

  if (!live || !frames) return null;
  return (
    <>
      <group ref={proxyRefCb} />
      {proxy ? (
        <TransformGizmo
          object={proxy}
          mode={gizmoMode}
          space={orientation === 'local' ? 'local' : 'world'}
          enabled={!playing}
          onObjectChange={onObjectChange}
          onMouseDown={begin}
          onMouseUp={end}
        />
      ) : null}
    </>
  );
}
