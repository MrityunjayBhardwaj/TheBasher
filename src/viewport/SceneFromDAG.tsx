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
// REF: THESIS.md §11, vyapti V8.

import { PerspectiveCamera } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import { createEvaluatorCache } from '../core/dag/evaluator';
import { useDagStore } from '../core/dag/store';
import { PostFx } from '../render/PostFx';
import type {
  BoxMeshValue,
  CameraValue,
  DirectionalLightValue,
  RenderOutputValue,
} from '../nodes/types';

interface SceneFromDAGProps {
  /** Override the named output to render. Defaults to 'render'. */
  outputName?: string;
}

export function SceneFromDAG({ outputName = 'render' }: SceneFromDAGProps) {
  const state = useDagStore((s) => s.state);
  // Single shared cache across renders; param edits invalidate via content
  // hash (the cache key changes when params change, so old entries leak but
  // are pruned at LRU ceiling — P1 wires the 512MB cap from THESIS.md §51).
  const cache = useMemo<EvaluatorCache>(() => createEvaluatorCache(), []);

  const target = state.outputs[outputName];
  if (!target) return null;

  const result = evaluate(state, target.node, { cache });
  const value = result.value as RenderOutputValue;

  return (
    <>
      <CameraNode value={value.scene.camera} />
      {value.scene.lights.map((light, i) => (
        <LightNode key={`light:${i}`} value={light} />
      ))}
      {value.scene.children.map((child, i) => (
        <MeshNode key={`mesh:${i}`} value={child} />
      ))}
      <ambientLight intensity={0.15} />
      <PostFx config={value.postFx} />
    </>
  );
}

function CameraNode({ value }: { value: CameraValue }) {
  const ref = useRef<THREE.PerspectiveCamera | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.lookAt(new THREE.Vector3(...value.lookAt));
  }, [value.lookAt, value.position]);
  return (
    <PerspectiveCamera
      ref={ref as React.MutableRefObject<THREE.PerspectiveCamera>}
      makeDefault
      fov={value.fov}
      near={value.near}
      far={value.far}
      position={value.position as [number, number, number]}
    />
  );
}

function LightNode({ value }: { value: DirectionalLightValue }) {
  return (
    <directionalLight
      intensity={value.intensity}
      color={value.color}
      position={value.position as [number, number, number]}
      castShadow={false}
    />
  );
}

function MeshNode({ value }: { value: BoxMeshValue }) {
  return (
    <mesh
      position={value.position as [number, number, number]}
      rotation={value.rotation as [number, number, number]}
    >
      <boxGeometry args={value.size as [number, number, number]} />
      <meshStandardMaterial color={value.material.color} />
    </mesh>
  );
}
