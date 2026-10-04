// renderVisibility — #1503: the viewport and the render show different things, as Blender's do.
//
// Visibility is two params on every node the eye can hide (`viewport`, `render`;
// src/nodes/visibilityParams.ts), read by `hiddenNodes(state, purpose)` (collections.ts). The live
// three.js scene is ONE scene, drawn by the viewport and captured by the render
// (`renderToImage`), so a node shown in only one of them cannot simply be mounted or not:
//
//   - hidden in BOTH  → its body is not mounted (SceneFromDAG's `hiddenIds`), as before #1503;
//   - shown in BOTH   → drawn as is;
//   - 'render-only'   → (viewport off, render on) mounted under a group with `visible = false`,
//                       stamped, so the viewport draws nothing and the render shows it;
//   - 'viewport-only' → (viewport on, render off) drawn under a stamped group the render hides.
//
// The viewport writes the stamp (`OwnVisibility` in SceneFromDAG.tsx); the render reads it here,
// in a scope shaped like `withEditorChromeHidden` and for its reason (#560): the flipped list never
// escapes, and only what was flipped is put back. `src/app/` is the home for the reason
// `editorChrome.ts` gives — `src/render/` imports from `src/app/`, never from `src/viewport/`.
//
// A stamped 'render-only' body is invisible but still in the scene, and three's raycaster does not
// skip invisible objects, so `isUnderRenderOnly` lets the viewport's pick filter drop its hits —
// a click lands on what the viewport draws.

import type * as THREE from 'three';
import type { NodeId } from '../core/dag/types';

/** The `userData` key the stamp lives under, on the group wrapping a node's body. */
export const RENDER_VISIBILITY_KEY = 'basherRenderVisibility';

/** Which of the two a node is shown in, when it is shown in exactly one. */
export type RenderVisibilityStamp = 'render-only' | 'viewport-only';

/** The nodes shown in exactly one of the viewport and the render, from the two hidden sets. */
export function renderVisibilityStamps(
  viewportHidden: ReadonlySet<NodeId>,
  renderHidden: ReadonlySet<NodeId>,
): ReadonlyMap<NodeId, RenderVisibilityStamp> {
  const out = new Map<NodeId, RenderVisibilityStamp>();
  for (const id of viewportHidden) if (!renderHidden.has(id)) out.set(id, 'render-only');
  for (const id of renderHidden) if (!viewportHidden.has(id)) out.set(id, 'viewport-only');
  return out;
}

const stampOf = (o: THREE.Object3D): unknown => o.userData?.[RENDER_VISIBILITY_KEY];

/**
 * Run `render` with the render's own visibility on the scene — every 'viewport-only' body hidden
 * and every 'render-only' body shown — then put back exactly what was flipped.
 */
export function withRenderVisibility<T>(scene: THREE.Object3D, render: () => T): T {
  const flipped: THREE.Object3D[] = [];
  scene.traverse((o) => {
    const stamp = stampOf(o);
    const want = stamp === 'render-only' ? true : stamp === 'viewport-only' ? false : o.visible;
    if (want !== o.visible) {
      o.visible = want;
      flipped.push(o);
    }
  });
  try {
    return render();
  } finally {
    for (const o of flipped) o.visible = !o.visible;
  }
}

/** Whether `o` sits under a 'render-only' body: drawn by the render, not by the viewport. */
export function isUnderRenderOnly(o: THREE.Object3D | null): boolean {
  for (let cur = o; cur; cur = cur.parent) if (stampOf(cur) === 'render-only') return true;
  return false;
}
