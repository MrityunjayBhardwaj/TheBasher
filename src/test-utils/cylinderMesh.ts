// A stored cylinder for tests: an open tube of quads standing on +Y, made here rather than read
// from a file, so a test that binds it starts with no weights at all (#1353).

import type { MeshGeometryData } from '../nodes/types';

/**
 * A tube of `radial` sides and `rings` rings from y = 0 to `height`, radius `radius`, no caps.
 * Point `ring * radial + side` sits on ring `ring` (0 at the bottom) at angle `side / radial`.
 */
export function cylinderMesh(opts: {
  readonly radius: number;
  readonly height: number;
  readonly radial: number;
  readonly rings: number;
}): MeshGeometryData {
  const { radius, height, radial, rings } = opts;
  const points = new Float32Array(radial * rings * 3);
  for (let ring = 0; ring < rings; ring++) {
    for (let side = 0; side < radial; side++) {
      const angle = (side / radial) * Math.PI * 2;
      points.set(
        [Math.cos(angle) * radius, (ring / (rings - 1)) * height, Math.sin(angle) * radius],
        (ring * radial + side) * 3,
      );
    }
  }
  const faces = radial * (rings - 1);
  const cornerPoints = new Uint32Array(faces * 4);
  let c = 0;
  for (let ring = 0; ring < rings - 1; ring++) {
    for (let side = 0; side < radial; side++) {
      const next = (side + 1) % radial;
      cornerPoints.set(
        [
          ring * radial + side,
          (ring + 1) * radial + side,
          (ring + 1) * radial + next,
          ring * radial + next,
        ],
        c,
      );
      c += 4;
    }
  }
  return {
    points,
    faceSizes: new Uint32Array(faces).fill(4),
    cornerPoints,
    cornerLayers: [],
    faceLayers: [],
    pointLayers: [],
    vertexGroups: [],
    cornerNormals: null,
  };
}
