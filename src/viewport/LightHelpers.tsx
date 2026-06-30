// LightHelpers — wireframe gizmos that show where each DAG light lives.
// Blender's editor-only "show as wireframe" — the light's actual
// contribution is rendered by the matching <directionalLight> /
// <pointLight> / <spotLight> / <areaLight> in SceneFromDAG; this layer
// is purely visual feedback for editing.
//
// Click pickup: each helper accepts a `pickId` (the producing DAG node's
// id) and dispatches selection on click. R3F's onClick fires on the
// helper's wireframe meshes; we stopPropagation so OrbitControls doesn't
// also see the event.
//
// Discipline: lives in src/viewport/ but renders only — `useSelectionStore`
// is a UI projection (not the DAG), and the helper writes through it via
// the same path NodeList / SceneFromDAG meshes use. V1 (DAG mutation
// only via Op) holds.
//
// REF: THESIS.md §11; vyapti V1, V8.

import { useMemo } from 'react';
import * as THREE from 'three';
import { degVec3ToRad } from './rotation';
import { selectNodeOnClick } from './selectNodeOnClick';
import type {
  AmbientLightValue,
  AreaLightValue,
  DirectionalLightValue,
  LightValue,
  PointLightValue,
  SpotLightValue,
} from '../nodes/types';

const SUN = '#ffd166';
const POINT = '#ff8c42';
const SPOT = '#ffb86c';
const AREA = '#88c0ff';

export interface LightHelperProps {
  value: LightValue;
  /** The producing DAG node id; null when selection routing is unavailable. */
  pickId: string | null;
}

/** Top-level dispatcher — returns the right helper for the light kind. */
export function LightHelper({ value, pickId }: LightHelperProps) {
  // DEV observation seam ([[V85]]/[[H132]] #241): record the EVALUATED value this
  // helper renders with, keyed by node id, so an e2e can assert the wireframe helper
  // follows the playhead (not the static frame-0 read).
  if (import.meta.env.DEV && pickId) {
    const w = window as unknown as { __basher_lighthelper_value?: Record<string, LightValue> };
    (w.__basher_lighthelper_value ??= {})[pickId] = value;
  }
  switch (value.kind) {
    case 'DirectionalLight':
      return <DirectionalLightHelper value={value} pickId={pickId} />;
    case 'PointLight':
      return <PointLightHelper value={value} pickId={pickId} />;
    case 'SpotLight':
      return <SpotLightHelper value={value} pickId={pickId} />;
    case 'AreaLight':
      return <AreaLightHelper value={value} pickId={pickId} />;
    case 'AmbientLight':
      // Ambient is non-positional — Blender doesn't draw a helper for it.
      return <AmbientLightHelper value={value} />;
  }
}

/** Lightweight 2-point line built from BufferGeometry. drei's <Line>
 *  would also work but adds a dep; manual is fine for static helpers. */
function HelperLine({
  from,
  to,
  color,
}: {
  from: readonly [number, number, number];
  to: readonly [number, number, number];
  color: string;
}) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...from, ...to], 3));
    return g;
  }, [from[0], from[1], from[2], to[0], to[1], to[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <line>
      <primitive object={geom} attach="geometry" />
      <lineBasicMaterial color={color} />
    </line>
  );
}

/** Compute the world-space direction the directional light shines along.
 *  When rotation is non-zero, derive from rotation × (0,-1,0). When zero,
 *  fall back to the legacy "from position toward origin" interpretation
 *  so seed scenes look the same as before. */
function directionalDirection(value: DirectionalLightValue): THREE.Vector3 {
  // Defensive — projects saved before rotation existed land here with
  // no rotation field. The evaluator defaults now, but guarding here
  // makes the helper safe regardless.
  const [rx, ry, rz] = value.rotation ?? [0, 0, 0];
  if (rx !== 0 || ry !== 0 || rz !== 0) {
    // params.rotation is in degrees — Euler expects radians.
    const [erx, ery, erz] = degVec3ToRad([rx, ry, rz]);
    return new THREE.Vector3(0, -1, 0).applyEuler(new THREE.Euler(erx, ery, erz)).normalize();
  }
  const v = new THREE.Vector3(-value.position[0], -value.position[1], -value.position[2]);
  if (v.lengthSq() === 0) v.set(0, -1, 0);
  return v.normalize();
}

