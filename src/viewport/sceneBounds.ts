// sceneBounds — read the live THREE scene's content bounds for "frame all"
// (#186). Pairs with the pure `cameraFit` math: this side reads the (impure)
// scene graph and produces a {center, radius} bounding sphere; cameraFit turns
// that into pose + clip planes.
//
// Discipline: measures DAG CONTENT only — editor chrome (grid, gizmo, helpers,
// lights, ground-click plane) is excluded with the SAME predicate the render
// hide-pass uses, so the framed bounds match what the camera should actually
// fit. That used to be a claim in this comment backed by a copy of the rule; it
// is now the same function (#546). What stays LOCAL is the traversal: chrome
// subtrees are PRUNED here (not just the chrome root skipped) so a helper's
// children never inflate the bounds, which is this consumer's own decision.
//
// REF: issue #186, #546; vyapti V37 (editorChrome flag); src/app/editorChrome.ts
// (the one predicate); sibling consumer: the render hide-pass in renderToImage.ts.

import * as THREE from 'three';
import { isEditorChrome } from '../app/editorChrome';

export interface SceneBounds {
  center: [number, number, number];
  /** Bounding-sphere radius. 0 for a single-point / zero-extent scene. */
  radius: number;
}

const tmpBox = new THREE.Box3();

/**
 * World-space bounding sphere of all non-chrome meshes in `root`, or null when
 * there is no measurable content (empty scene / chrome only). Each mesh is
 * measured by its OWN geometry box transformed to world space — NOT
 * `Box3.setFromObject`, which would recurse into (and so include) any chrome
 * descendant. Pure read: it does not mutate the scene beyond refreshing world
 * matrices (idempotent), which R3F also does each frame.
 */
export function computeSceneBounds(root: THREE.Object3D): SceneBounds | null {
  // Ensure world matrices are current (a just-mounted glTF clone may not have
  // been through a render frame yet). Idempotent.
  root.updateMatrixWorld(true);

  const box = new THREE.Box3();
  let any = false;

  const walk = (o: THREE.Object3D): void => {
    if (isEditorChrome(o)) return; // prune the whole chrome subtree
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const geom = mesh.geometry;
      if (!geom.boundingBox) geom.computeBoundingBox();
      if (geom.boundingBox) {
        tmpBox.copy(geom.boundingBox).applyMatrix4(mesh.matrixWorld);
        if (!tmpBox.isEmpty()) {
          box.union(tmpBox);
          any = true;
        }
      }
    }
    for (const child of o.children) walk(child);
  };
  walk(root);

  if (!any || box.isEmpty()) return null;

  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const radius = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 0;
  return {
    center: [sphere.center.x, sphere.center.y, sphere.center.z],
    radius,
  };
}
