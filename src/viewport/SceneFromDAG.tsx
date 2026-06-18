// Walks the evaluated DAG output and emits R3F primitives + PostFx.
//
// One read path: subscribe to useDagStore, evaluate('render', ctx), interpret
// the resulting RenderOutputValue. The viewport NEVER mutates the DAG (V8).
// Click handlers (P1+) call dispatch(setParam) — they don't reach into THREE
// state.
//
// Stable keys per node id let React reconcile across param changes without
// remounting geometries — keeps acceptance #5 (<16ms inspector → viewport)
// in budget.
//
// P1: dispatcher is recursive — Transform/Group/MaterialOverride/Scatter are
// all SceneChild kinds. MeshChild walks them, threading an optional material
// override down to the leaf renderer.
//
// REF: THESIS.md §11, vyapti V8.

import { useGLTF } from '@react-three/drei';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
// #88: SkeletonUtils.clone, not Object3D.clone — see the GltfAssetR clone site.
// (SkeletonUtils is already a project dep; retarget.ts imports retargetClip from
// the same module. This is a NEW `clone` named import.)
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useResolvedAssetUrl } from '../app/asset/opfsLoader';
import { useBakedGeometry } from '../app/asset/bakedGeometryLoader';
import { useBakedTexture } from '../app/asset/bakedTextureLoader';
import { openpbrToThree, type ThreeMaterialParams } from '../app/material/openpbrToThree';
import { registerGltfClone, unregisterGltfClone } from '../app/asset/gltfCloneRegistry';
import { buildChildIdToObject, resolveChildObject } from './gltfChildObjects';
import { readGltfMaterials, nearestChildId } from '../app/asset/readGltfMaterials';
import { useGltfMaterialStore } from '../app/asset/gltfMaterialStore';
import { applyEditedMaps, hasMapEdits } from '../app/material/gltfMapOverlay';
import { getStorage } from '../app/boot';
import { useGltfLoaderExtend } from './gltfLoaderConfig';
import { useSelectionStore } from '../app/stores/selectionStore';
import { useTimeStore } from '../app/stores/timeStore';
import { useTransientEditStore } from '../app/stores/transientEditStore';
import { overlayTransients } from '../app/overlayTransients';
import {
  directChannelNodesForTarget,
  channelValuesFromNodes,
  directChannelTargetSet,
} from '../app/nodeChannels';
import { constraintTargetSet, resolveConstraintRotation } from '../app/nodeConstraints';
import { overlayChannels } from '../nodes/overlayChannels';
import { useDrillStore } from '../app/stores/drillStore';
import { buildGltfDrillChain, type Obj3DLike } from './gltfDrillChain';
import { useViewportStore } from '../app/stores/viewportStore';
import { LightHelper } from './LightHelpers';
import { CameraHelper } from './CameraHelpers';
import { cameraPoseFromNode, selectActiveCameraNode } from '../app/activeCamera';
import { resolveCameraDof } from '../app/cameraDof';
import { degVec3ToRad } from './rotation';
import { resolveAllChildTrs, type ChildOverride } from '../app/resolveGltfChildTransform';
import { bakedChannelSamplersForAsset, sampleBakedChannel } from '../app/bakedGltfChannels';
import { gltfAssetDepNodes } from '../app/gltfAssetDeps';
import { bumpRenderCount } from '../perf/renderCounter';
import type { BakedChannel } from '../app/resolveGltfChildTransform';
import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import { createEvaluatorCache } from '../core/dag/evaluator';
import { useDagStore } from '../core/dag/store';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { shallow } from 'zustand/shallow';
import type { DagState } from '../core/dag/state';
import { PostFx } from '../render/PostFx';
import { SceneEnvironment } from './SceneEnvironment';
import { DiffOverlay } from './DiffOverlay';
import { AssetErrorBoundary } from './AssetErrorBoundary';
import { resolveMaterialOverrideFields } from './materialOverrideMerge';
import type {
  AmbientLightValue,
  AreaLightValue,
  BakedMeshValue,
  BoxMeshValue,
  CharacterValue,
  DirectionalLightValue,
  GltfAssetValue,
  GroupValue,
  LightValue,
  MaterialOverrideValue,
  InlineMaterialSpec,
  MaterialValue,
  PointLightValue,
  RenderOutputValue,
  ScatterValue,
  SceneChild,
  SpotLightValue,
  SphereMeshValue,
  TransformValue,
  Vec3,
} from '../nodes/types';

let rectAreaInit = false;
function ensureRectAreaInit() {
  if (rectAreaInit) return;
  RectAreaLightUniformsLib.init();
  rectAreaInit = true;
}

interface SceneFromDAGProps {
  /** Override the named output to render. Defaults to 'render'. */
  outputName?: string;
}

export function SceneFromDAG({ outputName = 'render' }: SceneFromDAGProps) {
  const state = useDagStore((s) => s.state);
  // P7.10 (B13 Pass 3, #114) — time subscriptions REMOVED.
  //
  // Pre-P7.10 this component subscribed to `useTimeStore.seconds/frame/normalized`
  // so it could thread them into `evaluate(ctx)` — and SceneFromDAG (with the
  // whole downstream React tree) re-rendered on every Clock rAF tick. That's
  // B13: at 8 Fox.glb instances react.p95 hit 24ms (H48 2nd-occurrence).
  //
  // Pass 3 lifts time INTO time-dependent VALUE shapes (TransformClipValue now
  // carries `.sample(seconds)`). Animated consumers (GltfAssetR's useFrame)
  // read live time locally via `useTimeStore.getState()` and invoke the
  // closure at consumer cadence. SceneFromDAG no longer needs to subscribe
  // to time at all — it re-renders ONLY on `useDagStore.state` changes.
  // ctx.time below is frozen at zero — kept for evaluator signature
  // compatibility, but no impure node consumes ctx.time anymore (TransformClip
  // dropped its `time` input socket in PLAN 7.10 Wave A; TimeSource is the
  // sole impure node left and has no DAG consumers post-Wave B).
  //
  // Single shared cache across renders; param edits invalidate via content
  // hash. With ctx.time frozen, impure-node cache keys no longer flip per
  // frame — TransformClip cache HITS across renders, so value.transformClip
  // is a referentially-stable closure. That stability is what unlocks Pass 1's
  // React.memo on MeshChild to short-circuit per-fox reconciliation during
  // playback.
  const cache = useMemo<EvaluatorCache>(() => createEvaluatorCache(), []);

  // Light helpers display only when shading isn't 'rendered'. Subscribed
  // here so the top-level result re-renders when the user toggles modes.
  const shading = useViewportStore((s) => s.shading);
  const showLightHelpers = shading !== 'rendered';
  // #165: editor-only camera frustums hide in rendered mode (production
  // parity) and the active camera's own frustum hides while looking through
  // it (you're inside it — drawing it would clutter the preview).
  const lookThrough = useViewportStore((s) => s.lookThroughCamera);

  const target = state.outputs[outputName];
  if (!target) return null;

  const result = evaluate(state, target.node, {
    cache,
    ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
  });
  const value = result.value as RenderOutputValue;

  // Map each top-level scene child to its producer nodeId so click-to-select
  // can route a viewport hit back to a DAG node. The Scene aggregator's
  // `inputs.children` is a list of NodeRefs; index i in `value.scene.children`
  // corresponds to index i in that list.
  const sceneRef = state.outputs.scene;
  const sceneNode = sceneRef ? state.nodes[sceneRef.node] : null;
  const childRefs =
    sceneNode && Array.isArray(sceneNode.inputs.children)
      ? (sceneNode.inputs.children as { node: string; socket: string }[])
      : [];
  const lightRefs =
    sceneNode && Array.isArray(sceneNode.inputs.lights)
      ? (sceneNode.inputs.lights as { node: string; socket: string }[])
      : [];

  // v0.7 unification (#197) — the set of nodes driven by free-floating direct
  // channels, built in ONE pass so the child map below is O(N), not O(N²). A
  // child in this set (and not an AnimationLayer) overlays its channels via
  // DirectChannelsR. Excludes layer-wired channels (the coexistence guard lives
  // in nodeChannels.ts).
  const directChannelTargets = directChannelTargetSet(state.nodes);

  // #204 (epic #201) — the set of nodes constrained by an active Track-To, built
  // once (O(N)) so the child map tests membership in O(1), never O(N²) (B13). A
  // constrained child renders through ConstrainedR, which derives its rotation
  // from the aim (V58) instead of the authored/animated value.
  const constraintTargets = constraintTargetSet(state.nodes);

  // #165: enumerate ALL camera nodes in the DAG (Blender draws every camera
  // object, not just the active one). They are NOT in value.scene.children —
  // only one camera is wired to scene.camera — so we read them from state.
  const cameraNodeIds = Object.values(state.nodes)
    .filter((n) => n.type === 'PerspectiveCamera' || n.type === 'OrthographicCamera')
    .map((n) => n.id);
  const activeCameraId = selectActiveCameraNode(state)?.id ?? null;
  // UX #12 — the active camera's depth-of-field, resolved through the SAME pure
  // helper the offscreen still uses (cameraDof.ts) so the live bokeh matches the
  // rendered bokeh. null when DoF is off → PostFx mounts no DepthOfField.
  const activeDof = resolveCameraDof(activeCameraId ? state.nodes[activeCameraId] : null);

  return (
    <>
      {/* UX #9 — scene-level HDRI/IBL. Sets `scene.environment` (a scene
          PROPERTY, not a traversed object), so it survives the renderToImage
          chrome hide-pass (V37) and lights the production render for free.
          NEVER mark this editorChrome (V47). */}
      <SceneEnvironment value={value.scene.environment} />
      {/* #165: the DAG camera no longer mounts a makeDefault render camera
          here — the editor owns the view (EditorViewCamera) so DAG cameras
          become selectable frustum objects (CameraHelpers). */}
      {value.scene.lights.map((light, i) => (
        <LightNode key={`light:${i}`} value={light} />
      ))}
      {/* Editor-only wireframe helpers — show position/direction/range
          for every DAG light. Hidden in `rendered` mode so the screenshot
          / production parity stays clean. */}
      {showLightHelpers
        ? value.scene.lights.map((light, i) => (
            <LightHelper key={`helper:${i}`} value={light} pickId={lightRefs[i]?.node ?? null} />
          ))
        : null}
      {/* #165: selectable wireframe camera frustums. Hidden in rendered mode;
          the active camera's frustum also hides while looking through it. */}
      {showLightHelpers
        ? cameraNodeIds.map((id) => {
            const active = id === activeCameraId;
            if (active && lookThrough) return null;
            const pose = cameraPoseFromNode(state.nodes[id]);
            if (!pose) return null;
            return <CameraHelper key={`cam:${id}`} pose={pose} pickId={id} active={active} />;
          })
        : null}
      {/* Index `i` corresponds to the Scene aggregator's `inputs.children[i]`
          (childRefs) per the comment above. Each child renders through the
          MEMOIZED SceneChildNode so a single param edit re-renders ONE node, not
          all N (H48 / B13). */}
      {value.scene.children.map((child, i) => {
        const cpid = childRefs[i]?.node ?? null;
        return (
          <SceneChildNode
            key={`mesh:${i}`}
            value={child}
            pickId={cpid}
            // v0.7 unification (#197) — a node animated by free-floating direct
            // channels (V57) overlays via DirectChannelsR. Membership tested
            // against the ONE pre-built set (O(N) total, not O(N²)).
            hasDirectChannels={cpid != null && directChannelTargets.has(cpid)}
            // #204 — a node with an active Track-To renders through ConstrainedR
            // (derived aim rotation), taking precedence over DirectChannelsR.
            isConstrained={cpid != null && constraintTargets.has(cpid)}
          />
        );
      })}
      <MeshScaleProbe />
      {/* V8: scene contents come ONLY from the DAG. No fixtures, no fallbacks.
          If a project wants ambient fill, it adds an AmbientLight node. */}
      <DiffOverlay />
      <PostFx config={value.postFx} dof={activeDof} />
    </>
  );
}

