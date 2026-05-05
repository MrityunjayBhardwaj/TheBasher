// EditorLights — viewport-only fill rig that renders alongside DAG
// lights in `studio` shading mode. Mounted from src/viewport/Viewport.tsx
// (file-rooted V8 stays clean — these lights are NOT dispatched, NOT
// authored into the DAG, and they have no effect on production renders
// since the renderer evaluates the DAG directly without this component).
//
// Composition: a soft hemisphere bath (sky/ground) + a fill directional
// from the front-left + a back rim. Intensities are deliberately low so
// they don't drown out a director's intentional DAG lighting — they're
// meant to fill, not relight.
//
// Toggle: `viewportStore.shading === 'studio'`. When `rendered`, this
// component returns null so the user sees only DAG-authored lights.
//
// REF: THESIS.md §11; vyapti V8.

import { useViewportStore } from '../app/stores/viewportStore';

export function EditorLights() {
  const shading = useViewportStore((s) => s.shading);
  if (shading !== 'studio') return null;
  return (
    <>
      {/* Hemisphere — sky-blue → warm ground for soft ambient bath. */}
      <hemisphereLight intensity={0.55} color="#bcd9ff" groundColor="#3a2a1a" />
      {/* Fill from camera-left, slightly above. */}
      <directionalLight intensity={0.35} color="#ffffff" position={[-4, 4, 2]} />
      {/* Back rim from behind, lower — gives silhouette edge separation. */}
      <directionalLight intensity={0.2} color="#dde6ff" position={[2, 2, -5]} />
    </>
  );
}
