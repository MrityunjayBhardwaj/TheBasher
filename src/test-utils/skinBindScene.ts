// What a bind starts from, for tests (#1353): a stored cylinder with no weights on a mesh Object,
// and a three-bone chain up its axis on an armature Object, both under the scene. Nothing here was
// imported, so any weight a test reads afterwards was made by the capture.

import type { Op } from '../core/dag/types';
import { packMeshData } from '../app/meshGeometryData';
import { cylinderMesh } from './cylinderMesh';

export const BIND = {
  meshData: 'sb_mesh_data',
  mesh: 'sb_mesh',
  skeleton: 'sb_skel',
  armature: 'sb_arm',
  /** Bottom to top: joints at y = 0, 1 and 2; the last is a leaf, drawn 0.25 long. */
  bones: ['Bone', 'Bone.001', 'Bone.002'],
  /** Rings every 0.25 from y = 0 to 3, eight points each, at radius 0.25. */
  radial: 8,
  rings: 13,
  radius: 0.25,
  height: 3,
} as const;

/** The first point of the ring at height `y` (it sits at +X: `(radius, y, 0)`). */
export function ringPoint(y: number): number {
  return Math.round((y / BIND.height) * (BIND.rings - 1)) * BIND.radial;
}

export function skinBindSceneOps(sceneId = 'n_scene'): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: BIND.meshData,
      nodeType: 'PolyMeshData',
      params: { mesh: packMeshData(cylinderMesh(BIND)), material: null },
    },
    { type: 'addNode', nodeId: BIND.mesh, nodeType: 'Object', params: {} },
    {
      type: 'connect',
      from: { node: BIND.meshData, socket: 'out' },
      to: { node: BIND.mesh, socket: 'data' },
    },
    {
      type: 'addNode',
      nodeId: BIND.skeleton,
      nodeType: 'Skeleton',
      params: {
        bones: BIND.bones.map((name, i) => ({
          name,
          parent: i - 1,
          position: [0, i === 0 ? 0 : 1, 0],
          rotation: [0, 0, 0],
        })),
      },
    },
    { type: 'addNode', nodeId: BIND.armature, nodeType: 'Object', params: {} },
    {
      type: 'connect',
      from: { node: BIND.skeleton, socket: 'out' },
      to: { node: BIND.armature, socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: BIND.mesh, socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    },
    {
      type: 'connect',
      from: { node: BIND.armature, socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    },
  ] as Op[];
}