function DirectionalLightHelper({
  value,
  pickId,
}: {
  value: DirectionalLightValue;
  pickId: string | null;
}) {
  // Sun "donut" — ring whose normal aligns to the light's direction so
  // looking down the direction shows it as a circle (matches the user's
  // expectation: the ring orients toward the direction vector).
  const direction = useMemo(() => directionalDirection(value), [value]);
  const ringQuat = useMemo(() => {
    // ringGeometry's plane is XY (normal = +Z). Rotate +Z → direction.
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
  }, [direction]);
  const tip = useMemo(
    () => direction.clone().multiplyScalar(1.2),
    [direction.x, direction.y, direction.z], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Defensive default — pre-scale projects load with no scale field.
  const scale = (value.scale ?? [1, 1, 1]) as [number, number, number];
  return (
    <group
      position={value.position as [number, number, number]}
      scale={scale}
      onClick={selectNodeOnClick(pickId)}
      userData={{ editorChrome: true }}
    >
      <mesh quaternion={ringQuat}>
        <ringGeometry args={[0.18, 0.22, 24]} />
        <meshBasicMaterial color={SUN} side={THREE.DoubleSide} />
      </mesh>
      <HelperLine from={[0, 0, 0]} to={[tip.x, tip.y, tip.z]} color={SUN} />
      {/* Invisible click target — ringGeometry alone has a tiny pickable
          area; this small invisible sphere at origin makes the helper
          easier to click without affecting visuals. */}
      <mesh>
        <sphereGeometry args={[0.25, 8, 6]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

function PointLightHelper({ value, pickId }: { value: PointLightValue; pickId: string | null }) {
  const rot = value.rotation ?? [0, 0, 0];
  const rotQuat = useMemo(() => {
    // params.rotation is in degrees — Euler expects radians.
    const [rx, ry, rz] = degVec3ToRad(rot as [number, number, number]);
    const e = new THREE.Euler(rx, ry, rz);
    return new THREE.Quaternion().setFromEuler(e);
  }, [rot[0], rot[1], rot[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  const scale = (value.scale ?? [1, 1, 1]) as [number, number, number];
  return (
    <group
      position={value.position as [number, number, number]}
      quaternion={rotQuat}
      scale={scale}
      onClick={selectNodeOnClick(pickId)}
    >
      <mesh>
        <sphereGeometry args={[0.15, 12, 8]} />
        <meshBasicMaterial color={POINT} wireframe />
      </mesh>
      {value.distance > 0 ? (
        <mesh>
          <sphereGeometry args={[Math.max(value.distance, 0.5), 16, 12]} />
          <meshBasicMaterial color={POINT} wireframe transparent opacity={0.15} />
        </mesh>
      ) : null}
    </group>
  );
}

function SpotLightHelper({ value, pickId }: { value: SpotLightValue; pickId: string | null }) {
  // Cone from position toward target. The cone's height is the
  // distance-to-target and its base radius is `tan(angle) * height`.
  const { length, baseR } = useMemo(() => {
    const dx = value.target[0] - value.position[0];
    const dy = value.target[1] - value.position[1];
    const dz = value.target[2] - value.position[2];
    const len = Math.max(0.5, Math.hypot(dx, dy, dz));
    return { length: len, baseR: Math.tan(value.angle) * len };
  }, [value.position, value.target, value.angle]);

  // Build a coordinate frame so the cone points from position to target.
  const quat = useMemo(() => {
    const dir = new THREE.Vector3(
      value.target[0] - value.position[0],
      value.target[1] - value.position[1],
      value.target[2] - value.position[2],
    );
    if (dir.lengthSq() === 0) dir.set(0, -1, 0);
    dir.normalize();
    // Default cone axis is +Y (apex up). We want the apex at the light's
    // position, opening toward target. Rotate +Y → dir (so the base ends
    // at target). Cone geometry is centered on its origin with height
    // along Y, so we then translate down by length/2.
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
  }, [value.position, value.target]);

  const scale = (value.scale ?? [1, 1, 1]) as [number, number, number];
  return (
    <group
      position={value.position as [number, number, number]}
      quaternion={quat}
      scale={scale}
      onClick={selectNodeOnClick(pickId)}
    >
      <mesh position={[0, -length / 2, 0]}>
        <coneGeometry args={[baseR, length, 16, 1, true]} />
        <meshBasicMaterial color={SPOT} wireframe />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.1, 8, 6]} />
        <meshBasicMaterial color={SPOT} />
      </mesh>
    </group>
  );
}

function AreaLightHelper({ value, pickId }: { value: AreaLightValue; pickId: string | null }) {
  // Wireframe rectangle facing lookAt.
  const quat = useMemo(() => {
    const dir = new THREE.Vector3(
      value.lookAt[0] - value.position[0],
      value.lookAt[1] - value.position[1],
      value.lookAt[2] - value.position[2],
    );
    if (dir.lengthSq() === 0) dir.set(0, 0, -1);
    dir.normalize();
    // Plane normal is +Z by default. Rotate +Z → dir.
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  }, [value.position, value.lookAt]);
  // AreaLight: scale.x → width factor, scale.y → height factor. Mirrors
  // the renderer (SceneFromDAG → AreaLightR), so the wireframe outline
  // tracks the actual lit rectangle. scale.z is preserved on the value
  // for round-trip but has no shading effect (the area is planar).
  const scale = (value.scale ?? [1, 1, 1]) as [number, number, number];
  const w = value.width * scale[0];
  const h = value.height * scale[1];
  return (
    <group
      position={value.position as [number, number, number]}
      quaternion={quat}
      onClick={selectNodeOnClick(pickId)}
    >
      <mesh>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial color={AREA} wireframe side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function AmbientLightHelper(_props: { value: AmbientLightValue }) {
  // Ambient is non-positional — no helper rendered. Blender shows the
  // ambient strength in world props, not in the 3D viewport.
  return null;
}
