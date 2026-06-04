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
import { useFrame, useThree } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
// #88: SkeletonUtils.clone, not Object3D.clone — see the GltfAssetR clone site.
// (SkeletonUtils is already a project dep; retarget.ts imports retargetClip from
// the same module. This is a NEW `clone` named import.)
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useResolvedAssetUrl } from '../app/asset/opfsLoader';
import { useBakedGeometry } from '../app/asset/bakedGeometryLoader';
import { useBakedTexture } from '../app/asset/bakedTextureLoader';
import { registerGltfClone, unregisterGltfClone } from '../app/asset/gltfCloneRegistry';
import { useGltfLoaderExtend } from './gltfLoaderConfig';
import { useSelectionStore } from '../app/stores/selectionStore';
import { useTimeStore } from '../app/stores/timeStore';
import { useTransientEditStore } from '../app/stores/transientEditStore';
import { overlayTransients } from '../app/overlayTransients';
import { useViewportStore } from '../app/stores/viewportStore';
import { LightHelper } from './LightHelpers';
import { degVec3ToRad } from './rotation';
import { resolveAllChildTrs, type ChildOverride } from '../app/resolveGltfChildTransform';
import { bakedChannelSamplersForAsset, sampleBakedChannel } from '../app/bakedGltfChannels';
import type { BakedChannel } from '../app/resolveGltfChildTransform';
import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import { createEvaluatorCache } from '../core/dag/evaluator';
import { useDagStore } from '../core/dag/store';
import type { DagState } from '../core/dag/state';
import { PostFx } from '../render/PostFx';
import { DiffOverlay } from './DiffOverlay';
import { AssetErrorBoundary } from './AssetErrorBoundary';
import { resolveMaterialOverrideFields } from './materialOverrideMerge';
import type {
  AmbientLightValue,
  AnimationLayerValue,
  AreaLightValue,
  BakedMeshValue,
  BoxMeshValue,
  CharacterValue,
  DirectionalLightValue,
  GltfAssetValue,
  GroupValue,
  LightValue,
  MaterialOverrideValue,
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

  return (
    <>
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
      {value.scene.children.map((child, i) => {
        const pickId = childRefs[i]?.node ?? null;
        // #149 B2a — for an AnimationLayer scene child, the TRANSIENT is keyed by
        // the WRAPPED target's node id (the box the gizmo/inspector edits), NOT
        // the layer's id. Resolve the layer's single-hop target ref EXACTLY as
        // resolveEvaluatedTransform:135 does (normalizeRefs via addLayer.ts:101's
        // own shape) so the render overlay node-id == the read overlay node-id
        // (H40). Threaded into AnimationLayerR; null for any non-layer child.
        let animationTargetId: string | null = null;
        if (child.kind === 'AnimationLayer' && pickId) {
          const tb = state.nodes[pickId]?.inputs.target;
          const tref = Array.isArray(tb) ? tb[0] : tb;
          animationTargetId = (tref as { node?: string } | undefined)?.node ?? null;
        }
        return (
          <group
            key={`mesh:${i}`}
            // v0.6 #1 (Wave 3, C-3) — name the wrapping group with its producer
            // node id so the DEV scale-probe seam (MeshScaleProbe) can read the
            // REAL rendered three.js object scale by node id (the H40 side-A
            // observation: rendered == resolver, not inferred from params).
            name={pickId ?? undefined}
            onClick={(e) => {
              if (!pickId) return;
              e.stopPropagation();
              const sel = useSelectionStore.getState();
              if (e.shiftKey) sel.selectAdditive(pickId);
              else sel.select(pickId);
            }}
          >
            <MeshChild value={child} animationTargetId={animationTargetId} />
          </group>
        );
      })}
      <MeshScaleProbe />
      {/* V8: scene contents come ONLY from the DAG. No fixtures, no fallbacks.
          If a project wants ambient fill, it adds an AmbientLight node. */}
      <DiffOverlay />
      <PostFx config={value.postFx} />
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
      const map = std.map ?? null;
      const image = map?.image as { width?: number } | undefined;
      return {
        color: std.color ? `#${std.color.getHexString()}` : null,
        hasMap: map !== null,
        mapImageOk: Boolean(image && (image.width ?? 0) > 0),
        mapColorSpace: map ? map.colorSpace : null,
        roughness: typeof std.roughness === 'number' ? std.roughness : null,
        metalness: typeof std.metalness === 'number' ? std.metalness : null,
      };
    };
    return () => {
      delete w.__basher_mesh_world_scale;
      delete w.__basher_mesh_world_bounds;
      delete w.__basher_mesh_material;
      delete w.__basher_mesh_world_position;
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
  /** #149 B2a — the wrapped target's node id for an AnimationLayer child, so
   *  AnimationLayerR can overlay the transient keyed by the SAME id the read
   *  side uses (H40). Only set by the top-level scene-children map for a
   *  single-hop AnimationLayer; undefined elsewhere (nested layers are out of
   *  scope, mirroring the read-side single-hop limit). */
  animationTargetId?: string | null;
}

const MeshChild = memo(function MeshChild({ value, override, animationTargetId }: MeshChildProps) {
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
    case 'AnimationLayer':
      // P7.12 D-04 (shape B-lite) — the layer's channels are function-of-time,
      // so the patched target must be sampled at live time. AnimationLayerR
      // samples value.sampleTarget(seconds) in a useFrame (time SNAPSHOT, never
      // a subscription — H48) and renders the patched SceneChild declaratively.
      return <AnimationLayerR value={value} override={override} targetNodeId={animationTargetId} />;
  }
});

