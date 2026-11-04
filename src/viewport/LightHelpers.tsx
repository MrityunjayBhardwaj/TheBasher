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
import { withResolvedRotation } from '../app/resolvedRotation';
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

/** Top-level dispatcher — returns the right helper for the light kind, as editor chrome.
 *
 *  The chrome flag is declared HERE, once, and not per kind. Declared per kind, only the
 *  directional helper ever carried it: the point, spot and area helpers drew their
 *  wireframes into every rendered image and animation frame (#1631), because the render's
 *  hide-pass hides only what declares itself. A flagged parent hides the whole subtree
 *  (three's visibility inherits; `sceneBounds` prunes it), so a kind added later is chrome
 *  without having to remember. */
export function LightHelper({ value, pickId }: LightHelperProps) {
  // #1153 — a quaternion-mode light's orientation, as the `rotation` every helper below reads.
  const resolved = useMemo(() => withResolvedRotation(value), [value]);
  return (
    <group userData={{ editorChrome: true }}>
      <LightHelperOfKind value={resolved} pickId={pickId} />
    </group>
  );
}

function LightHelperOfKind({ value, pickId }: LightHelperProps) {
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

/** #1765 — the quaternion a light is turned by (its `rotation`, euler degrees), and the
 *  direction it shines: down its local −Z, as every Blender light does (5.1.1, measured) and as
 *  the light itself does (SceneFromDAG `useLightTurn`). */
function lightTurn(rotation: readonly number[] | undefined): {
  quat: THREE.Quaternion;
  direction: THREE.Vector3;
} {
  const [rx, ry, rz] = degVec3ToRad((rotation ?? [0, 0, 0]) as [number, number, number]);
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  return { quat, direction: new THREE.Vector3(0, 0, -1).applyQuaternion(quat) };
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
  const direction = useMemo(() => lightTurn(value.rotation).direction, [value.rotation]);
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
  // Cone from the light down the way it shines (#1765: its local −Z). Its length is the
  // light's reach when it has one, else a fixed 2 m: the old length was the distance to the
  // `target` point, which a light no longer has. Base radius `tan(angle) * length`.
  const { length, baseR } = useMemo(() => {
    const len = value.distance > 0 ? value.distance : 2;
    return { length: len, baseR: Math.tan(value.angle) * len };
  }, [value.distance, value.angle]);

  // The cone geometry runs along +Y (apex up); turn its −Y onto the shining direction, then
  // shift it down by length/2 so the apex sits on the light.
  const quat = useMemo(
    () =>
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, -1, 0),
        lightTurn(value.rotation).direction,
      ),
    [value.rotation],
  );

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
  // #1765 — the rectangle turned exactly as the lit one is: the plane's XY is the light's, so
  // its width runs along the light's own X and its height along its Y, roll included.
  const quat = useMemo(() => lightTurn(value.rotation).quat, [value.rotation]);
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
