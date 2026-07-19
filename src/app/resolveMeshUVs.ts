// resolveMeshUVs — the ONE producer-aware UV-source resolver (v0.6 #3, #181).
//
// Both UVEditor (the panel, side B) and the `__basher_uv_islands` seam read
// THROUGH here, so the seam reflects exactly what the panel draws (no drift —
// the H40 boundary-pair discipline). Non-throwing / sync: async geometry that
// isn't ready yet returns status 'loading' (never a Suspense throw — the panel
// is not inside a Suspense boundary, and the seam must not throw).
//
//   - Sphere / Object → the resolver's EvaluatedMesh.uvs (sync registry geometry, A-2).
//     An Object is the object↔data split's scene node (#365): resolveEvaluatedMesh
//     reaches its geometry through the `data` socket, so a split cube resolves its
//     real BoxGeometry islands here (#378).
//   - glTF / GltfChild → the loaded asset clone (gltfCloneRegistry, A-3).
//   - BakedMesh → geometryRegistry.get (sync hit once BakedMeshR has primed it;
//     null on miss = 'loading', NEVER the throwing resolveBakedGeometry).
//
// REF: CONTEXT A-3; PLAN W1 (1.4/1.5); hetvabhasa H40; vyapti V29.

import type { BufferGeometry, Mesh, Object3D } from 'three';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import type { EvaluatedUVs, UVIsland } from '../nodes/types';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import { extractUVIslands } from './uvIslands';
import { getGltfClone } from './asset/gltfCloneRegistry';
import { get as getRegistryGeometry } from './geometryRegistry';

// UV layout is time-independent (geometry UVs are static), so a zero ctx is exact.
const STATIC_CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

export type UVSourceStatus = 'ok' | 'loading' | 'none';
export interface UVSource {
  readonly uvs: EvaluatedUVs | null;
  readonly status: UVSourceStatus;
}

const NONE: UVSource = { uvs: null, status: 'none' };
const LOADING: UVSource = { uvs: null, status: 'loading' };

/** First isMesh descendant's BufferGeometry under `root` (or root itself). */
function firstMeshGeometry(root: Object3D | null | undefined): BufferGeometry | null {
  if (!root) return null;
  let geo: BufferGeometry | null = null;
  root.traverse((o) => {
    if (!geo && (o as Mesh).isMesh) geo = (o as Mesh).geometry;
  });
  return geo;
}

/** Union the UV islands of every mesh under a clone root (whole-asset view). */
function extractCloneUVs(root: Object3D): EvaluatedUVs {
  const islands: UVIsland[] = [];
  let triangleCount = 0;
  let sampled = false;
  root.traverse((o) => {
    if ((o as Mesh).isMesh) {
      const u = extractUVIslands((o as Mesh).geometry);
      islands.push(...u.islands);
      triangleCount += u.triangleCount;
      sampled = sampled || u.sampled;
    }
  });
  return { islands, triangleCount, sampled };
}

export function resolveMeshUVs(state: DagState, nodeId: string): UVSource {
  const node = state.nodes[nodeId];
  if (!node) return NONE;

  // SphereMesh (fused) and Object (the object↔data split) share ONE arm on purpose:
  // both reach their geometry through `resolveEvaluatedMesh`, which is the single
  // read-side twin of what the renderer mounts. The Object arm reaches through the
  // `data` socket to the linked mesh data there, so this file never re-derives that
  // reach (V101 — one projection, not a parallel list). #378.
  if (node.type === 'SphereMesh' || node.type === 'Object') {
    const mesh = resolveEvaluatedMesh(state, nodeId, STATIC_CTX);
    return mesh?.uvs ? { uvs: mesh.uvs, status: 'ok' } : NONE;
  }

  if (node.type === 'GltfChild') {
    const p = node.params as { assetRef?: string; childName?: string };
    const clone = p.assetRef ? getGltfClone(p.assetRef) : null;
    if (!clone) return LOADING;
    const geo = firstMeshGeometry(p.childName ? clone.getObjectByName(p.childName) : null);
    return geo ? { uvs: extractUVIslands(geo), status: 'ok' } : NONE;
  }

  if (node.type === 'GltfAsset') {
    const p = node.params as { assetRef?: string };
    const clone = p.assetRef ? getGltfClone(p.assetRef) : null;
    if (!clone) return LOADING;
    return { uvs: extractCloneUVs(clone), status: 'ok' };
  }

  if (node.type === 'BakedMesh') {
    const mesh = resolveEvaluatedMesh(state, nodeId, STATIC_CTX);
    if (!mesh || mesh.geometry.kind !== 'baked') return NONE;
    const geo = getRegistryGeometry(mesh.geometry); // sync hit once BakedMeshR primed; null = miss
    return geo ? { uvs: extractUVIslands(geo), status: 'ok' } : LOADING;
  }

  return NONE;
}
