// NullGlyph — the viewport representation of a Null controller (#296). A Null has no
// geometry, so it draws a small 3-axis cross at its transform: visible + selectable,
// but marked `userData.editorChrome` so the image render's hide-pass excludes it (V37).
// Selection is inherited from the enclosing SceneChildNode <group onClick> band (the
// same way a mesh is picked) — so NO onClick here; the invisible pick sphere just makes
// the tiny glyph an easy click target (mirrors the light helpers' pick boost).
//
// Rotation params are DEGREES (rotation.ts); the group wants radians.
//
// REF: src/nodes/types.ts (NullValue); src/viewport/LightHelpers.tsx (the glyph +
//      pick-boost pattern this mirrors); src/render/renderToImage.ts (editorChrome
//      hide-pass); issue #296.

import { useMemo } from 'react';
import * as THREE from 'three';
import { degVec3ToRad } from './rotation';
import type { NullValue } from '../nodes/types';

const AXIS_LEN = 0.4;
const X_COLOR = '#ff3653';
const Y_COLOR = '#8adb00';
const Z_COLOR = '#2c8fff';

/** A 2-point line from the origin along an axis (a bare BufferGeometry line). */
function AxisLine({ to, color }: { to: [number, number, number]; color: string }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, ...to], 3));
    return g;
  }, [to[0], to[1], to[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <line>
      <primitive object={geom} attach="geometry" />
      <lineBasicMaterial color={color} />
    </line>
  );
}

export function NullGlyphR({ value }: { value: NullValue }) {
  const position = (value.position ?? [0, 0, 0]) as [number, number, number];
  const rotation = degVec3ToRad((value.rotation ?? [0, 0, 0]) as [number, number, number]);
  const scale = (value.scale ?? [1, 1, 1]) as [number, number, number];
  return (
    <group position={position} rotation={rotation} scale={scale} userData={{ editorChrome: true }}>
      <AxisLine to={[AXIS_LEN, 0, 0]} color={X_COLOR} />
      <AxisLine to={[0, AXIS_LEN, 0]} color={Y_COLOR} />
      <AxisLine to={[0, 0, AXIS_LEN]} color={Z_COLOR} />
      {/* small centre dot so the empty reads as an object, not just 3 lines */}
      <mesh>
        <sphereGeometry args={[0.05, 12, 8]} />
        <meshBasicMaterial color="#e8e8ef" />
      </mesh>
      {/* invisible pick boost — makes the tiny glyph an easy click target; selection
          is handled by the enclosing SceneChildNode band, so no onClick here. */}
      <mesh>
        <sphereGeometry args={[0.28, 8, 6]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}