// P7.12 D-04 (shape B-lite, FLAG-1 LOCKED) — renderer for the authored
// AnimationLayer path. The channels are function-of-time (no pre-sampled
// `.value`), so the layer's patched target must be re-sampled per frame at the
// live play time. This component:
//   1. Reads the time SNAPSHOT (`useTimeStore.getState().seconds`) inside a
//      useFrame — NEVER a subscribed time selector. Subscribing would
//      re-introduce the per-frame React reconciliation P7.10 removed (H48,
//      3rd-occurrence risk). The grep-gate asserts no time selector is added
//      to this render path.
//   2. Calls value.sampleTarget(seconds) → the patched clone for this frame.
//   3. Renders the patched SceneChild declaratively. Re-rendering the ONE
//      authored node per playback frame is the accepted B-lite cost — this is
//      a single standalone scene node (cube + NPanel diamond), not 64 bones,
//      and is exactly the pre-7.10 behavior for the authored path. The V24/H49
//      perf win is for the CHANNELS themselves (pure function-of-time).
// A `lastApplied` dirty-check on (seconds, sampleTarget ref) keeps the PAUSED
// case free (no churn when not playing) and re-applies on an edit (a new
// value ref) or a time change.
// REF: PLAN 7.12 D-04 (A3 LOCKED B-lite); vyapti V24; hetvabhasa H48/H40.
function AnimationLayerR({
  value,
  override,
  targetNodeId,
}: {
  value: AnimationLayerValue;
  override?: MaterialValue;
  /** #149 B2a — the wrapped target's node id, used to overlay its transient. */
  targetNodeId?: string | null;
}) {
  // #149 B2c (H40 form 2 — LOAD-BEARING): subscribe the transient SET. A PAUSED
  // edit changes this ref → the component re-renders → a fresh useFrame closure
  // captures the new edits → the dirty-check below re-fires → the overlay
  // re-applies. WITHOUT this subscription the paused edit updates the store but
  // the useFrame is gated out and the viewport freezes at the curve value (the
  // #68 "snaps right back" class) while the inspector shows the transient.
  //
  // H48 SAFETY (checker I-2): this is the FIRST subscribed store selector in
  // this H48-perf-sensitive render path (it still reads `seconds` as a SNAPSHOT,
  // never a time subscription). It is safe ONLY because transients are
  // paused-only + cleared-on-frame-change: during playback `edits` is a stable
  // (empty) Map ref → zero re-renders → commits=0 holds. The Wave B gate adds a
  // perf-fox commits=0 check to prove it.
  const transients = useTransientEditStore((s) => s.edits);
  const sample = (seconds: number): SceneChild | null =>
    overlayTransients(value.sampleTarget(seconds), targetNodeId ?? '', transients);

  const [patched, setPatched] = useState<SceneChild | null>(() =>
    sample(useTimeStore.getState().seconds),
  );
  const lastApplied = useRef<{
    seconds: number;
    sampleTarget: unknown;
    transients: unknown;
  } | null>(null);
  useFrame(() => {
    const seconds = useTimeStore.getState().seconds;
    if (
      lastApplied.current !== null &&
      lastApplied.current.seconds === seconds &&
      lastApplied.current.sampleTarget === value.sampleTarget &&
      lastApplied.current.transients === transients
    ) {
      return;
    }
    lastApplied.current = { seconds, sampleTarget: value.sampleTarget, transients };
    setPatched(sample(seconds));
  });
  return patched ? <MeshChild value={patched} override={override} /> : null;
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

function BoxMeshR({ value, override }: { value: BoxMeshValue; override?: MaterialValue }) {
  const mat = applyOverride(value.material.color, override);
  const shading = useViewportStore((s) => s.shading);
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
      <meshStandardMaterial
        color={mat.color}
        roughness={mat.roughness}
        metalness={mat.metalness}
        opacity={mat.opacity}
        emissive={mat.emissive}
        emissiveIntensity={mat.emissiveIntensity}
        transparent={mat.transparent}
        wireframe={shading === 'wireframe'}
      />
    </mesh>
  );
}

