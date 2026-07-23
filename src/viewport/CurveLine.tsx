// CurveLine — the viewport representation of a Curve path (#321). Draws the baked polyline
// (`value.samples`, LOCAL space — the enclosing group applies the curve's TRS, exactly as a
// mesh child is posed) plus a small dot at every control point so the authored points read
// as handles even before #322 makes them grabbable.
//
// `userData.editorChrome` — a curve is a PATH, not render geometry: it exists to be
// FOLLOWED, not seen. (Blender's curve likewise renders nothing until it has a bevel.) The
// image render's hide-pass excludes editor chrome (V37, renderToImage.ts), so the line
// guides the director in the viewport and never appears in the output frame.
//
// Selection is inherited from the enclosing SceneChildNode <group onClick> band — NO
// onClick here, mirroring NullGlyph. The line itself is thin and hard to hit, so an
// invisible pick-boost sphere sits at the origin (the light-helper/NullGlyph pattern).
//
// REF: src/nodes/types.ts (CurveValue); src/nodes/curveMath.ts (the sampler that produced
//      `samples`); src/viewport/NullGlyph.tsx (the chrome + pick-boost pattern this
//      mirrors); src/render/renderToImage.ts (the editorChrome hide-pass); issue #321.

import { useMemo } from 'react';
import * as THREE from 'three';
import { degVec3ToRad } from './rotation';
import type { CurveValue, Vec3 } from '../nodes/types';

const LINE_COLOR = '#d98a2b';
const POINT_COLOR = '#f0b357';
const POINT_RADIUS = 0.07;

// The drawing, decoupled from the value shape so BOTH roads render the identical
// line: the fused `CurveValue` (CurveLineR below, retired in #385 S4) and the
// split `Object → CurveData` path (ObjectR's curve arm, SceneFromDAG). TRS is the
// owner's; `samples`/`points` are LOCAL (the enclosing group applies the TRS).
export function CurveLineChrome({
  position,
  rotation,
  scale,
  samples,
  points,
}: {
  position: readonly [number, number, number];
  /** Euler degrees (converted to radians here). */
  rotation: readonly [number, number, number];
  scale: readonly [number, number, number];
  samples: readonly Vec3[];
  points: readonly Vec3[];
}) {
  const rot = degVec3ToRad(rotation as [number, number, number]);

  // A flat [x,y,z, …] strip through the baked samples. Closed curves already repeat their
  // first point as the last (curveMath.sampleCurve), so the strip closes itself — no
  // wrap-around case here.
  const geom = useMemo(() => {
    const flat: number[] = [];
    for (const s of samples) flat.push(s[0], s[1], s[2]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
    return g;
  }, [samples]);

  return (
    <group
      position={position as [number, number, number]}
      rotation={rot}
      scale={scale as [number, number, number]}
      userData={{ editorChrome: true }}
    >
      <line>
        <primitive object={geom} attach="geometry" />
        <lineBasicMaterial color={LINE_COLOR} />
      </line>
      {points.map((p, i) => (
        <mesh key={i} position={p as [number, number, number]}>
          <sphereGeometry args={[POINT_RADIUS, 10, 8]} />
          <meshBasicMaterial color={POINT_COLOR} />
        </mesh>
      ))}
      {/* Invisible pick boost — a 1px line is a miserable click target. Selection is the
          enclosing SceneChildNode band's job, so no onClick. */}
      <mesh>
        <sphereGeometry args={[0.28, 8, 6]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

// The fused-value wrapper (the #321 road). Pulls TRS + geometry off a single
// `CurveValue` and hands them to CurveLineChrome. Retired in #385 S4 once the
// fused `CurveValue` kind is unrepresentable; until then a fused Curve and a
// split `Object → CurveData` draw byte-identically through the same Chrome.
export function CurveLineR({ value }: { value: CurveValue }) {
  return (
    <CurveLineChrome
      position={(value.position ?? [0, 0, 0]) as [number, number, number]}
      rotation={(value.rotation ?? [0, 0, 0]) as [number, number, number]}
      scale={(value.scale ?? [1, 1, 1]) as [number, number, number]}
      samples={value.samples ?? []}
      points={value.points ?? []}
    />
  );
}
