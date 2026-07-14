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
import type { CurveValue } from '../nodes/types';

const LINE_COLOR = '#d98a2b';
const POINT_COLOR = '#f0b357';
const POINT_RADIUS = 0.07;

export function CurveLineR({ value }: { value: CurveValue }) {
  const position = (value.position ?? [0, 0, 0]) as [number, number, number];
  const rotation = degVec3ToRad((value.rotation ?? [0, 0, 0]) as [number, number, number]);
  const scale = (value.scale ?? [1, 1, 1]) as [number, number, number];
  const samples = value.samples ?? [];
  const points = value.points ?? [];

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
    <group position={position} rotation={rotation} scale={scale} userData={{ editorChrome: true }}>
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