// v0.6 #1 (Wave 3, C-3) — the H40 side-A observation seam. Reads the REAL
// rendered three.js object's WORLD scale by producer node id, so the boundary-
// pair e2e can assert rendered-scale == resolveEvaluatedMesh(...).transform.scale
// instead of inferring the render from node params (the #68/H58 trap). DEV-only,
// read-only (V8 clean — no DAG mutation, no store writes). Lives inside the Canvas
// (useThree) so it has the live scene root; resolves the object at CALL time so
// it always reports current state, never a render-time snapshot.
function MeshScaleProbe() {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, unknown>;
    w.__basher_mesh_world_scale = (nodeId: string): [number, number, number] | null => {
      const grp = scene.getObjectByName(nodeId);
      if (!grp) return null;
      // The wrapping group is named with the node id; its scale is identity, so
      // the inner mesh's world scale IS value.scale. Descend to the first Mesh.
      let target: THREE.Object3D | null = null;
      grp.traverse((o) => {
        if (!target && (o as THREE.Mesh).isMesh) target = o;
      });
      const obj: THREE.Object3D = target ?? grp;
      obj.updateWorldMatrix(true, false);
      const s = new THREE.Vector3();
      obj.getWorldScale(s);
      return [s.x, s.y, s.z];
    };
    // #149 (Wave C3) — the H40 side-A observation for the TRANSFORM transient.
    // Reads the REAL rendered object's WORLD position by group node id (the
    // wrapping group is named with the scene-child producer id — for an animated
    // cube that is the AnimationLayer id; the inner mesh carries the overlaid
    // position). The boundary-pair e2e asserts rendered position (side A) ==
    // resolveEvaluatedTransform (side B) == the typed transient, PAUSED. The
    // wrapping group is identity, so the inner mesh's world position IS the
    // rendered value. Read-only (V8 clean).
    w.__basher_mesh_world_position = (nodeId: string): [number, number, number] | null => {
      const grp = scene.getObjectByName(nodeId);
      if (!grp) return null;
      let target: THREE.Object3D | null = null;
      grp.traverse((o) => {
        if (!target && (o as THREE.Mesh).isMesh) target = o;
      });
      const obj: THREE.Object3D = target ?? grp;
      obj.updateWorldMatrix(true, false);
      const p = new THREE.Vector3();
      obj.getWorldPosition(p);
      return [p.x, p.y, p.z];
    };
    // #204 (epic #201) — the H40 side-A observation for a CONSTRAINT: the REAL
    // rendered object's WORLD quaternion [x,y,z,w] by node id. The Track-To
    // boundary-pair e2e asserts the rendered -Z axis (this quaternion applied to
    // (0,0,-1)) points from the object toward the aim target == the pure resolver
    // (resolveTrackTo / resolveEvaluatedTransform). Read-only (V8 clean).
    w.__basher_mesh_world_quaternion = (
      nodeId: string,
    ): [number, number, number, number] | null => {
      const grp = scene.getObjectByName(nodeId);
      if (!grp) return null;
      let target: THREE.Object3D | null = null;
      grp.traverse((o) => {
        if (!target && (o as THREE.Mesh).isMesh) target = o;
      });
      const obj: THREE.Object3D = target ?? grp;
      obj.updateWorldMatrix(true, false);
      const q = new THREE.Quaternion();
      obj.getWorldQuaternion(q);
      return [q.x, q.y, q.z, q.w];
    };
    // Phase 151 (Wave 2, SC-1/SC-2) — the H40 side-A observation for BakedMesh.
    // A baked mesh renders at IDENTITY scale (the transform is in the verts), so
    // `__basher_mesh_world_scale` always reports [1,1,1] for it. The size now
    // lives in the geometry bounds. This seam reports the REAL rendered object's
    // WORLD-space axis-aligned bounding-box DIMENSIONS by node id, so the
    // boundary-pair e2e asserts rendered bounds == resolver geometry bounds
    // (side A == side B) instead of inferring from params. Read-only (V8 clean).
    w.__basher_mesh_world_bounds = (nodeId: string): [number, number, number] | null => {
      const grp = scene.getObjectByName(nodeId);
      if (!grp) return null;
      let target: THREE.Mesh | null = null;
      grp.traverse((o) => {
        if (!target && (o as THREE.Mesh).isMesh) target = o as THREE.Mesh;
      });
      if (!target) return null;
      const mesh: THREE.Mesh = target;
      mesh.updateWorldMatrix(true, false);
      const box = new THREE.Box3().setFromObject(mesh);
      const size = new THREE.Vector3();
      box.getSize(size);
      return [size.x, size.y, size.z];
    };
    // Phase 151 (Wave 4, SC-6) — the H40 material side-A: read the RENDERED
    // material of a node by id (the BakedMesh's built three.js material). Converts
    // the lossless-material assertion from inference to observation: a baked
    // textured glTF child's reloaded BakedMesh must report map.image.width>0 +
    // srgb colorspace on the base map + the resolved color. Read-only (V8 clean).
    w.__basher_mesh_material = (
      nodeId: string,
    ): {
      color: string | null;
      hasMap: boolean;
      mapImageOk: boolean;
      mapColorSpace: string | null;
      roughness: number | null;
      metalness: number | null;
      type: string | null;
      opacity: number | null;
      clearcoat: number | null;
      transmission: number | null;
      // v0.6 #3 (#181, W2) — the live map UV placement (side A for the e2e).
      mapRepeat: [number, number] | null;
      mapOffset: [number, number] | null;
      mapRotation: number | null;
      mapCenter: [number, number] | null;
    } | null => {
      const grp = scene.getObjectByName(nodeId);
      if (!grp) return null;
      let target: THREE.Mesh | null = null;
      grp.traverse((o) => {
        if (!target && (o as THREE.Mesh).isMesh) target = o as THREE.Mesh;
      });
      if (!target) return null;
      const mat = ((target as THREE.Mesh).material as THREE.Material) ?? null;
      if (!mat) return null;
      const std = mat as THREE.MeshStandardMaterial;
      const phys = mat as THREE.MeshPhysicalMaterial;
      const map = std.map ?? null;
      const image = map?.image as { width?: number } | undefined;
      return {
        type: mat.type ?? null, // v0.6 #2 (W2): 'MeshPhysicalMaterial' for primitives now
        color: std.color ? `#${std.color.getHexString()}` : null,
        hasMap: map !== null,
        mapImageOk: Boolean(image && (image.width ?? 0) > 0),
        mapColorSpace: map ? map.colorSpace : null,
        // v0.6 #3 — read the cloned texture's actual repeat/offset/rotation/center.
        mapRepeat: map ? [map.repeat.x, map.repeat.y] : null,
        mapOffset: map ? [map.offset.x, map.offset.y] : null,
        mapRotation: map ? map.rotation : null,
        mapCenter: map ? [map.center.x, map.center.y] : null,
        roughness: typeof std.roughness === 'number' ? std.roughness : null,
        metalness: typeof std.metalness === 'number' ? std.metalness : null,
        opacity: typeof std.opacity === 'number' ? std.opacity : null,
        // v0.6 #2 (W2/2.3): the define-gating precondition — at coat/transmission=0
        // three compiles NO clearcoat/transmission GLSL (WebGLPrograms HAS_* > 0),
        // so a Physical material ≈ Standard cost. Deterministic, not a timing race.
        clearcoat: typeof phys.clearcoat === 'number' ? phys.clearcoat : null,
        transmission: typeof phys.transmission === 'number' ? phys.transmission : null,
      };
    };
    return () => {
      delete w.__basher_mesh_world_scale;
      delete w.__basher_mesh_world_bounds;
      delete w.__basher_mesh_material;
      delete w.__basher_mesh_world_position;
      delete w.__basher_mesh_world_quaternion;
    };
  }, [scene]);
  return null;
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

// [[B13]] Pass 1 — memoize the per-scene-child top-level dispatcher.
// The evaluator returns stable EvalResult references for cache hits
// (`evaluator.ts:132-138`), and `extractSocket` reads a property off
// that cached object — so `value.scene.children[i]` IS a stable reference
// across renders when the i-th child's content hash is unchanged. Default
// shallow-prop compare therefore short-circuits the entire MeshChild
// subtree reconciliation for any static child during an unrelated edit
// (the CHURN regime in `perf-scene-scale.spec.ts`) AND during playback
// for any pure subtree (no upstream impure dep). Time-driven subtrees
// (TransformClip-wrapped GltfAsset) still re-render every frame — that's
// the Pass 2 (imperative playback) lever. REF: [[H48]], dharana [[B13]].
// ---------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------

const LightNode = memo(function LightNode({ value }: { value: LightValue }) {
  switch (value.kind) {
    case 'DirectionalLight':
      return <DirectionalLightR value={value} />;
    case 'AmbientLight':
      return <AmbientLightR value={value} />;
    case 'PointLight':
      return <PointLightR value={value} />;
    case 'SpotLight':
      return <SpotLightR value={value} />;
    case 'AreaLight':
      return <AreaLightR value={value} />;
  }
});

/** Volume product of the (defensive) scale vec — drives power scaling
 *  on Point/Spot/Directional lights. AreaLight handles power via
 *  width/height multiplication instead, so it does NOT use this. */
function scalePower(scale: readonly [number, number, number] | undefined): number {
  const s = scale ?? [1, 1, 1];
  return Math.abs(s[0] * s[1] * s[2]);
}

function DirectionalLightR({ value }: { value: DirectionalLightValue }) {
  const ref = useRef<THREE.DirectionalLight | null>(null);
  // When rotation is non-zero, drive the light's target so direction =
  // rotation × (0,-1,0). When rotation is identity (default), leave
  // target at the origin — three.js's default behavior makes the light
  // shine from `position` toward (0,0,0), which preserves the legacy
  // seed scene's look (sun pointing roughly inward).
  // Defensive — old saved DirectionalLights pre-P2.6.3 don't have
  // rotation in their evaluated value. The evaluator now defaults but
  // this guard makes the renderer robust regardless.
  const [rx, ry, rz] = value.rotation ?? [0, 0, 0];
  const [px, py, pz] = value.position;
  const hasRotation = rx !== 0 || ry !== 0 || rz !== 0;
  useEffect(() => {
    const light = ref.current;
    if (!light) return;
    if (!hasRotation) {
      // Legacy default: target at origin.
      light.target.position.set(0, 0, 0);
      light.target.updateMatrixWorld();
      return;
    }
    // direction = rotation applied to (0,-1,0). target = position + dir.
    // params.rotation is in degrees — Euler expects radians.
    const [erx, ery, erz] = degVec3ToRad([rx, ry, rz]);
    const dir = new THREE.Vector3(0, -1, 0).applyEuler(new THREE.Euler(erx, ery, erz));
    light.target.position.set(px + dir.x, py + dir.y, pz + dir.z);
    light.target.updateMatrixWorld();
  }, [hasRotation, rx, ry, rz, px, py, pz]);
  // Power scales with the scale vec's volume product — bigger gizmo =
  // brighter sun. Round-trip stays clean: value.intensity stays raw,
  // multiplication is a render-side projection.
  const intensity = value.intensity * scalePower(value.scale);
  return (
    <directionalLight
      ref={ref as React.MutableRefObject<THREE.DirectionalLight>}
      intensity={intensity}
      color={value.color}
      position={value.position as [number, number, number]}
      castShadow={false}
    />
  );
}

function AmbientLightR({ value }: { value: AmbientLightValue }) {
  return <ambientLight intensity={value.intensity} color={value.color} />;
}

function PointLightR({ value }: { value: PointLightValue }) {
  // Power scales with scale-vec volume product (see scalePower above).
  const intensity = value.intensity * scalePower(value.scale);
  return (
    <pointLight
      intensity={intensity}
      color={value.color}
      position={value.position as [number, number, number]}
      distance={value.distance}
      decay={value.decay}
    />
  );
}

function SpotLightR({ value }: { value: SpotLightValue }) {
  const ref = useRef<THREE.SpotLight | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.target.position.set(...value.target);
    ref.current.target.updateMatrixWorld();
  }, [value.target]);
  // Power scales with scale-vec volume product.
  const intensity = value.intensity * scalePower(value.scale);
  return (
    <spotLight
      ref={ref as React.MutableRefObject<THREE.SpotLight>}
      intensity={intensity}
      color={value.color}
      position={value.position as [number, number, number]}
      angle={value.angle}
      penumbra={value.penumbra}
      distance={value.distance}
      decay={value.decay}
    />
  );
}

function AreaLightR({ value }: { value: AreaLightValue }) {
  ensureRectAreaInit();
  const ref = useRef<THREE.RectAreaLight | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.lookAt(new THREE.Vector3(...value.lookAt));
  }, [value.lookAt, value.position]);
  // AreaLight has a real geometric extent — scale.x multiplies width
  // and scale.y multiplies height so the gizmo's scale gesture maps
  // 1:1 onto the lit rectangle. Defensive default for legacy projects.
  const scale = value.scale ?? [1, 1, 1];
  const width = value.width * scale[0];
  const height = value.height * scale[1];
  return (
    <rectAreaLight
      ref={ref as React.MutableRefObject<THREE.RectAreaLight>}
      intensity={value.intensity}
      color={value.color}
      width={width}
      height={height}
      position={value.position as [number, number, number]}
    />
  );
}

// ---------------------------------------------------------------------------
// Mesh dispatcher (recursive)
// ---------------------------------------------------------------------------

interface MeshChildProps {
  value: SceneChild;
  /** Inherited material override pushed down by an ancestor MaterialOverride. */
  override?: MaterialValue;
}

const MeshChild = memo(function MeshChild({ value, override }: MeshChildProps) {
  switch (value.kind) {
    case 'BoxMesh':
      return <BoxMeshR value={value} override={override} />;
    case 'SphereMesh':
      return <SphereMeshR value={value} override={override} />;
    case 'BakedMesh':
      return <BakedMeshR value={value} override={override} />;
    case 'GltfAsset':
      // #83 gap 2 — per-asset error boundary. A load/parse failure
      // (bad bytes, unsupported extension, missing #82 sibling, Draco
      // decode fail) is caught here, reported to the assetErrorStore,
      // and rendered as nothing — so one broken asset can't blank the
      // whole viewport. Keyed by assetRef so a swapped asset remounts
      // fresh and re-attempts.
      return (
        <AssetErrorBoundary key={value.assetRef} assetRef={value.assetRef}>
          <GltfAssetR value={value} override={override} />
        </AssetErrorBoundary>
      );
    case 'Transform':
      return <TransformR value={value} override={override} />;
    case 'Group':
      return <GroupR value={value} override={override} />;
    case 'MaterialOverride':
      return <MaterialOverrideR value={value} override={override} />;
    case 'Scatter':
      return <ScatterR value={value} override={override} />;
    case 'Character':
      return <CharacterR value={value} />;
  }
});

