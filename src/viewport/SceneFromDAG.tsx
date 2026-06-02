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

import { OrthographicCamera, PerspectiveCamera, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
// #88: SkeletonUtils.clone, not Object3D.clone — see the GltfAssetR clone site.
// (SkeletonUtils is already a project dep; retarget.ts imports retargetClip from
// the same module. This is a NEW `clone` named import.)
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useResolvedAssetUrl } from '../app/asset/opfsLoader';
import { useGltfLoaderExtend } from './gltfLoaderConfig';
import { useSelectionStore } from '../app/stores/selectionStore';
import { useTimeStore } from '../app/stores/timeStore';
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
  BoxMeshValue,
  CameraValue,
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
      <CameraNode value={value.scene.camera} />
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
        return (
          <group
            key={`mesh:${i}`}
            onClick={(e) => {
              if (!pickId) return;
              e.stopPropagation();
              const sel = useSelectionStore.getState();
              if (e.shiftKey) sel.selectAdditive(pickId);
              else sel.select(pickId);
            }}
          >
            <MeshChild value={child} />
          </group>
        );
      })}
      {/* V8: scene contents come ONLY from the DAG. No fixtures, no fallbacks.
          If a project wants ambient fill, it adds an AmbientLight node. */}
      <DiffOverlay />
      <PostFx config={value.postFx} />
    </>
  );
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
const CameraNode = memo(function CameraNode({ value }: { value: CameraValue }) {
  if (value.kind === 'PerspectiveCamera') return <PerspectiveCameraNode value={value} />;
  return <OrthographicCameraNode value={value} />;
});

function PerspectiveCameraNode({
  value,
}: {
  value: Extract<CameraValue, { kind: 'PerspectiveCamera' }>;
}) {
  const ref = useRef<THREE.PerspectiveCamera | null>(null);
  // Set initial position once on mount, then let OrbitControls own it.
  // Without this, every render (e.g. timeStore tick) re-runs the prop
  // assignment + lookAt, snapping the camera back and fighting the
  // editor camera. Camera params from the DAG still take effect via
  // the value-keyed useEffect below — but only when the values
  // actually change, not on every render.
  const [px, py, pz] = value.position;
  const [lx, ly, lz] = value.lookAt;
  useEffect(() => {
    if (!ref.current) return;
    ref.current.position.set(px, py, pz);
    ref.current.lookAt(new THREE.Vector3(lx, ly, lz));
  }, [px, py, pz, lx, ly, lz]);
  return (
    <PerspectiveCamera
      ref={ref as React.MutableRefObject<THREE.PerspectiveCamera>}
      makeDefault
      fov={value.fov}
      near={value.near}
      far={value.far}
    />
  );
}

function OrthographicCameraNode({
  value,
}: {
  value: Extract<CameraValue, { kind: 'OrthographicCamera' }>;
}) {
  const ref = useRef<THREE.OrthographicCamera | null>(null);
  const [px, py, pz] = value.position;
  const [lx, ly, lz] = value.lookAt;
  useEffect(() => {
    if (!ref.current) return;
    ref.current.position.set(px, py, pz);
    ref.current.lookAt(new THREE.Vector3(lx, ly, lz));
  }, [px, py, pz, lx, ly, lz]);
  return (
    <OrthographicCamera
      ref={ref as React.MutableRefObject<THREE.OrthographicCamera>}
      makeDefault
      zoom={value.zoom}
      near={value.near}
      far={value.far}
    />
  );
}

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
      return <AnimationLayerR value={value} override={override} />;
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
}: {
  value: AnimationLayerValue;
  override?: MaterialValue;
}) {
  const [patched, setPatched] = useState<SceneChild | null>(() =>
    value.sampleTarget(useTimeStore.getState().seconds),
  );
  const lastApplied = useRef<{ seconds: number; sampleTarget: unknown } | null>(null);
  useFrame(() => {
    const seconds = useTimeStore.getState().seconds;
    if (
      lastApplied.current !== null &&
      lastApplied.current.seconds === seconds &&
      lastApplied.current.sampleTarget === value.sampleTarget
    ) {
      return;
    }
    lastApplied.current = { seconds, sampleTarget: value.sampleTarget };
    setPatched(value.sampleTarget(seconds));
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
      m.material = Array.isArray(src) ? src.map(tint) : tint(src);
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
      }> = [];
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
          summary.push({
            name: m.name ?? '',
            hasMap: map !== null,
            mapImageOk: Boolean(image && (image.width ?? 0) > 0),
            color: col ? `#${col.getHexString()}` : null,
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
