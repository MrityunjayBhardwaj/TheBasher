// LightHelpers — wireframe gizmos that show where each DAG light lives.
// Blender's editor-only "show as wireframe" — the light's actual
// contribution is rendered by the matching <directionalLight> /
// <pointLight> / <spotLight> / <areaLight> in SceneFromDAG; this layer
// is purely visual feedback for editing.
//
// Discipline: lives in src/viewport/ but renders only — no dispatch,
// no DAG mutation. The shading gate (`viewportStore.shading !==
// 'rendered'`) lives upstream in SceneFromDAG; consumers of these
// helpers control visibility, the helpers themselves are stateless.
//
// REF: THESIS.md §11.

import { useMemo } from 'react';
import * as THREE from 'three';
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

/** Top-level dispatcher — returns the right helper for the light kind. */
export function LightHelper({ value }: { value: LightValue }) {
  switch (value.kind) {
    case 'DirectionalLight':
      return <DirectionalLightHelper value={value} />;
    case 'PointLight':
      return <PointLightHelper value={value} />;
    case 'SpotLight':
      return <SpotLightHelper value={value} />;
    case 'AreaLight':
      return <AreaLightHelper value={value} />;
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

function DirectionalLightHelper({ value }: { value: DirectionalLightValue }) {
  // Blender's "sun" — ring at the position + line indicating direction.
  // DirectionalLight's direction in our DAG is from `position` toward the
  // origin (the lookAt is implicit). Show that line so users can read
  // which way the sun is facing.
  const dir = useMemo(() => {
    const v = new THREE.Vector3(-value.position[0], -value.position[1], -value.position[2]);
    if (v.lengthSq() === 0) v.set(0, -1, 0);
    return v.normalize().multiplyScalar(1.2);
  }, [value.position[0], value.position[1], value.position[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <group position={value.position as [number, number, number]}>
      <mesh>
        <ringGeometry args={[0.18, 0.22, 24]} />
        <meshBasicMaterial color={SUN} side={THREE.DoubleSide} />
      </mesh>
      <HelperLine from={[0, 0, 0]} to={[dir.x, dir.y, dir.z]} color={SUN} />
    </group>
  );
}

function PointLightHelper({ value }: { value: PointLightValue }) {
  // Small wireframe sphere. If decay > 0 and distance > 0, render a
  // larger ghost sphere at `distance` to hint at falloff range.
  return (
    <group position={value.position as [number, number, number]}>
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

function SpotLightHelper({ value }: { value: SpotLightValue }) {
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
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
    return q;
  }, [value.position, value.target]);

  return (
    <group position={value.position as [number, number, number]} quaternion={quat}>
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

function AreaLightHelper({ value }: { value: AreaLightValue }) {
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
  return (
    <group position={value.position as [number, number, number]} quaternion={quat}>
      <mesh>
        <planeGeometry args={[value.width, value.height]} />
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