function SphereMeshR({ value, override }: { value: SphereMeshValue; override?: MaterialValue }) {
  const mat = applyOverride(value.material.color, override);
  const shading = useViewportStore((s) => s.shading);
  return (
    <mesh
      position={value.position as [number, number, number]}
      rotation={degVec3ToRad(value.rotation as [number, number, number])}
      // v0.6 #1 (D-01) — uniform TRS scale band (see BoxMeshR). `radius`/segments
      // stay the parametric capability; scale is the transform band. C-1 guard.
      scale={(value.scale ?? [1, 1, 1]) as [number, number, number]}
    >
      <sphereGeometry args={[value.radius, value.widthSegments, value.heightSegments]} />
      <meshStandardMaterial
        color={mat.color}
        roughness={mat.roughness}
        metalness={mat.metalness}
        opacity={mat.opacity}
        emissive={mat.emissive}
        emissiveIntensity={mat.emissiveIntensity}
        transparent={mat.transparent}
        wireframe={shading === 'wireframe'}
      />
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

function GltfAssetR({ value, override }: { value: GltfAssetValue; override?: MaterialValue }) {
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
  const gltf = useGLTF(url, '/draco/', true, extendLoader) as unknown as { scene: THREE.Group };
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
  const shading = useViewportStore((s) => s.shading);
  // P7.7 (#91) — SUBSCRIBED read of the DAG node table (NOT a getState()
  // snapshot). The node table is referentially stable until a dispatch, so a
  // gizmo setParam on a GltfChild produces a NEW `nodes` object → this selector
  // emits → the per-child effect below re-fires → re-layers → re-applies. A
  // getState() snapshot would NOT be a React dependency, so a manual override
  // would silently never re-render (the H40 freeze / C2 snap-back, caused
  // upstream here). The per-asset child map is derived in a memo keyed on the
  // subscribed nodes + assetRef so the effect dep is stable across unrelated
  // dispatches.
  const dagNodes = useDagStore((s) => s.state.nodes);
  const childOverrides = useMemo(
    () => childOverridesForAsset(dagNodes, value.assetRef),
    [dagNodes, value.assetRef],
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
    () => bakedChannelSamplersForAsset(dagNodes, value.nodeNameMap),
    [dagNodes, value.nodeNameMap],
  );
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
    const tint = (s: THREE.Material): THREE.Material => {
      const std = s as THREE.MeshStandardMaterial;
      const fields = resolveMaterialOverrideFields(
        override as MaterialValue,
        {
          roughnessMap: Boolean(std.roughnessMap),
          metalnessMap: Boolean(std.metalnessMap),
        },
        (override as MaterialValue).overridden, // #124 (V28): per-field force-vs-map
      );
      // Property-guarded: GLTFLoader emits MeshStandard/MeshPhysical for normal
      // meshes (all PBR fields present), but KHR_materials_unlit yields a
      // MeshBasicMaterial — which has `.color`/`.opacity` but NO `.emissive`/
      // `.roughness`/`.metalness`. Clone preserves that subclass, so set each
      // field only when it exists; unconditional `.emissive.set()` would throw
      // and break the whole traverse for an unlit asset (the old wholesale-replace
      // didn't throw because it always built a fresh Standard material).
      const next = s.clone() as THREE.MeshStandardMaterial;
      next.color?.set(fields.color);
      next.emissive?.set(fields.emissive);
      if ('emissiveIntensity' in next) next.emissiveIntensity = fields.emissiveIntensity;
      if ('opacity' in next) next.opacity = fields.opacity;
      if ('transparent' in next) next.transparent = fields.transparent;
      if (fields.roughness !== null && 'roughness' in next) next.roughness = fields.roughness;
      if (fields.metalness !== null && 'metalness' in next) next.metalness = fields.metalness;
      if ('wireframe' in next) next.wireframe = wireframe; // won't re-fire the [cloned, shading] pass
      return next;
    };
    cloned.traverse((child) => {
      const m = child as THREE.Mesh;
      if (!m.isMesh) return;
      // Capture the imported material(s) once, before any reassignment.
      if (!overrideOriginals.current.has(m.uuid)) {
        overrideOriginals.current.set(m.uuid, m.material);
      }
      const src = overrideOriginals.current.get(m.uuid)!;
      if (!override) {
        // Restore the imported material(s) — fixes the latent no-restore bug.
        m.material = src;
        return;
      }
      // Flatten ignores the source entirely (fresh clay per slot); the default
      // path clones the source and overlays only the map-safe fields.
      const make = flatten ? () => clay(override as MaterialValue) : tint;
      m.material = Array.isArray(src) ? src.map(make) : make(src);
    });
  }, [cloned, override]);
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
    for (const name of Object.keys(value.nodeNameMap)) {
      const child = cloned.getObjectByName(name);
      if (!child) continue;
      child.visible = !suppressed.has(name);
    }
    // Suppressed names may not be in nodeNameMap (defensive — a baked child's
    // key always is, but iterate the list too so an out-of-map key still hides).
    for (const name of suppressed) {
      const child = cloned.getObjectByName(name);
      if (child) child.visible = false;
    }
  }, [cloned, value.suppressedChildren, value.nodeNameMap]);
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
      const child = cloned.getObjectByName(name);
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
      cloned.traverse((child) => {
        const m = child as THREE.Mesh;
        if (!m.isMesh) return;
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
