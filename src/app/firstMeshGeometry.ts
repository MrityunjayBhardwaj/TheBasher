// #367 — WHICH BufferGeometry a glTF child means, decided in ONE place.
//
// Two callers ask this question and their answers have to agree. `geometryRegistry.get`
// resolves a `gltf` ref through the mounted asset clone, so the operator chain can build over
// an imported mesh; `resolveMeshUVSpace` reads the same child out of the same clone for the UV
// editor's backdrop. Until this module they walked the clone separately, with the same six
// lines written twice. Drift between those copies would not throw: the chain would build from
// one mesh while the editor drew another, and each half would look entirely correct on its
// own. That is the failure this module exists to make unrepresentable.
//
// A LEAF by the strictest measure in `faceCountLeaf.gate.test.ts` — one TYPE import of
// `three`, no value imports at all — which is what makes it safe to import from inside the
// geometry model, where a heavier dependency would become reachable from every consumer of a
// geometry handle.

import type { BufferGeometry, Mesh, Object3D } from 'three';

/**
 * The first `isMesh` descendant's geometry under `root`, `root` itself included — `traverse`
 * visits the node it is called on, so a `childName` naming the mesh directly resolves to that
 * mesh's own geometry rather than to a descendant's.
 *
 * FIRST, and deliberately not "the only one". A `childName` that names a Group with several
 * meshes beneath it resolves to whichever three visits first. That is the behaviour both
 * callers already had, kept rather than changed here, because narrowing it is a decision about
 * what a multi-mesh child MEANS to the operator chain — and nothing asks that question yet.
 * The point of this module is that both callers make the same choice, not that the choice is
 * settled.
 *
 * Null for an absent root, which is the caller's "the clone has not mounted yet".
 */
export function firstMeshGeometry(root: Object3D | null | undefined): BufferGeometry | null {
  if (!root) return null;
  let found: BufferGeometry | null = null;
  root.traverse((o) => {
    if (!found && (o as Mesh).isMesh) found = (o as Mesh).geometry;
  });
  return found;
}