interface SceneChildNodeProps {
  value: SceneChild;
  /** Producing DAG node id (for click-to-select + the MeshScaleProbe name). */
  pickId: string | null;
  /** v0.7 (#197) — this node is driven by free-floating direct channels, so its
   *  value is overlaid by DirectChannelsR. A stable boolean (membership in the
   *  pre-built set) so the memo bails out for static nodes (H48). */
  hasDirectChannels: boolean;
  /** #204 — this node has an active Track-To: ConstrainedR derives its rotation
   *  from the aim (V58), taking precedence over DirectChannelsR (it overlays
   *  channels too). Stable boolean (membership in the pre-built set), H48. */
  isConstrained: boolean;
}

// The per-top-level-child WRAPPER, memoized. This is the lever that makes a
// single param edit re-render ONE node instead of all N (H48 / B13).
//
// Why this exists: SceneFromDAG subscribes to the whole `state`, so ANY edit
// re-runs its render and rebuilds every child. The leaf MeshChild was already
// memo'd, but each child was wrapped in an INLINE <group> with a fresh inline
// `onClick` closure every render — an unstable prop that forced React to
// reconcile all N wrapper fibers (~0.018ms each → ~13ms at 700 nodes) even
// though the meshes themselves were skipped. Lifting the wrapper into a memo'd
// component with a STABLE onClick (closes over `pickId` only; reads live DAG
// state via getState() at click time, never the render-time `state`) lets
// React bail out of every unchanged child's subtree.
//
// GENERAL over any property: the evaluator cache returns a stable `value` ref
// for every node that didn't change (SceneFromDAG.tsx:382 — "value.scene.
// children[i] IS a stable reference" for cache hits), regardless of WHICH param
// changed. So editing transform, material, colour, geometry, anything →
// only the edited node's `value` ref flips → only its SceneChildNode re-renders.
const SceneChildNode = memo(function SceneChildNode({
  value,
  pickId,
  hasDirectChannels,
  isConstrained,
}: SceneChildNodeProps) {
  const onClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (!pickId) return;
      e.stopPropagation();
      const sel = useSelectionStore.getState();
      // v0.7 #199: a node is its own scene child now (no AnimationLayer wrapper to
      // unwrap, V57), so the click selects the producing node directly.
      if (e.shiftKey) sel.selectAdditive(pickId);
      else sel.select(pickId);
      // UX #7: a single click on a DIFFERENT top-level node exits the drill
      // context, so a later Esc doesn't pop back into the model we left. We key
      // off the drill chain's ROOT (chain[0] === this pickId) rather than reset
      // unconditionally — a browser double-click fires two clicks on the SAME
      // node BEFORE onDoubleClick, and resetting those would defeat incremental
      // drilling. Same node → keep depth; new node → reset. (Empty-space clicks
      // reset via Viewport onPointerMissed.)
      const drill = useDrillStore.getState();
      if (drill.chain.length > 0 && drill.chain[0] !== pickId) drill.reset();
    },
    [pickId],
  );
  // UX #7 (drill-in): double-click drills ONE level deeper into a dense glTF
  // hierarchy toward the sub-mesh under the cursor (asset → body → wheel → leaf;
  // repeat to go deeper, Esc to pop out). The hit object reaches this wrapper
  // handler as `e.object` (R3F sets it to the intersected mesh; `e.eventObject`
  // is this wrapper) — map it to its GltfChild via the asset's nodeNameMap.
  const onDoubleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (!pickId) return;
      e.stopPropagation();
      const state = useDagStore.getState().state;
      const hit = (e.intersections?.[0]?.object ?? e.object) as unknown as Obj3DLike | null;
      const chain = buildGltfDrillChain(state, pickId, hit);
      const sel = useSelectionStore.getState();
      if (!chain || chain.length <= 1) {
        // not a drillable glTF hierarchy → behave like a normal select
        sel.select(pickId);
        return;
      }
      sel.select(useDrillStore.getState().drillInto(chain));
    },
    [pickId],
  );
  return (
    // v0.6 #1 (Wave 3, C-3) — name the wrapping group with its producer node id
    // so the DEV scale-probe seam (MeshScaleProbe) reads the REAL rendered
    // three.js object scale by node id (H40 side-A observation).
    <group name={pickId ?? undefined} onClick={onClick} onDoubleClick={onDoubleClick}>
      {isConstrained && pickId ? (
        // #204 — derived aim rotation (V58). ConstrainedR overlays channels too,
        // so it takes precedence over DirectChannelsR for a constrained node.
        <ConstrainedR value={value} pickId={pickId} />
      ) : hasDirectChannels && pickId ? (
        <DirectChannelsR value={value} pickId={pickId} />
      ) : (
        <MeshChild value={value} />
      )}
    </group>
  );
});

// v0.7 unification (#197) — renderer for a native node animated by FREE-FLOATING
// direct channels (no AnimationLayer wrapper); the native-mesh analogue of
// AnimationLayerR and the render-tree counterpart of the camera's
// resolveActiveCameraPoseAt. It:
//   1. Narrow-subscribes the channel NODES targeting `pickId` (shallow → under
//      structural sharing an unrelated edit leaves their refs untouched, so this
//      re-renders ONLY when THIS node's channels change — the gltfAssetDeps/H48
//      pattern). Layer-wired channels are excluded upstream (coexistence guard).
//   2. Builds their function-of-time values once per change (channelValuesFromNodes).
//   3. In a useFrame, samples them at the live time SNAPSHOT (never a time
//      subscription — H48) → overlayChannels onto the base value (the SAME overlay
//      primitive AnimationLayerR uses — one band, no drift, H40) → overlayTransients.
// Mounted only for nodes in the pre-built direct-channel set, so a static scene
// pays zero cost (the boolean prop keeps SceneChildNode's memo bailing out).
function DirectChannelsR({
  value,
  pickId,
  override,
}: {
  value: SceneChild;
  pickId: string;
  override?: MaterialValue;
}) {
  const channelNodes = useStoreWithEqualityFn(
    useDagStore,
    (s) => directChannelNodesForTarget(s.state.nodes, pickId),
    shallow,
  );
  const channels = useMemo(() => channelValuesFromNodes(channelNodes), [channelNodes]);
  // Subscribe the transient SET so a PAUSED edit re-applies (the AnimationLayerR
  // #149 B2c mechanism; safe under H48 — `edits` is a stable empty Map ref during
  // playback). overlayChannels runs FIRST (committed curve), then the transient
  // overlays on top (the live uncommitted edit), keyed by this node's id.
  const transients = useTransientEditStore((s) => s.edits);
  const sample = (seconds: number): SceneChild =>
    overlayTransients(overlayChannels(value, channels, 1, seconds) ?? value, pickId, transients) ??
    value;

  const [patched, setPatched] = useState<SceneChild>(() => sample(useTimeStore.getState().seconds));
  const lastApplied = useRef<{
    seconds: number;
    channels: unknown;
    transients: unknown;
    value: unknown;
  } | null>(null);
  useFrame(() => {
    const seconds = useTimeStore.getState().seconds;
    if (
      lastApplied.current !== null &&
      lastApplied.current.seconds === seconds &&
      lastApplied.current.channels === channels &&
      lastApplied.current.transients === transients &&
      lastApplied.current.value === value
    ) {
      return;
    }
    lastApplied.current = { seconds, channels, transients, value };
    setPatched(sample(seconds));
  });
  return <MeshChild value={patched} override={override} />;
}

