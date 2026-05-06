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
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { useResolvedAssetUrl } from '../app/asset/opfsLoader';
import { useSelectionStore } from '../app/stores/selectionStore';
import { useTimeStore } from '../app/stores/timeStore';
import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import { createEvaluatorCache } from '../core/dag/evaluator';
import { useDagStore } from '../core/dag/store';
import { PostFx } from '../render/PostFx';
import type {
  AmbientLightValue,
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
  // Time is a UI-projection store, NOT the DAG. The viewport reads it on
  // every render and threads it into ctx; pure consumers re-evaluate via
  // TimeSource hash flips (V3). Subscribing here makes scrub-rendered
  // frames bit-exactly track the playhead.
  const seconds = useTimeStore((s) => s.seconds);
  const frame = useTimeStore((s) => s.frame);
  const normalized = useTimeStore((s) => s.normalized);
  // Single shared cache across renders; param edits invalidate via content
  // hash (the cache key changes when params change, so old entries leak but
  // are pruned at LRU ceiling — P1 wires the 512MB cap from THESIS.md §51).
  // P2 note: time-driven invalidation creates a new entry per (frame, node)
  // tuple. Bounded by N pure consumers × distinct frames visited; LRU is
  // the right home for this concern when it bites (P3+).
  const cache = useMemo<EvaluatorCache>(() => createEvaluatorCache(), []);

  const target = state.outputs[outputName];
  if (!target) return null;

  const result = evaluate(state, target.node, {
    cache,
    ctx: { time: { frame, seconds, normalized } },
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

  return (
    <>
      <CameraNode value={value.scene.camera} />
      {value.scene.lights.map((light, i) => (
        <LightNode key={`light:${i}`} value={light} />
      ))}
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
      <PostFx config={value.postFx} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

function CameraNode({ value }: { value: CameraValue }) {
  if (value.kind === 'PerspectiveCamera') return <PerspectiveCameraNode value={value} />;
  return <OrthographicCameraNode value={value} />;
}

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

function LightNode({ value }: { value: LightValue }) {
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
}

function DirectionalLightR({ value }: { value: DirectionalLightValue }) {
  return (
    <directionalLight
      intensity={value.intensity}
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
  return (
    <pointLight
      intensity={value.intensity}
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
  return (
    <spotLight
      ref={ref as React.MutableRefObject<THREE.SpotLight>}
      intensity={value.intensity}
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
  return (
    <rectAreaLight
      ref={ref as React.MutableRefObject<THREE.RectAreaLight>}
      intensity={value.intensity}
      color={value.color}
      width={value.width}
      height={value.height}
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

function MeshChild({ value, override }: MeshChildProps) {
  switch (value.kind) {
    case 'BoxMesh':
      return <BoxMeshR value={value} override={override} />;
    case 'SphereMesh':
      return <SphereMeshR value={value} override={override} />;
    case 'GltfAsset':
      return <GltfAssetR value={value} override={override} />;
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
  return (
    <mesh
      position={value.position as [number, number, number]}
      rotation={value.rotation as [number, number, number]}
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
      />
    </mesh>
  );
}

function SphereMeshR({ value, override }: { value: SphereMeshValue; override?: MaterialValue }) {
  const mat = applyOverride(value.material.color, override);
  return (
    <mesh
      position={value.position as [number, number, number]}
      rotation={value.rotation as [number, number, number]}
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
      />
    </mesh>
  );
}

function GltfAssetR({ value, override }: { value: GltfAssetValue; override?: MaterialValue }) {
  // useResolvedAssetUrl turns OPFS-relative paths (e.g. "assets/cube.gltf")
  // into blob URLs; passthrough URLs (/foo, http://..., blob:) are returned
  // as-is. Both this hook and useGLTF are suspense-driven; the Canvas-root
  // Suspense boundary catches the throws.
  const url = useResolvedAssetUrl(value.assetRef);
  const gltf = useGLTF(url) as unknown as { scene: THREE.Group };
  const cloned = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  useEffect(() => {
    if (!override) return;
    const mat = applyOverride('#ffffff', override);
    cloned.traverse((child) => {
      const m = child as THREE.Mesh;
      if (m.isMesh) {
        m.material = new THREE.MeshStandardMaterial({
          color: mat.color,
          roughness: mat.roughness,
          metalness: mat.metalness,
          opacity: mat.opacity,
          emissive: mat.emissive,
          emissiveIntensity: mat.emissiveIntensity,
          transparent: mat.transparent,
        });
      }
    });
  }, [cloned, override]);
  return <primitive object={cloned} />;
}

function TransformR({ value, override }: { value: TransformValue; override?: MaterialValue }) {
  if (!value.child) return null;
  return (
    <group
      position={value.position as [number, number, number]}
      rotation={value.rotation as [number, number, number]}
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