// #204 (epic #201) — renderer for a node with an active Track-To constraint. The
// constraint DERIVES the node's rotation from its world position → the aim target
// (V58); this is the render counterpart of the read-side override in
// resolveEvaluatedTransform — one band, two callers (render == read, H40). It also
// overlays free-floating channels + the held transient (a constrained node may be
// animated on position), then OVERRIDES rotation with the aim, every frame (the
// aim moves when the object OR the target moves). Mounted only for nodes in the
// pre-built constraint set, so a static scene pays nothing.
//
// Per-frame it re-resolves the aim via resolveConstraintRotation, which evaluates
// the render root through a STABLE local cache (createEvaluatorCache) — a content-
// hash cache HIT while the DAG is unchanged, so the per-frame cost is the world-
// transform matrix math, not a full re-eval (the SceneFromDAG cache pattern). v1
// scope: the aim is written as LOCAL rotation, correct for a TOP-LEVEL node (its
// wrapper group is identity → local == world); a nested constrained node is a
// follow-up (parentWorld⁻¹·aimWorld). See nodeConstraints.ts.
function ConstrainedR({
  value,
  pickId,
  override,
}: {
  value: SceneChild;
  pickId: string;
  override?: MaterialValue;
}) {
  const channelNodes = useStoreWithEqualityFn(
    useDagStore,
    (s) => directChannelNodesForTarget(s.state.nodes, pickId),
    shallow,
  );
  const channels = useMemo(() => channelValuesFromNodes(channelNodes), [channelNodes]);
  const transients = useTransientEditStore((s) => s.edits);
  const cache = useMemo<EvaluatorCache>(() => createEvaluatorCache(), []);

  const sample = (seconds: number): SceneChild => {
    const state = useDagStore.getState().state;
    const ctx = { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
    // channels (position) → transient → derived aim rotation (constraint wins on
    // rotation, the whole point of V58 — it is derived, never stored).
    let v =
      overlayTransients(overlayChannels(value, channels, 1, seconds) ?? value, pickId, transients) ??
      value;
    const aim = resolveConstraintRotation(state, pickId, ctx, cache);
    const rec = v as unknown as Record<string, unknown>;
    if (aim && 'rotation' in rec) {
      v = { ...rec, rotation: aim } as unknown as SceneChild;
    }
    return v;
  };

  const [patched, setPatched] = useState<SceneChild>(() => sample(useTimeStore.getState().seconds));
  useFrame(() => {
    // The aim depends on object + target world positions, both of which can move
    // every frame — so unlike DirectChannelsR there is no cheap (seconds,channels)
    // short-circuit; recompute each frame. Constrained nodes are few (the B13
    // membership gate keeps unconstrained nodes out of this path entirely).
    setPatched(sample(useTimeStore.getState().seconds));
  });
  return <MeshChild value={patched} override={override} />;
}

function applyOverride(
  baseColor: string,
  override: MaterialValue | undefined,
): {
  color: string;
  roughness: number;
  metalness: number;
  opacity: number;
  emissive: string;
  emissiveIntensity: number;
  transparent: boolean;
} {
  if (!override) {
    return {
      color: baseColor,
      roughness: 0.5,
      metalness: 0,
      opacity: 1,
      emissive: '#000000',
      emissiveIntensity: 0,
      transparent: false,
    };
  }
  return {
    color: override.color,
    roughness: override.roughness,
    metalness: override.metalness,
    opacity: override.opacity,
    emissive: override.emissive,
    emissiveIntensity: override.emissiveIntensity,
    transparent: override.opacity < 1,
  };
}

// v0.6 #2 (#178, W2) — the ONE shared primitive material builder for Box+Sphere.
// Mirrors BakedMeshR's imperative useMemo build (single writer V20): compile the
// OpenPBR IR via openpbrToThree (the one mapping site, V29) → MeshPhysicalMaterial.
// Standard→Physical is PERF-SAFE: at coat.weight=0/transmission.weight=0 the
// compiled shader carries no clearcoat/transmission GLSL — three gates the defines
// on `> 0` (WebGLPrograms.js:130,134 HAS_CLEARCOAT/HAS_TRANSMISSION; the setters
// MeshPhysicalMaterial.js:104,176 only recompile across the 0 boundary). roughness
// and clearcoatRoughness are set EXPLICITLY (three defaults are 1 and 0 — D-03).
// A MaterialOverride decorator (#99/#124) still wins WHOLESALE on its 7 scalars
// (backward-compat — a primitive has no source map); coat/transmission/ior/maps
// always come from the IR (the override carries no opinion on them).
function usePrimitiveMaterial(
  ir: InlineMaterialSpec,
  override: MaterialValue | undefined,
  shading: string,
): THREE.MeshPhysicalMaterial {
  const three = openpbrToThree(ir);
  const color = override ? override.color : three.color;
  const roughness = override ? override.roughness : three.roughness;
  const metalness = override ? override.metalness : three.metalness;
  const opacity = override ? override.opacity : three.opacity;
  const emissive = override ? override.emissive : three.emissive;
  const emissiveIntensity = override ? override.emissiveIntensity : three.emissiveIntensity;
  const transparent = override ? override.opacity < 1 : three.transparent;
  const wireframe = shading === 'wireframe';
  const { ior, clearcoat, clearcoatRoughness, transmission, thickness } = three;
  // v0.6 #2 (#178, W5) — suspense-load the 6 map slots UNCONDITIONALLY (rules-of-
  // hooks safe; useBakedTexture(null) is a no-op). The OPFS read + decode lives in
  // the loader hook, never in the resolver (V29). The ref carries the colorspace;
  // re-assert it here per slot (M5 — a data map as sRGB washes out), mirroring
  // BakedMeshR's sRGB/linear split.
  const mapTex = useBakedTexture(three.maps.map);
  const normalTex = useBakedTexture(three.maps.normalMap);
  const roughnessTex = useBakedTexture(three.maps.roughnessMap);
  const metalnessTex = useBakedTexture(three.maps.metalnessMap);
  const aoTex = useBakedTexture(three.maps.aoMap);
  const emissiveTex = useBakedTexture(three.maps.emissiveMap);
  // v0.6 #3 (#181, W2) — the ONE shared UV placement, applied to all 6 maps.
  const [tilingX, tilingY] = three.uvTransform.tiling;
  const [offsetX, offsetY] = three.uvTransform.offset;
  const uvRotation = three.uvTransform.rotation;
  const material = useMemo(() => {
    // v0.6 #3 (A-5): textures are cached & SHARED by hash (bakedTextureLoader),
    // so we CLONE per material before applying the UV transform — mutating the
    // shared instance would cross-contaminate every other material using that
    // image. The clone shares the image source; we own + dispose the clones (V20).
    const clones: THREE.Texture[] = [];
    const prep = (t: THREE.Texture | null, colorSpace: THREE.ColorSpace) => {
      if (!t) return null;
      const c = t.clone();
      c.colorSpace = colorSpace; // re-assert per slot (M5 — a data map as sRGB washes out)
      c.center.set(0.5, 0.5); // rotate/scale about the texture centre (Blender / KHR)
      c.repeat.set(tilingX, tilingY);
      c.offset.set(offsetX, offsetY);
      c.rotation = uvRotation;
      c.needsUpdate = true;
      clones.push(c);
      return c;
    };
    const m = new THREE.MeshPhysicalMaterial();
    m.color = new THREE.Color(color);
    m.roughness = roughness; // explicit — three default is 1 (D-03)
    m.metalness = metalness;
    m.opacity = opacity;
    m.transparent = transparent;
    m.emissive = new THREE.Color(emissive);
    m.emissiveIntensity = emissiveIntensity;
    m.ior = ior;
    m.clearcoat = clearcoat;
    m.clearcoatRoughness = clearcoatRoughness; // explicit — three default is 0
    m.transmission = transmission;
    m.thickness = thickness;
    m.wireframe = wireframe;
    // The 6 texture-map slots (D-04) — sRGB for colour maps, linear for data maps.
    m.map = prep(mapTex, THREE.SRGBColorSpace);
    m.normalMap = prep(normalTex, THREE.LinearSRGBColorSpace);
    m.roughnessMap = prep(roughnessTex, THREE.LinearSRGBColorSpace);
    m.metalnessMap = prep(metalnessTex, THREE.LinearSRGBColorSpace);
    m.aoMap = prep(aoTex, THREE.LinearSRGBColorSpace);
    m.emissiveMap = prep(emissiveTex, THREE.SRGBColorSpace);
    m.userData.__uvClones = clones; // disposed alongside the material below
    return m;
  }, [
    color,
    roughness,
    metalness,
    opacity,
    transparent,
    emissive,
    emissiveIntensity,
    ior,
    clearcoat,
    clearcoatRoughness,
    transmission,
    thickness,
    wireframe,
    mapTex,
    normalTex,
    roughnessTex,
    metalnessTex,
    aoTex,
    emissiveTex,
    tilingX,
    tilingY,
    offsetX,
    offsetY,
    uvRotation,
  ]);
  // Single writer (V20) owns the material AND its cloned textures — dispose both
  // on replace/unmount (Material.dispose does NOT free textures).
  useEffect(
    () => () => {
      material.dispose();
      (material.userData.__uvClones as THREE.Texture[] | undefined)?.forEach((t) => t.dispose());
    },
    [material],
  );
  return material;
}

function BoxMeshR({ value, override }: { value: BoxMeshValue; override?: MaterialValue }) {
  const shading = useViewportStore((s) => s.shading);
  const material = usePrimitiveMaterial(value.material, override, shading);
  return (
    <mesh
      position={value.position as [number, number, number]}
      rotation={degVec3ToRad(value.rotation as [number, number, number])}
      // v0.6 #1 (D-01) — apply the uniform TRS scale band, EXACTLY as TransformR
      // does on its <group> (line 978). `size` (the geometry below) is the
      // separate parametric capability; scale is the transform band the gizmo
      // drives. `?? [1,1,1]` is the C-1 / V10/H14 consumer-side hydrate guard.
      scale={(value.scale ?? [1, 1, 1]) as [number, number, number]}
    >
      <boxGeometry args={value.size as [number, number, number]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

function SphereMeshR({ value, override }: { value: SphereMeshValue; override?: MaterialValue }) {
  const shading = useViewportStore((s) => s.shading);
  const material = usePrimitiveMaterial(value.material, override, shading);
  return (
    <mesh
      position={value.position as [number, number, number]}
      rotation={degVec3ToRad(value.rotation as [number, number, number])}
      // v0.6 #1 (D-01) — uniform TRS scale band (see BoxMeshR). `radius`/segments
      // stay the parametric capability; scale is the transform band. C-1 guard.
      scale={(value.scale ?? [1, 1, 1]) as [number, number, number]}
    >
      <sphereGeometry args={[value.radius, value.widthSegments, value.heightSegments]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

// Phase 151 — BakedMeshR, the renderer for the Apply-Transform product (#151).
// THE FIRST renderer that reads geometry from the registry (Box/SphereR build
// inline via <boxGeometry>/<sphereGeometry>). The §48/V29 handle → registry path
// comes alive here:
//   - `useBakedGeometry(value.geometry)` suspends on the first render (the OPFS
//     read), primes geometryRegistry, then returns the cached BufferGeometry.
//     The viewport already wraps the scene in <Suspense> (glTF uses it).
//   - The mesh renders at IDENTITY scale [1,1,1] — the TRS is baked INTO the
//     verts, so applying value.scale would double-transform (H40 band drift).
//     position/rotation are kept for re-transform-after-Apply (a baked mesh is
//     first-class), but a fresh Apply produces identity TRS.
//   - It feeds the SAME wireframe + MaterialOverride path a Box gets (first-class
//     scene mesh, V20). Wave 2 built the SCALAR material; Wave 3 (t8) brings the
//     6 texture-map slots online — built imperatively per `materialClass` so a
//     baked glTF child reloads LOSSLESS (scalars + every map, correct colorspace).
//
// Why a built `THREE.Material` (useMemo) rather than the declarative
// `<meshStandardMaterial>` BoxMeshR uses: BakedMesh must (a) pick the three ctor
// from `spec.materialClass` (standard / physical / basic — a basic/unlit material
// has no roughness/metalness/emissive, the M1 in-guard) and (b) assign up to six
// suspense-loaded textures with EXPLICIT per-slot colorspace (M5 — a map loaded
// without sRGB washes out). A declarative element cannot select its own ctor or
// hold the async-loaded textures cleanly. The material is built fresh per node
// (single writer V20, same as Box's own material).
function BakedMeshR({ value, override }: { value: BakedMeshValue; override?: MaterialValue }) {
  const geom = useBakedGeometry(value.geometry);
  const shading = useViewportStore((s) => s.shading);
  const spec = value.material;

  // Suspense-load each of the 6 fixed map slots UNCONDITIONALLY (rules-of-hooks
  // safe — `useBakedTexture(null)` is a no-op; only present refs suspend). The
  // OPFS read + decode lives in the loader hook, never in the pure resolver (V29).
  const mapTex = useBakedTexture(spec.map);
  const normalTex = useBakedTexture(spec.normalMap);
  const roughnessTex = useBakedTexture(spec.roughnessMap);
  const metalnessTex = useBakedTexture(spec.metalnessMap);
  const aoTex = useBakedTexture(spec.aoMap);
  const emissiveTex = useBakedTexture(spec.emissiveMap);

  // The override wins on scalar color when present (#99/#124); otherwise the
  // baked spec's own captured scalars drive the material (a Box bake carries Box
  // defaults; a glTF bake carries the resolved post-override scalars).
  const scalar = override
    ? applyOverride(spec.color, override)
    : {
        color: spec.color,
        roughness: spec.roughness,
        metalness: spec.metalness,
        opacity: spec.opacity,
        emissive: spec.emissive,
        emissiveIntensity: spec.emissiveIntensity,
        transparent: spec.transparent,
      };

  const material = useMemo(() => {
    // Colorspace per slot (M5): base/emissive maps are sRGB; the data maps
    // (normal/ao/roughness/metalness) are linear. The texture loader already
    // restored the captured colorspace from the ref, but assign it AGAIN here so
    // the render-side contract is explicit and self-documenting at the boundary.
    const sRGB = (t: THREE.Texture | null) => {
      if (t) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const linear = (t: THREE.Texture | null) => {
      if (t) t.colorSpace = THREE.LinearSRGBColorSpace;
      return t;
    };

    if (spec.materialClass === 'basic') {
      // MeshBasicMaterial (KHR_materials_unlit) — NO roughness/metalness/emissive
      // (M1 in-guard). Only color + base map + opacity apply.
      const m = new THREE.MeshBasicMaterial({
        color: new THREE.Color(scalar.color),
        opacity: scalar.opacity,
        transparent: scalar.transparent,
        wireframe: shading === 'wireframe',
      });
      m.map = sRGB(mapTex);
      return m;
    }

    const m =
      spec.materialClass === 'physical'
        ? new THREE.MeshPhysicalMaterial()
        : new THREE.MeshStandardMaterial();
    m.color = new THREE.Color(scalar.color);
    m.roughness = scalar.roughness;
    m.metalness = scalar.metalness;
    m.opacity = scalar.opacity;
    m.transparent = scalar.transparent;
    m.emissive = new THREE.Color(scalar.emissive);
    m.emissiveIntensity = scalar.emissiveIntensity;
    m.wireframe = shading === 'wireframe';
    m.map = sRGB(mapTex);
    m.normalMap = linear(normalTex);
    m.roughnessMap = linear(roughnessTex);
    m.metalnessMap = linear(metalnessTex);
    m.aoMap = linear(aoTex);
    m.emissiveMap = sRGB(emissiveTex);

    if (spec.materialClass === 'physical' && spec.physical) {
      const p = m as THREE.MeshPhysicalMaterial;
      const ph = spec.physical;
      if (ph.clearcoat !== undefined) p.clearcoat = ph.clearcoat;
      if (ph.clearcoatRoughness !== undefined) p.clearcoatRoughness = ph.clearcoatRoughness;
      if (ph.transmission !== undefined) p.transmission = ph.transmission;
      if (ph.ior !== undefined) p.ior = ph.ior;
      if (ph.sheen !== undefined) p.sheen = ph.sheen;
      if (ph.specularIntensity !== undefined) p.specularIntensity = ph.specularIntensity;
    }
    return m;
  }, [
    spec.materialClass,
    spec.physical,
    scalar.color,
    scalar.roughness,
    scalar.metalness,
    scalar.opacity,
    scalar.transparent,
    scalar.emissive,
    scalar.emissiveIntensity,
    shading,
    mapTex,
    normalTex,
    roughnessTex,
    metalnessTex,
    aoTex,
    emissiveTex,
  ]);

  // Dispose the built material when it is replaced or the node unmounts — it is
  // owned here (single writer V20), so this renderer owns its lifecycle.
  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh
      position={value.position as [number, number, number]}
      rotation={degVec3ToRad(value.rotation as [number, number, number])}
      // IDENTITY scale — the transform is baked into the geometry verts (H40).
      scale={[1, 1, 1]}
    >
      <primitive object={geom} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

/**
 * P7.7 (#91) — derive the GltfChild override layer for one asset from the DAG
 * node table. Pure projection (no mutation): filter the nodes for
 * `type === 'GltfChild' && params.assetRef === assetRef`, keyed by childName.
 *
 * V8 is FILE-ROOTED: a read-only state access under `src/viewport/` is clean —
 * V8 forbids dispatch/setState/mutation, not reads. The threading alternative
 * (a `childNodes` field on GltfAssetValue) is UNREACHABLE, not merely a
 * preference: R-1 makes GltfChild INPUTLESS, so GltfAsset.evaluate has no input
 * edge to the children; the only way the evaluated value could carry them is a
 * raw sibling-state read inside the evaluator, which violates V2 (pure
 * evaluators are bit-exact over (params, inputs); a sibling-filter-by-assetRef
 * is not an input). So the viewport read-only filter is the ONLY V2-respecting
 * option.
 */
function childOverridesForAsset(
  nodes: DagState['nodes'],
  assetRef: string,
): Record<string, ChildOverride> {
  const out: Record<string, ChildOverride> = {};
  for (const node of Object.values(nodes)) {
    if (node.type !== 'GltfChild') continue;
    const p = node.params as {
      assetRef?: unknown;
      childName?: unknown;
      position?: Vec3;
      rotation?: Vec3;
      scale?: Vec3;
      overridden?: ChildOverride['overridden'];
    };
    if (p.assetRef !== assetRef || typeof p.childName !== 'string') continue;
    if (!p.position || !p.rotation || !p.scale || !p.overridden) continue;
    out[p.childName] = {
      position: p.position,
      rotation: p.rotation,
      scale: p.scale,
      overridden: p.overridden,
    };
  }
  return out;
}

// #178 (S3) — overlay a GltfChild's captured OpenPBR material (S2) onto the
// imported clone material, PRESERVING the clone's texture maps (S2 captured
// maps=null; textures stay with the clone until S5). For an UNEDITED material the
// captured scalars ARE the glTF's own factors, so re-applying them onto the
// still-textured clone is IDENTITY (colour × map is how glTF already composites)
// → pixel parity. Clones the source (never mutates the shared drei-cached material
// — V20/H36/H45 single-writer). Compiles through openpbrToThree (the one mapping
// site, V29), so a DAG material renders exactly like a native Box/Sphere one.
/**
 * Write the OpenPBR scalar/colour fields onto an EXISTING three.js material, IN
 * PLACE (no clone). The ONE field-mapping source (V20) shared by the static
 * overlay (`overlayDagMaterial`, which clones first) AND the per-frame material
 * animation (#188 `useFrame` below, which writes onto the already-cloned live
 * material — re-cloning per frame would churn GC). Property-guarded so an unlit
 * `MeshBasicMaterial` (KHR_materials_unlit — has `.color`/`.opacity` but no
 * `.roughness`/`.emissive`/physical lobes) doesn't throw. Maps are NEVER touched
 * (keep the clone's embedded/edited textures, S5).
 */
function applyOpenpbrScalars(mat: THREE.Material, tp: ThreeMaterialParams): void {
  const next = mat as THREE.MeshPhysicalMaterial;
  next.color?.set(tp.color);
  next.emissive?.set(tp.emissive);
  if ('emissiveIntensity' in next) next.emissiveIntensity = tp.emissiveIntensity;
  if ('opacity' in next) next.opacity = tp.opacity;
  // Only ADD transparency — never strip what the loader set from alpha modes /
  // extensions we don't capture yet (an edit lowering opacity still turns it on).
  if ('transparent' in next) next.transparent = next.transparent === true || tp.transparent;
  // metalness/roughness ARE the captured glTF factors → applying them onto a
  // mapped material is identity (the scalar multiplies its map, as in glTF).
  if ('roughness' in next) next.roughness = tp.roughness;
  if ('metalness' in next) next.metalness = tp.metalness;
  // Physical-only lobes — silently no-op on a plain MeshStandardMaterial.
  if ('ior' in next) next.ior = tp.ior;
  if ('clearcoat' in next) next.clearcoat = tp.clearcoat;
  if ('clearcoatRoughness' in next) next.clearcoatRoughness = tp.clearcoatRoughness;
  if ('transmission' in next) next.transmission = tp.transmission;
  if ('thickness' in next && tp.transmission > 0) next.thickness = tp.thickness;
}

function overlayDagMaterial(s: THREE.Material, ir: InlineMaterialSpec): THREE.Material {
  const next = s.clone() as THREE.MeshPhysicalMaterial;
  applyOpenpbrScalars(next, openpbrToThree(ir));
  // maps: intentionally NOT touched — keep the clone's embedded textures (S5).
  return next;
}

// #198 — one per-frame material-animation write target. `mat` is the slot's FINAL
// owned material (a per-slot clone). `reapplyOverride`, when present, re-layers a
// MaterialOverride tint's forced fields on top AFTER the animated base IR is
// written each frame (channel-over-override composition); absent for plain
// (un-overridden) animatable slots.
interface AnimSlot {
  mat: THREE.Material;
  reapplyOverride?: () => void;
}

function GltfAssetR({ value, override }: { value: GltfAssetValue; override?: MaterialValue }) {
  // H48 4th-occ gate — count this renderer's renders so the perf e2e can prove an
  // unrelated edit re-renders it 0×. DEV-only no-op in production (renderCounter).
  bumpRenderCount('GltfAssetR');
  // useResolvedAssetUrl turns OPFS-relative paths (e.g. "assets/cube.gltf")
  // into blob URLs; passthrough URLs (/foo, http://..., blob:) are returned
  // as-is. Both this hook and useGLTF are suspense-driven; the Canvas-root
  // Suspense boundary catches the throws.
  const url = useResolvedAssetUrl(value.assetRef);
  // #80: useDraco='/draco/' points at the SELF-HOSTED decoder (drei's
  // default is the Google CDN at `Gltf.js:8` — non-deterministic per
  // THESIS §48, and fails offline / behind a CSP; most real-world `.glb`
  // exports use Draco mesh compression). `extendLoader` wires KTX2
  // (Basis Universal texture compression — KHR_texture_basisu, common
  // in size-optimised exports), which drei does NOT wire by default.
  // Meshopt is already drei-default-on; nothing to do for it.
  const extendLoader = useGltfLoaderExtend();
  const gltf = useGLTF(url, '/draco/', true, extendLoader) as unknown as {
    scene: THREE.Group;
    // UX #7 / H90 — GLTFLoader records each loaded object's source glTF node
    // index here (every node, named or not — GLTFLoader.js:4311). The drill
    // stamp pairs it with the persisted keyByGltfNodeIndex.
    parser?: { associations?: Map<object, { nodes?: number }> };
  };
  // P7.5 R1: do NOT share the clone across instances — the per-child
  // TRS override below mutates this Object3D in-place. useMemo with
  // gltf.scene as dependency gives one clone per (component-instance,
  // source-scene) pair, which is correct here.
  // #88: SkeletonUtils.clone, not Object3D.clone(true). Plain Object3D.clone
  // leaves a cloned SkinnedMesh bound to the ORIGINAL bones — animating the
  // cloned joints (via the TRS override below) then deforms nothing (the
  // T-pose footgun). SkeletonUtils.clone rebinds SkinnedMesh.skeleton to the
  // cloned bones so the per-child TRS drives real deformation. It is a safe
  // superset: non-skinned subtrees fall through to standard clone, and the
  // per-instance / mutates-in-place rationale above is unchanged (still one
  // deep clone per component-instance).
  const cloned = useMemo(() => cloneSkinned(gltf.scene) as THREE.Group, [gltf.scene]);
  // Perf (H48 5th-occ follow-on) — a `name → Object3D` index built ONCE per clone.
  // The per-frame TRS re-apply + the suppress effect address children BY NAME; the
  // naive `cloned.getObjectByName(name)` is a recursive O(tree) search, so doing it
  // for all N children EVERY FRAME is ~N² node-visits (≈500k/frame on a 700-node
  // import) — the dominant cost when manipulating a child (measured ~415ms/frame on
  // the cicada). One `traverse` here makes every lookup O(1). First-in-DFS wins, so
  // it matches getObjectByName's pre-order semantics exactly (names are unique post
  // sanitization, so this is identical behaviour, just indexed). Rebuilt only on a
  // clone swap; TRS/visibility mutations never change names or structure, so the
  // index stays valid for the clone's life.
  const nameToObject = useMemo(() => {
    const m = new Map<string, THREE.Object3D>();
    cloned.traverse((o) => {
      if (o.name && !m.has(o.name)) m.set(o.name, o);
    });
    return m;
  }, [cloned]);
  // childId → clone object, built from the stamps below (the H90/V44 by-id
  // resolution for the per-child TRS + suppression consumers). A ref, not a
  // memo: the stamps are applied in the effect below (post-render), so the map
  // can only be built AFTER stamping — the effect populates it, and the
  // consumers (later effects + the useFrame) read the populated ref.
  const childIdToObject = useRef<Map<string, THREE.Object3D>>(new Map());
  // UX #7 / H90 — stamp each clone object that maps to a GltfChild with its DAG
  // node id, so viewport drill-in (buildGltfDrillChain) can address children by a
  // STAMPED ID rather than by name. The producer's nodeNameMap KEY space
  // (sanitizeBoneName + `__n` dedup, `node_i` for unnamed nodes) DIVERGES from
  // three's GLTFLoader clone NAME space (sanitizeNodeName + `_n` dedup, `''` for
  // unnamed) on real exports — ~28% of a dense model's meshes are unaddressable
  // by name. The glTF node INDEX is the one correspondence both sides agree on:
  // GLTFLoader records it on `gltf.parser.associations` for EVERY loaded object
  // (GLTFLoader.js:4311), and the import persists `keyByGltfNodeIndex` (index →
  // nodeNameMap key). We map original→clone by lockstep traversal — SkeletonUtils
  // clones children in array order, so index-paired walk is exact — read each
  // original's node index, and stamp the corresponding clone object. A
  // material-split `<unnamed>` sub-mesh carries a `.meshes` association (no
  // `.nodes`) → no stamp; the drill walk falls back to its nearest stamped
  // ancestor, which is the right target. The childId is globally unique
  // (content-addressed off assetRef), so it alone disambiguates which asset a hit
  // belongs to — no separate asset stamp is needed. Mutation is confined to the
  // per-instance clone (never the shared drei cache → no substrate leak,
  // B-substrate-purity); `basherGltfChildId` is a new userData key (no V20
  // single-writer collision with the TRS/material/visibility writers).
  // REF: gltfDrillChain.ts; H90.
  useEffect(() => {
    const assoc = gltf.parser?.associations;
    const keyByIndex = value.keyByGltfNodeIndex;
    // PRIMARY: index-based stamp (robust to the key↔name divergence, H90).
    if (assoc && Object.keys(keyByIndex).length > 0) {
      const stack: Array<[THREE.Object3D, THREE.Object3D]> = [[gltf.scene, cloned]];
      while (stack.length > 0) {
        const pair = stack.pop();
        if (!pair) break;
        const [orig, clone] = pair;
        const idx = assoc.get(orig)?.nodes;
        if (idx !== undefined) {
          const key = keyByIndex[String(idx)];
          const childId = key != null ? value.nodeNameMap[key] : undefined;
          if (childId) clone.userData.basherGltfChildId = childId;
        }
        const n = Math.min(orig.children.length, clone.children.length);
        for (let i = 0; i < n; i++) stack.push([orig.children[i], clone.children[i]]);
      }
    } else {
      // FALLBACK (pre-UX#7 saves: keyByGltfNodeIndex empty; or no associations) —
      // stamp the subset whose names DO match. Drill keeps a name-match fallback
      // for the unstamped remainder, so this is purely additive.
      for (const [name, childId] of Object.entries(value.nodeNameMap)) {
        const obj = nameToObject.get(name);
        if (obj) obj.userData.basherGltfChildId = childId;
      }
    }
    // Index the stamps so the TRS + suppression consumers can resolve a child by
    // its STAMPED id (immune to the H90 name divergence), not by `o.name`.
    childIdToObject.current = buildChildIdToObject(cloned);
  }, [cloned, gltf, nameToObject, value.nodeNameMap, value.keyByGltfNodeIndex]);
  const shading = useViewportStore((s) => s.shading);
  // P7.7 (#91) — SUBSCRIBED read (NOT a getState() snapshot): a gizmo setParam on
  // a GltfChild of THIS asset must re-render so the per-child override re-layers
  // and re-applies. A snapshot would not be a React dependency → the manual
  // override would silently never re-render (the H40 freeze / C2 snap-back).
  //
  // H48 4th-occurrence (#114-lineage) — but the OLD read subscribed to the WHOLE
  // node table (`s.state.nodes`), whose ref flips on EVERY dispatch (ops.ts
  // structural sharing replaces the `nodes` object even for an unrelated edit).
  // So editing ANY node — a sibling box — re-rendered this heavy asset and
  // re-walked all N nodes twice. On a ~700-node import that IS the "edit anything
  // → the imported model re-renders at ~16fps" cost. Fix: subscribe to ONLY the
  // nodes the layers depend on (this asset's GltfChild + baked KeyframeChannelVec3
  // nodes), compared with zustand `shallow`. Under structural sharing every
  // unchanged node keeps its ref, so an unrelated edit yields a shallow-EQUAL
  // array → no emit → no re-render. A relevant edit flips exactly one element's
  // ref → shallow detects it → re-render → re-layer (freeze guard preserved).
  // gltfAssetDeps.ts holds the collector + its proof. [[H48]] [[B13]] [[H40]].
  const depNodes = useStoreWithEqualityFn(
    useDagStore,
    (s) => gltfAssetDepNodes(s.state.nodes, value.assetRef, value.nodeNameMap),
    shallow,
  );
  // The pre-filtered node subset the two layer-derivations read. Keying the memos
  // on `depNodes` (stable across unrelated edits) keeps their results — and the
  // useFrame dirty-check below — referentially stable too.
  const depNodeMap = useMemo(() => {
    const m: Record<string, (typeof depNodes)[number]> = {};
    for (const n of depNodes) m[n.id] = n;
    return m;
  }, [depNodes]);
  const childOverrides = useMemo(
    () => childOverridesForAsset(depNodeMap, value.assetRef),
    [depNodeMap, value.assetRef],
  );
  // P7.12 (#108, C2) — the BAKED-CHANNEL layer: per-bone KeyframeChannel nodes
  // materialized by the copy-on-write bake (Wave D). SUBSCRIBED, like
  // childOverrides — an edit produces a NEW `nodes` object so this memo re-derives
  // and the next frame re-applies; but it does NOT subscribe to TIME (H48). The
  // samplers are function-of-time closures (V24); the useFrame below invokes them
  // at the same `seconds` snapshot it samples the clip at. Keyed by childName,
  // scoped to this asset by nodeNameMap membership (BLOCK-2). Dormant until the
  // bake mutator (D1) exists — no baked channel ⇒ empty map ⇒ pure clip behavior.
  const bakedChannels = useMemo(
    () => bakedChannelSamplersForAsset(depNodeMap, value.nodeNameMap),
    [depNodeMap, value.nodeNameMap],
  );
  // #188 (v0.7 Phase 3) — the MATERIAL-CHANNEL band, keyed childDagId → the
  // function-of-time channel VALUES targeting that child's `materials.*` paths.
  // Enumerated from depNodeMap (the narrow subscription — Slice 1 already filters
  // material channels in, so editing one re-renders here and this memo re-derives,
  // H40/H48), and built via the SHARED `channelValuesFromNodes` (one sampler source,
  // no parallel walk — V24/V57). The H105 layer-wired guard is a NO-OP here: a
  // material channel targets a GltfChild, which is NOT a scene producer, so no
  // AnimationLayer ever wraps it — applying the guard would require scanning the
  // whole node table (the H48 storm depNodeMap exists to avoid). Empty map ⇒ the
  // useFrame below early-returns ⇒ a static glTF pays zero per-frame cost.
  const materialChannelsByChild = useMemo(() => {
    const byChild = new Map<string, ReturnType<typeof channelValuesFromNodes>>();
    const nodesByChild = new Map<string, (typeof depNodeMap)[string][]>();
    for (const node of Object.values(depNodeMap)) {
      if (node.type !== 'KeyframeChannelNumber' && node.type !== 'KeyframeChannelColor') continue;
      const p = node.params as { target?: unknown; paramPath?: unknown };
      if (typeof p.target !== 'string' || !p.target) continue;
      if (typeof p.paramPath !== 'string' || !p.paramPath.startsWith('materials.')) continue;
      (nodesByChild.get(p.target) ?? nodesByChild.set(p.target, []).get(p.target)!).push(node);
    }
    for (const [childId, nodes] of nodesByChild) {
      byChild.set(childId, channelValuesFromNodes(nodes));
    }
    return byChild;
  }, [depNodeMap]);
  // #99 (P7.13) — per-clone capture of the IMPORTED material(s), keyed by mesh
  // uuid. The override effect re-derives from this ORIGINAL every time (never
  // from an already-overridden clone), so changing/removing the override never
  // compounds and removal restores faithfully. Reset on clone swap — declared
  // ABOVE the override effect so on a `[cloned]` change React runs this reset
  // first, then the override effect captures the new clone's fresh materials.
  const overrideOriginals = useRef<Map<string, THREE.Material | THREE.Material[]>>(new Map());
  useEffect(() => {
    overrideOriginals.current = new Map();
  }, [cloned]);
  // #188 (v0.7 Phase 3) / #198 (Phase 4) — the per-frame material-animation WRITE
  // TARGETS: each animatable slot's FINAL assigned material, keyed `childId` → array
  // indexed by local slot (primitive order, the same `localSlotByChild` counter the
  // override effect uses). `null` = NOT animatable (an array-material mesh, OR a slot
  // a FLATTEN override claimed — flatten ignores the base IR so animating it is
  // meaningless). A slot a MaterialOverride TINT claimed now records `{ mat,
  // reapplyOverride }` (#198): the useFrame writes the animated base IR onto `mat`,
  // then `reapplyOverride()` re-layers the tint's forced fields ON TOP — channel
  // animates the base, tint wins for its forced channels (composition). Rebuilt by
  // the override effect on every run (materials are re-cloned there); read by useFrame.
  const childSlotMaterials = useRef<Map<string, (AnimSlot | null)[]>>(new Map());
  // #99 (P7.13) — material override applied MATERIAL-FAITHFULLY. The old code
  // replaced every mesh material with a fresh `new MeshStandardMaterial(7 scalars)`,
  // which dropped imported maps (.map/.normalMap/.roughnessMap/.metalnessMap/
  // .aoMap/.emissiveMap) and downgraded a MeshPhysicalMaterial (KHR clearcoat/
  // transmission/sheen) to a plain MeshStandardMaterial — a textured asset
  // flattened to a blob the instant any override applied (#99).
  //
  // The fix CLONES the source material (Material.clone = `new this.constructor()
  // .copy(this)` → preserves the subclass AND all map refs; three.js 0.169
  // Material.js:424 / MeshStandardMaterial.copy L76-104) and overlays ONLY the
  // override fields that cannot corrupt richer source data (D-01 map-aware tint,
  // resolveMaterialOverrideFields): color/emissive/opacity always; roughness/
  // metalness only where the source has no corresponding map (those scalars
  // multiply their maps).
  //
  // We assign a fresh CLONE per mesh and never mutate the source material's
  // properties — `Mesh.copy` (Mesh.js:60) shares `.material` by reference across
  // clones + the useGLTF cache, so in-place mutation would corrupt every instance
  // (V20/H36/H45 single-writer landmine). Cloning + reassigning is the guard.
  useEffect(() => {
    const wireframe = useViewportStore.getState().shading === 'wireframe';
    // #178 S5 — meshes whose GltfChild material carries EDIT-LAYER texture-map
    // edits (a replaced or cleared slot). Collected during the synchronous
    // traverse; the baked textures are loaded + applied to the FINAL assigned
    // material asynchronously after the traverse (the load can't run inline). The
    // `cancelled` flag drops a stale load when the effect re-runs first.
    const mapWork: { mesh: THREE.Mesh; maps: InlineMaterialSpec['maps'] }[] = [];
    let cancelled = false;
    // #131 (D-05) — the coarse flatten / clay path. When the override asks to
    // ignore the source material, build a FRESH MeshStandardMaterial from the 7
    // scalars and drop the source's maps + subclass BY INTENT (the honest,
    // opt-in version of the old #99 wholesale-replace bug). This is a separate
    // primitive from the per-field `overridden` set (which forces individual
    // channels while keeping the clone + every other map): flatten ignores the
    // set entirely and replaces wholesale. Still single-writer (V20/H36/H45):
    // a fresh material per mesh, never a mutation of the shared source.
    const flatten = (override as MaterialValue | undefined)?.ignoreSourceMaterial === true;
    const clay = (o: MaterialValue): THREE.Material => {
      const next = new THREE.MeshStandardMaterial({
        color: new THREE.Color(o.color),
        roughness: o.roughness,
        metalness: o.metalness,
        emissive: new THREE.Color(o.emissive),
        emissiveIntensity: o.emissiveIntensity,
        opacity: o.opacity,
        transparent: o.opacity < 1,
        wireframe,
      });
      return next;
    };
    // #198 — apply the override's map-aware tint fields onto an OWNED material IN
    // PLACE. Extracted from `tint` so the per-frame material-animation loop can
    // re-layer the SAME tint on top of the animated base IR without re-cloning (the
    // clone is already owned). Reads map presence off `next` — clone() preserves the
    // source map refs, so the force-vs-map decision is identical to reading the source.
    // Property-guarded: GLTFLoader emits MeshStandard/MeshPhysical for normal meshes
    // (all PBR fields present), but KHR_materials_unlit yields a MeshBasicMaterial —
    // which has `.color`/`.opacity` but NO `.emissive`/`.roughness`/`.metalness`.
    // Set each field only when it exists; an unconditional `.emissive.set()` would
    // throw and break the whole traverse for an unlit asset.
    const applyTintFields = (next: THREE.Material): void => {
      const std = next as THREE.MeshStandardMaterial;
      const fields = resolveMaterialOverrideFields(
        override as MaterialValue,
        {
          roughnessMap: Boolean(std.roughnessMap),
          metalnessMap: Boolean(std.metalnessMap),
        },
        (override as MaterialValue).overridden, // #124 (V28): per-field force-vs-map
      );
      std.color?.set(fields.color);
      std.emissive?.set(fields.emissive);
      if ('emissiveIntensity' in std) std.emissiveIntensity = fields.emissiveIntensity;
      if ('opacity' in std) std.opacity = fields.opacity;
      if ('transparent' in std) std.transparent = fields.transparent;
      if (fields.roughness !== null && 'roughness' in std) std.roughness = fields.roughness;
      if (fields.metalness !== null && 'metalness' in std) std.metalness = fields.metalness;
      // NB: wireframe is deliberately NOT set here. applyTintFields runs per-frame
      // in the #198 composition reapplyOverride; the wireframe effect ([cloned,
      // shading]) is the SOLE runtime owner of `.wireframe`, so re-applying a
      // captured value here would overwrite a wireframe toggle made during
      // playback. `tint` sets it once at effect time (below) for fresh clones the
      // wireframe effect won't re-cover on an override-only change.
    };
    const tint = (s: THREE.Material): THREE.Material => {
      const next = s.clone() as THREE.MeshStandardMaterial;
      applyTintFields(next);
      // Effect-time only (a fresh clone an override-only change makes, which the
      // [cloned, shading] wireframe effect won't re-fire to cover); the per-frame
      // reapplyOverride never reaches this.
      if ('wireframe' in next) (next as THREE.MeshStandardMaterial).wireframe = wireframe;
      return next;
    };
    // v0.6 #2 (#178, W6 — D-05/D-07) — per-submesh addressing. A "slot" is the
    // i-th isMesh in this traverse (the SAME order the `__basher_gltf_meshes`
    // seam reports, so an e2e's side-A read aligns with this apply). The override
    // carries an optional `slotIndex`:
    //   - undefined ⇒ apply to EVERY slot (the #99/#124 whole-child behaviour —
    //     backward-compat; the p7.13/p124 e2e prove it stays byte-identical).
    //   - a number ⇒ apply ONLY to that slot; every OTHER slot keeps its imported
    //     material (so editing slot 1 leaves slot 0 untouched). Out-of-range ⇒ no
    //     slot matches ⇒ no-op (range-safe).
    const targetSlot = override ? (override as MaterialValue).slotIndex : undefined;
    let slotIdx = -1;
    // #178 (S3) — per-GltfChild local slot counter. A mesh maps to its GltfChild
    // by the nearest stamped ancestor (the H90/readGltfMaterials rule); the i-th
    // mesh under that child = the i-th captured material (primitive order).
    const localSlotByChild = new Map<string, number>();
    // #188 — rebuild the per-frame material-animation write targets each run (the
    // materials below are freshly cloned/assigned). A slot records its FINAL
    // material iff it is animatable (has a GltfChild, single material, no override
    // tint); `null` otherwise so the local-slot index stays aligned.
    childSlotMaterials.current = new Map();
    const recordSlot = (id: string, localIdx: number, slot: AnimSlot | null) => {
      const arr = childSlotMaterials.current.get(id) ?? [];
      arr[localIdx] = slot;
      childSlotMaterials.current.set(id, arr);
    };
    cloned.traverse((child) => {
      const m = child as THREE.Mesh;
      if (!m.isMesh) return;
      slotIdx += 1;
      // Capture the imported material(s) once, before any reassignment.
      if (!overrideOriginals.current.has(m.uuid)) {
        overrideOriginals.current.set(m.uuid, m.material);
      }
      const src = overrideOriginals.current.get(m.uuid)!;
      // #178 (S3) — the DAG-material base: overlay this slot's captured OpenPBR IR
      // onto the imported material (maps preserved). Absent (pre-#178 save / empty
      // node / array-material mesh) → keep the imported material verbatim (V10/H14
      // backward-compat). This base then feeds the MaterialOverride layer below.
      const childId = nearestChildId(m);
      let local = -1;
      if (childId) {
        local = (localSlotByChild.get(childId) ?? -1) + 1;
        localSlotByChild.set(childId, local);
      }
      let dagBase: THREE.Material | THREE.Material[] = src;
      if (childId && !Array.isArray(src)) {
        const irs = (
          depNodeMap[childId]?.params as { materials?: InlineMaterialSpec[] } | undefined
        )?.materials;
        const ir = irs?.[local];
        if (ir) dagBase = overlayDagMaterial(src, ir);
        // #178 S5 — defer this slot's edit-layer map application (replace/clear)
        // to the async pass below; it lands on the FINAL material `m.material`.
        if (ir && hasMapEdits(ir.maps)) mapWork.push({ mesh: m, maps: ir.maps });
      }
      // The override applies to THIS slot iff it exists AND either it is a
      // whole-child override (slotIndex undefined) or it addresses this exact
      // slot. Anything else keeps the imported material — no override, or a
      // per-slot override aimed at a DIFFERENT slot (the latter is what keeps
      // slot 0 unchanged when the director edits slot 1).
      const applies = Boolean(override) && (targetSlot === undefined || targetSlot === slotIdx);
      if (!applies) {
        // No override for this slot → render the DAG material (S3); if the child
        // carries none, dagBase === src (the imported material), unchanged.
        m.material = dagBase;
        // #188 — this slot is animatable iff it has a GltfChild + a single material
        // (the same scope overlayDagMaterial / per-child IR addressing requires).
        if (childId && local >= 0) {
          recordSlot(childId, local, Array.isArray(m.material) ? null : { mat: m.material });
        }
        return;
      }
      // Flatten ignores the base entirely (fresh clay per slot); the default path
      // clones the DAG base and overlays the override's map-safe fields ON TOP.
      const make = flatten ? () => clay(override as MaterialValue) : tint;
      m.material = Array.isArray(dagBase) ? dagBase.map(make) : make(dagBase);
      // #198 — channel-over-MaterialOverride COMPOSITION. A non-flatten TINT slot is
      // now animatable: the per-frame loop writes the animated base IR onto this OWNED
      // clone, then `reapplyOverride` re-layers the tint's forced fields ON TOP
      // (channel animates the base, tint wins for its forced channels). FLATTEN claims
      // the slot wholesale (clay ignores the base IR) → animating it is meaningless →
      // null. An ARRAY-material slot is not single-material addressable → null.
      if (childId && local >= 0) {
        if (!flatten && !Array.isArray(m.material)) {
          const claimed = m.material;
          recordSlot(childId, local, {
            mat: claimed,
            reapplyOverride: () => applyTintFields(claimed),
          });
        } else {
          recordSlot(childId, local, null);
        }
      }
    });
    // #178 S5 — apply edit-layer texture maps after the synchronous traverse has
    // assigned every final material. Loads happen off the React cycle; the
    // frameloop ("always") repaints once `needsUpdate` is set. `cancelled` (set
    // by the cleanup below) drops a stale load when the effect re-runs first.
    if (mapWork.length > 0) {
      void (async () => {
        const storage = await getStorage();
        for (const w of mapWork) {
          if (cancelled) return;
          if (Array.isArray(w.mesh.material)) continue;
          try {
            await applyEditedMaps(w.mesh.material, w.maps, storage, () => cancelled);
          } catch {
            // A missing/corrupt baked texture must not break the whole asset —
            // the slot keeps its imported texture (the inherit default).
          }
        }
      })();
    }
    // depNodeMap is a dep: editing a GltfChild's `materials` (S4) re-runs this
    // effect so the new OpenPBR scalars re-overlay onto the clone.
    return () => {
      cancelled = true;
    };
  }, [cloned, override, depNodeMap]);
  // Wireframe pass — flip every mesh material on the cloned scene. Runs
  // independent of override so toggling shading after the override is
  // applied still works.
  useEffect(() => {
    const wireframe = shading === 'wireframe';
    cloned.traverse((child) => {
      const m = child as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (mat && 'wireframe' in mat) {
          (mat as { wireframe: boolean }).wireframe = wireframe;
        }
      }
    });
  }, [cloned, shading]);
  // P151 (#151, Apply-Transform) — double-render SUPPRESSION. When a glTF child
  // is baked into a standalone BakedMesh (the Apply atomic composite), the asset
  // must stop rendering that child by name, or it renders twice. This effect is
  // the SOLE writer of `.visible` on the clone (a NEW property no TRS/material
  // writer touches — no V20 collision). It first RESTORES every named child to
  // visible, then hides the suppressed set, so removing a name (undo) un-hides
  // the child in the same pass. `Object3D.visible=false` skips render + raycast
  // for the subtree (three 0.169 propagates down), so a baked parent hides its
  // descendants too — reversible, no clone surgery. Subscribed to
  // value.suppressedChildren so the Apply setParam (new array ref) re-fires it.
  // REF: PLAN.md Wave 4 Task 9; RESEARCH §M7; the GltfChild double-render guard.
  useEffect(() => {
    const suppressed = new Set(value.suppressedChildren);
    const resolve = (name: string) =>
      resolveChildObject(name, value.nodeNameMap, childIdToObject.current, nameToObject);
    for (const name of Object.keys(value.nodeNameMap)) {
      const child = resolve(name); // H90/V44 — by stamped id, name fallback
      if (!child) continue;
      child.visible = !suppressed.has(name);
    }
    // Suppressed names may not be in nodeNameMap (defensive — a baked child's
    // key always is, but iterate the list too so an out-of-map key still hides).
    for (const name of suppressed) {
      const child = resolve(name);
      if (child) child.visible = false;
    }
  }, [cloned, nameToObject, value.suppressedChildren, value.nodeNameMap]);
  // P151 (#151, Apply-Transform) — register the mounted, post-override clone in
  // the PRODUCTION-SAFE live-clone registry so the non-React Apply helper can read
  // a GltfChild's resolved geometry + material off the exact object the renderer
  // drew (the bake-what-renders source of truth, H58/H59). NOT DEV-gated (unlike
  // __basher_gltf_meshes below) — Apply must work in production. Re-registers on
  // clone swap; unregisters on unmount (guarded so a late unmount can't clobber a
  // newer asset that re-took the assetRef). REF: gltfCloneRegistry.ts; Wave 4 t10.
  useEffect(() => {
    registerGltfClone(value.assetRef, cloned);
    return () => unregisterGltfClone(value.assetRef, cloned);
  }, [cloned, value.assetRef]);
  // UX #8 — publish a READ-ONLY material projection of the clone for the
  // inspector. The embedded glTF materials live only on this clone (not the
  // DAG), so the inspector can't see them without this bridge. Reads the
  // POST-override material (this effect is defined AFTER the override effect, so
  // it runs after on every shared commit → what's actually drawn, Lokayata) and
  // after the stamp effect (so each slot carries its childId). Cleared on
  // unmount. REF: readGltfMaterials.ts, gltfMaterialStore.ts; UX-BACKLOG #8.
  useEffect(() => {
    useGltfMaterialStore.getState().publish(value.assetRef, readGltfMaterials(cloned));
    return () => useGltfMaterialStore.getState().clearAsset(value.assetRef);
  }, [cloned, override, value.assetRef]);
  // P7.5 + P7.7 — per-child TRS override (consumer side of the H40
  // boundary-pair). This is the SOLE writer of per-child TRS onto the clone
  // (V20 / H36 / H33 — never add a second). It reads THREE layers and lets the
  // ONE layering primitive (resolveAllChildTrs, B1) pick per-component:
  //   manual GltfChild override (if overridden[field]) → clip track → base.
  // The base for each name is the GltfChild node's seeded TRS (captured static
  // base at import); with no node it falls back to the clip track.
  //
  // P7.7 REMOVED the old `if (!clip) return` early-out: children must still get
  // their manual/base TRS even with NO animation. The per-name guard inside
  // resolveAllChildTrs (omit names with neither node nor clip) replaces it.
  //
  // Rotation is degrees throughout the layering; convert at the THREE seam via
  // degVec3ToRad (same call all other .rotation consumers in this file use).
  //
  // [[B13]] Pass 2 (PR #115) → Pass 3 (P7.10, this commit) — useFrame samples
  // the closure-of-time directly from useTimeStore.getState(), NOT from a
  // value.transformClip ref that changes per frame.
  //
  // Pre-P7.10 value.transformClip carried a pre-sampled `.tracks` map produced
  // by TransformClip's evaluate at ctx.time. Its identity changed every
  // playback frame, which forced SceneFromDAG (subscribed to time) to re-render
  // and the whole React tree to walk per fox subtree — even with Pass 1's
  // memo, the new prop ref defeated it. The Pass 2 useFrame moved the TRS-write
  // loop OUT of React's commit, but the tree-walk itself stayed: H48's 2nd
  // occurrence measured react.p95 still ≈24ms @ 8 foxes.
  //
  // Pass 3 (P7.10): TransformClipValue is now a function-of-time
  // (`.sample(seconds)`). The cache key for TransformClip became stable across
  // frames (its evaluate now takes no `time` input — input hashes don't flip),
  // so value.transformClip is a referentially-stable closure across renders.
  // The hot path moves entirely OUT of React: useFrame reads live time from
  // useTimeStore (snapshot, fires every R3F rAF) and invokes the closure at
  // consumer cadence. The dirty-check keys on (seconds, childOverrides) so the
  // PAUSED case (seconds stable) skips the write loop, and an edit-while-playing
  // setParam (new childOverrides ref) re-applies on the next frame.
  //
  // Correctness: useFrame runs in the R3F frameloop OUTSIDE React's commit;
  // bones are updated in time for this frame's draw. The single-writer
  // V20/H36/H33 invariant still holds (this is still the sole TRS-writer onto
  // the clone). REF: PLAN 7.10 Wave C; H48 + B13 catalogue.
  const lastApplied = useRef<{ seconds: number; overrides: unknown; baked: unknown } | null>(null);
  useFrame(() => {
    const seconds = useTimeStore.getState().seconds;
    if (
      lastApplied.current !== null &&
      lastApplied.current.seconds === seconds &&
      lastApplied.current.overrides === childOverrides &&
      lastApplied.current.baked === bakedChannels
    ) {
      return;
    }
    // Sample the closure at live time. value.transformClip is a stable
    // referentially-equal closure across renders (P7.10 cache invariance);
    // .sample() is a pure call producing a fresh TRS map per invocation.
    const tracks = value.transformClip?.sample(seconds) ?? null;
    // P7.12 (#108, C2) — sample the baked-channel band at the SAME `seconds`
    // snapshot, per component, keyed by childName. A present component wins over
    // the clip (presence, R-4) inside resolveAllChildTrs. No new time
    // subscription: the samplers are invoked here in the existing useFrame.
    let bakedByName: Record<string, BakedChannel> | null = null;
    for (const name of Object.keys(bakedChannels)) {
      const baked = sampleBakedChannel(bakedChannels[name], seconds);
      if (baked) (bakedByName ??= {})[name] = baked;
    }
    const resolved = resolveAllChildTrs({
      names: Object.keys(value.nodeNameMap),
      childByName: childOverrides,
      tracks,
      bakedByName,
    });
    for (const [name, trs] of Object.entries(resolved)) {
      // H90/V44 — resolve by STAMPED id first (survives the producer↔clone name
      // divergence), name fallback for pre-UX#7 saves.
      const child = resolveChildObject(
        name,
        value.nodeNameMap,
        childIdToObject.current,
        nameToObject,
      );
      if (!child) continue;
      child.position.set(trs.position[0], trs.position[1], trs.position[2]);
      const radRot = degVec3ToRad(trs.rotation);
      child.rotation.set(radRot[0], radRot[1], radRot[2]);
      child.scale.set(trs.scale[0], trs.scale[1], trs.scale[2]);
    }
    lastApplied.current = { seconds, overrides: childOverrides, baked: bakedChannels };
  });
  // Re-apply on clone swap (asset reload) — the new clone has bind-pose TRS,
  // and the dirty-check above would short-circuit if clip/overrides happen to
  // be referentially equal to the last clone's apply.
  useEffect(() => {
    lastApplied.current = null;
  }, [cloned]);
  // #188 (v0.7 Phase 3) — the per-frame MATERIAL-ANIMATION write loop. The glTF
  // material analogue of the TRS useFrame above: the override EFFECT establishes the
  // material objects (clones, base IR overlay, override tint — the expensive,
  // structural step), and THIS useFrame overlays the animated scalar deltas onto
  // those already-cloned live materials each frame (cheap — re-cloning per frame
  // would churn GC, the same reason TRS writes `child.position.set` instead of
  // re-instantiating). Mirrors the TRS dirty-check exactly: snapshot live time (never
  // a time subscription — H48), skip when (seconds, channels) are unchanged so a
  // PAUSED scene pays nothing; early-out when no child animates a material.
  const lastMaterialApplied = useRef<{
    seconds: number;
    channels: unknown;
    transients: unknown;
  } | null>(null);
  useFrame(() => {
    if (materialChannelsByChild.size === 0) return;
    const seconds = useTimeStore.getState().seconds;
    // #198 (Phase 4, item 4) — snapshot the transient SET (NEVER subscribe — H48,
    // the frameloop is "always"). A material transient is held ONLY for an ANIMATED
    // field (routeAnimatedGrab finds a channel), so the channel guard above already
    // covers every child that can carry one; the transient just wins ON TOP below.
    const transients = useTransientEditStore.getState().edits;
    if (
      lastMaterialApplied.current !== null &&
      lastMaterialApplied.current.seconds === seconds &&
      lastMaterialApplied.current.channels === materialChannelsByChild &&
      lastMaterialApplied.current.transients === transients
    ) {
      return;
    }
    for (const [childId, channels] of materialChannelsByChild) {
      const slotMats = childSlotMaterials.current.get(childId);
      if (!slotMats) continue;
      const baseMaterials = (
        depNodeMap[childId]?.params as { materials?: InlineMaterialSpec[] } | undefined
      )?.materials;
      if (!baseMaterials) continue;
      // Overlay the channels onto the EVALUATED materials (H40 — read evaluated, not
      // a parallel sample) via the ONE overlay primitive (V57); weight 1 → the
      // sampled value wins. `writeAt` indexes the `materials.<slot>.<lobe>.<field>`
      // array path with NO setAtPath change (V53). One overlay per child handles all
      // its slots/fields at once. THEN overlay the transient ON TOP (transient >
      // channel — #198 item 4): an Auto-Key-OFF held edit on an animated material
      // field previews live, the SAME overlayTransients the native DirectChannelsR
      // uses (one band, two callers) so the RENDER matches the inspector read-side
      // (resolveEvaluatedParam) — no H40 "snaps right back" divergence.
      const animated = overlayTransients(
        overlayChannels({ materials: baseMaterials }, channels, 1, seconds) ?? {
          materials: baseMaterials,
        },
        childId,
        transients,
      )?.materials;
      if (!animated) continue;
      for (let i = 0; i < slotMats.length; i += 1) {
        const slot = slotMats[i];
        const ir = animated[i];
        // slot === null → not animatable (array-material / flatten-claimed slot); ir
        // absent → fewer captured materials than clone slots. Both: leave untouched.
        if (slot && ir) {
          applyOpenpbrScalars(slot.mat, openpbrToThree(ir));
          // #198 — re-layer the MaterialOverride tint's forced fields ON TOP of the
          // animated base IR (channel-over-override composition). No-op for plain
          // (un-overridden) animatable slots.
          slot.reapplyOverride?.();
        }
      }
    }
    lastMaterialApplied.current = { seconds, channels: materialChannelsByChild, transients };
  });
  // Re-apply on a structural rebuild (clone swap / override change / dep edit) — the
  // override effect (same deps) re-clones the materials, so the prior write targets
  // are stale; clear the dirty-check so the next frame re-applies onto the fresh
  // materials even if (seconds, channels) happen to be referentially equal.
  useEffect(() => {
    lastMaterialApplied.current = null;
  }, [cloned, override, depNodeMap]);
  // #88 (DEV-only) — observation seam for the skinned-deform e2e. The proof
  // that #88 works is that a skin-bound VERTEX moves (not just that a joint
  // Object3D animates — that already happens via the TRS effect above). That
  // vertex only exists on the rendered cloned SkinnedMesh, which nothing
  // exposes to e2e today. Mirror the gizmo's userData + window-getter pattern
  // (Gizmo.tsx:254): expose a live reader over the first SkinnedMesh in the
  // cloned tree. Read-only — no DAG mutation, no store writes (V8 clean).
  // Single-skinned-asset assumption (the e2e loads one), same stance as the
  // gizmo's single-selection getter.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let skinned: THREE.SkinnedMesh | null = null;
    cloned.traverse((child) => {
      if (skinned) return;
      if ((child as THREE.SkinnedMesh).isSkinnedMesh) skinned = child as THREE.SkinnedMesh;
    });
    if (!skinned) return; // don't clobber a registered getter with a non-skinned sibling
    const mesh: THREE.SkinnedMesh = skinned;
    mesh.userData.__basher_skin = {
      boneCount: mesh.skeleton ? mesh.skeleton.bones.length : 0,
      bound: Boolean(mesh.skeleton && mesh.skeleton.bones.length > 0),
      // Live reader: computes the CPU-skinned vertex (three 0.169) at CALL
      // time, in world space, so reads at t=0 vs t=mid reflect the current
      // bone-matrix palette. Call this inside page.evaluate (the function
      // does not cross the Playwright boundary — its result does).
      vertex: (i: number): [number, number, number] => {
        const v = new THREE.Vector3();
        mesh.getVertexPosition(i, v);
        mesh.localToWorld(v);
        return [v.x, v.y, v.z];
      },
      // P7.11 (#100) — the RENDER side of the H40 boundary-pair. The render
      // skeleton's bones are in `skin.joints[]` order (GLTFLoader builds them
      // that way, RESEARCH B1/B7), the SAME spine the pure `GltfSkeleton`
      // projection emits. So `boneName(i)` (raw glTF node name) sanitized ==
      // the projected `bones[i].name` (sanitized at import) index-by-index —
      // the F6a both-sides equality. Read-only.
      boneName: (i: number): string | null => mesh.skeleton?.bones[i]?.name ?? null,
      // Bone local rotation (radians, XYZ Euler) at CALL time — drives the
      // H46 rotation-delta proof (limbs rotate under playback; position is a
      // constant bind offset → exact-zero false-negative if sampled instead).
      boneRotation: (i: number): [number, number, number] | null => {
        const b = mesh.skeleton?.bones[i];
        if (!b) return null;
        const e = new THREE.Euler().setFromQuaternion(b.quaternion, 'XYZ');
        return [e.x, e.y, e.z];
      },
    };
    const w = window as unknown as Record<string, unknown>;
    w.__basher_gltf_skin = () =>
      (mesh as unknown as { userData: Record<string, unknown> }).userData.__basher_skin ?? null;
  }, [cloned]);
  // P7.9 Wave F Task 12 (DEV-only) — observation seam for the disk-import
  // Lokayata gate. The proof that a multi-file `.gltf` rendered TEXTURED is
  // that one of the cloned Meshes carries a non-null `material.map`. That
  // surface only exists on the cloned three.js tree — nothing else in the
  // app exposes it. Mirror the `__basher_gltf_skin` pattern (line 597-599):
  // a DEV-only window getter that walks the cloned tree and returns the
  // serializable mesh summary. Read-only — no DAG mutation, no store writes
  // (V8 clean). Single-asset assumption (the e2e loads one); a later asset
  // mounting will clobber the getter, which is fine for the test.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, unknown>;
    w.__basher_gltf_meshes = () => {
      const summary: Array<{
        // v0.6 #2 (#178, W6) — the per-MESH slot index, matching the override
        // effect's `slotIdx` (incremented per isMesh in the SAME traverse). A
        // MaterialOverride with `slotIndex===slot` addresses exactly this entry.
        // For a material-ARRAY mesh every entry shares the mesh's slot (the
        // override treats one mesh = one slot, applying `make` to each array elem).
        slot: number;
        name: string;
        hasMap: boolean;
        mapImageOk: boolean;
        color: string | null;
        metalness: number | null;
        roughness: number | null;
        hasMetalnessMap: boolean;
        hasRoughnessMap: boolean;
        // P151 Wave 4 t11 — the original child's WORLD-space bounds (three-way
        // verts boundary-pair: original child == resolver baked == rendered baked)
        // and its render VISIBILITY (suppression: false after the child is baked).
        worldBounds: [number, number, number];
        visible: boolean;
        // P151 Wave 3 t7 (LOKAYATA PROBE) — per-`map` texture-readback diagnostic
        // on the CLONED child material. The bake (Wave 4) must decide whether it
        // can copy the ORIGINAL compressed bytes (path 1, lossless) or must fall
        // back to a canvas readback (path 2). That decision hinges on whether a
        // source-URI association survives `SkeletonUtils.clone` (RESEARCH §M4 —
        // a MEDIUM-confidence runtime question). This field reports, for the base
        // color `map`, which association-bearing surface is actually present so we
        // OBSERVE the path rather than infer it.
        mapProbe: {
          // image dims — the canvas-readback path (2) needs a decoded image.
          imageWidth: number;
          imageHeight: number;
          // path (1) candidates — three.js stores the glTF→texture link in
          // different places depending on loader/clone behaviour. We report each
          // independently so the probe shows EXACTLY which survived the clone.
          hasUserDataSrcUri: boolean; // texture.userData.* sourceURI-ish key
          hasSourceData: boolean; // texture.source?.data present (Source object)
          sourceDataUri: string | null; // texture.source.data.src if it is a URI
          imageSrc: string | null; // texture.image.src if the image is URL-backed
        } | null;
      }> = [];
      const probeMap = (map: THREE.Texture | null) => {
        if (!map) return null;
        const image = map.image as { width?: number; height?: number; src?: string } | undefined;
        // three.Texture.userData is an arbitrary bag; a loader/importer may stash
        // the source URI there. Scan for any key whose name hints at a source URI.
        const ud = (map.userData ?? {}) as Record<string, unknown>;
        const udKey = Object.keys(ud).find((k) => /uri|url|src|source|path/i.test(k));
        // three 0.169 Texture.source is a `Source` wrapper; `.data` is the image.
        const source = (map as { source?: { data?: { src?: string } } }).source;
        const sourceData = source?.data;
        return {
          imageWidth: image?.width ?? 0,
          imageHeight: image?.height ?? 0,
          hasUserDataSrcUri:
            udKey !== undefined &&
            typeof ud[udKey] === 'string' &&
            (ud[udKey] as string).length > 0,
          hasSourceData: Boolean(sourceData),
          sourceDataUri:
            typeof sourceData?.src === 'string' && sourceData.src.length > 0
              ? sourceData.src
              : null,
          imageSrc: typeof image?.src === 'string' && image.src.length > 0 ? image.src : null,
        };
      };
      let meshSlot = -1;
      cloned.traverse((child) => {
        const m = child as THREE.Mesh;
        if (!m.isMesh) return;
        meshSlot += 1;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const map = (mat as { map?: THREE.Texture | null } | null)?.map ?? null;
          const image = map?.image as { width?: number } | undefined;
          // #99 — expose the live material color so the override e2e can prove
          // the tint LANDED (hasMap survives is only half the goal). `#rrggbb`.
          const col = (mat as { color?: THREE.Color } | null)?.color;
          // #124 (V28) — expose the live scalar channels + their map presence so
          // the force-a-mapped-channel e2e can boundary-pair observe the actual
          // three.js material (H40/H59), not the override node params: forcing
          // metalness=0 must land `.metalness===0` while `.metalnessMap` survives
          // (the clone keeps the ref; the forced scalar zeroes its contribution).
          const std = mat as {
            metalness?: number;
            roughness?: number;
            metalnessMap?: THREE.Texture | null;
            roughnessMap?: THREE.Texture | null;
          } | null;
          // P151 Wave 4 t11 — world bounds of THIS child mesh + its render
          // visibility (false once suppressed by the bake). `visible` walks up the
          // parent chain because three skips the subtree when ANY ancestor is
          // hidden; getObjectByName(name).visible alone would miss that.
          m.updateWorldMatrix(true, false);
          const wb = new THREE.Vector3();
          new THREE.Box3().setFromObject(m).getSize(wb);
          let vis = true;
          for (let o: THREE.Object3D | null = m; o; o = o.parent) {
            if (!o.visible) {
              vis = false;
              break;
            }
          }
          summary.push({
            slot: meshSlot,
            name: m.name ?? '',
            hasMap: map !== null,
            mapImageOk: Boolean(image && (image.width ?? 0) > 0),
            color: col ? `#${col.getHexString()}` : null,
            metalness: typeof std?.metalness === 'number' ? std.metalness : null,
            roughness: typeof std?.roughness === 'number' ? std.roughness : null,
            hasMetalnessMap: Boolean(std?.metalnessMap),
            hasRoughnessMap: Boolean(std?.roughnessMap),
            worldBounds: [wb.x, wb.y, wb.z],
            visible: vis,
            mapProbe: probeMap(map),
          });
        }
      });
      return summary;
    };
  }, [cloned]);
  return <primitive object={cloned} />;
}

function TransformR({ value, override }: { value: TransformValue; override?: MaterialValue }) {
  if (!value.child) return null;
  return (
    <group
      position={value.position as [number, number, number]}
      rotation={degVec3ToRad(value.rotation as [number, number, number])}
      scale={value.scale as [number, number, number]}
    >
      <MeshChild value={value.child} override={override} />
    </group>
  );
}

function GroupR({ value, override }: { value: GroupValue; override?: MaterialValue }) {
  return (
    <group>
      {value.children.map((c, i) => (
        <MeshChild key={`g:${i}`} value={c} override={override} />
      ))}
    </group>
  );
}

function MaterialOverrideR({
  value,
  override,
}: {
  value: MaterialOverrideValue;
  override?: MaterialValue;
}) {
  if (!value.child) return null;
  // The deepest override wins — an outer MaterialOverride passes its material
  // to children, but a nested MaterialOverride replaces it. This matches the
  // intuition: the closer override (lower in the DAG) is the more specific one.
  const next = override ?? value.material;
  return <MeshChild value={value.child} override={next} />;
}

function ScatterR({ value, override }: { value: ScatterValue; override?: MaterialValue }) {
  return (
    <group>
      {value.instances.map((inst, i) => {
        const asset = value.assets[inst.assetIndex];
        if (!asset) return null;
        return (
          <group
            key={`s:${i}`}
            position={inst.position as [number, number, number]}
            rotation={inst.rotation as [number, number, number]}
            scale={inst.scale as [number, number, number]}
          >
            <MeshChild value={asset} override={override} />
          </group>
        );
      })}
    </group>
  );
}

// P2 placeholder character — boxes per bone, transformed by the pose.
// Real skinning lands in P3 (animation depth). The bone hierarchy is
// resolved into world transforms via parent indices declared on the
// skeleton itself.
function CharacterR({ value }: { value: CharacterValue }) {
  const boneTransforms: {
    position: [number, number, number];
    rotation: [number, number, number];
  }[] = [];
  const skel = value.pose.skeleton;
  for (let i = 0; i < skel.bones.length; i++) {
    const pose = value.pose.poses[i];
    boneTransforms.push({
      position: (pose?.position ?? skel.bones[i].position) as [number, number, number],
      rotation: (pose?.rotation ?? skel.bones[i].rotation) as [number, number, number],
    });
  }
  return (
    <group position={value.position as [number, number, number]} rotation={[0, value.heading, 0]}>
      {skel.bones.length === 0 ? (
        // Fallback marker if no skeleton wired yet.
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[0.4, 1, 0.4]} />
          <meshStandardMaterial color="#88aaff" roughness={0.6} metalness={0.0} />
        </mesh>
      ) : (
        <CharacterBoneRig
          bones={skel.bones.map((b) => ({ parent: b.parent }))}
          transforms={boneTransforms}
        />
      )}
    </group>
  );
}

function CharacterBoneRig({
  bones,
  transforms,
}: {
  bones: readonly { parent: number }[];
  transforms: readonly { position: [number, number, number]; rotation: [number, number, number] }[];
}) {
  // Build a recursive tree: each bone is a <group> with its parent's group
  // as the React parent, so bone-local transforms compose by THREE matrix
  // multiplication. This lets pose updates remain bit-exactly driven by
  // upstream evaluator output (V8: viewport reads, never authors).
  const childrenOf = new Map<number, number[]>();
  bones.forEach((b, i) => {
    const list = childrenOf.get(b.parent) ?? [];
    list.push(i);
    childrenOf.set(b.parent, list);
  });
  function renderBone(i: number): React.ReactElement {
    const t = transforms[i];
    const kids = childrenOf.get(i) ?? [];
    return (
      <group key={`b:${i}`} position={t.position} rotation={t.rotation}>
        <mesh position={[0, 0.05, 0]}>
          <boxGeometry args={[0.18, 0.18, 0.18]} />
          <meshStandardMaterial color="#88aaff" roughness={0.6} metalness={0.0} />
        </mesh>
        {kids.map(renderBone)}
      </group>
    );
  }
  const roots = childrenOf.get(-1) ?? [];
  return <>{roots.map(renderBone)}</>;
}
