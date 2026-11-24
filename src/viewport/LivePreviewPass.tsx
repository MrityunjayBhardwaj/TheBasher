// LivePreviewPass — draws the live camera's view into the live preview's box, inside the ONE
// viewport Canvas (#1708).
//
// The preview is what the camera on screen at the playhead sees, as a render sees it: the shot's
// production camera (`buildRenderCamera`, the still's own camera), editor chrome hidden and the
// render's own visibility applied for the span of the draw (`withEditorChromeHidden` +
// `withRenderVisibility`, the still's two scopes). It is never a second <Canvas>: the scene is
// drawn into a small offscreen target, and that target is copied each frame into the box the DOM
// frame (`LivePreview`) publishes, with a scissored draw after the main pass.
//
// Cost: the scene draw is the expensive half, so it runs only when what it shows can have changed
// — the graph, the playhead, the box's size, the shading — and otherwise once every
// IDLE_REFRESH_FRAMES (a model still loading, a texture arriving). The copy is one quad. Nothing
// is drawn while the preview is collapsed, hidden by look-through, or in present mode.
//
// Priority 3: after PostFx's composer (1, the sole main-scene render owner) and the axis gizmo's
// overlay (2), so the box composites over the finished frame (B17's render-ownership rule).
//
// V8: reads stores, writes none but its DEV seam. Never mutates the DAG.

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { resolveActiveCameraPoseAt, selectActiveCameraNode } from '../app/activeCamera';
import { withRenderVisibility } from '../app/renderVisibility';
import { useChromeStore } from '../app/stores/chromeStore';
import { useLivePreviewStore } from '../app/stores/livePreviewStore';
import { useTimeStore } from '../app/stores/timeStore';
import { useViewportStore } from '../app/stores/viewportStore';
import { uiEvaluatorCache } from '../app/uiEvaluatorCache';
import { useDagStore } from '../core/dag/store';
import type { DagState } from '../core/dag/state';
import { measureStage } from '../perf/frameProfiler';
import { buildRenderCamera, withEditorChromeHidden } from '../render/renderToImage';

/** Frames between redraws of an unchanged preview (~0.5 s at 60 fps). */
const IDLE_REFRESH_FRAMES = 30;

interface PreviewSeam {
  drawn: boolean;
  renders: number;
  cameraId: string | null;
  lastMs: number;
}

export function LivePreviewPass() {
  const gl = useThree((s) => s.gl);
  const res = useMemo(() => {
    // Half-float so the copy can tone-map the same linear light the composer does; MSAA because
    // the main pass's SMAA does not run on this target.
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const material = new THREE.MeshBasicMaterial({
      map: target.texture,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    const scene = new THREE.Scene();
    scene.add(quad);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    return { target, material, quad, scene, camera };
  }, []);
  useEffect(
    () => () => {
      res.target.dispose();
      res.material.dispose();
      res.quad.geometry.dispose();
    },
    [res],
  );

  const last = useRef({
    state: null as DagState | null,
    seconds: Number.NaN,
    width: 0,
    height: 0,
    shading: '',
    sinceDraw: 0,
  });
  const seam = useRef<PreviewSeam>({ drawn: false, renders: 0, cameraId: null, lastMs: 0 });

  useFrame((frame) => {
    const { rect, collapsed } = useLivePreviewStore.getState();
    const view = useViewportStore.getState();
    const hidden =
      !rect ||
      collapsed ||
      view.lookThroughCamera ||
      useChromeStore.getState().presentMode ||
      rect.width < 1 ||
      rect.height < 1;
    const dag = useDagStore.getState().state;
    const seconds = useTimeStore.getState().filmSeconds;
    const cameraId = hidden ? null : (selectActiveCameraNode(dag, seconds)?.id ?? null);
    seam.current.drawn = false;
    if (import.meta.env.DEV) {
      (window as unknown as { __basher_live_preview?: PreviewSeam }).__basher_live_preview =
        seam.current;
    }
    if (hidden || !cameraId) {
      // Drawn fresh when it next shows.
      last.current.state = null;
      return;
    }

    const dpr = gl.getPixelRatio();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    const l = last.current;
    const stale =
      l.state !== dag ||
      l.seconds !== seconds ||
      l.width !== width ||
      l.height !== height ||
      l.shading !== view.shading ||
      ++l.sinceDraw >= IDLE_REFRESH_FRAMES;
    if (stale) {
      const t0 = performance.now();
      measureStage('preview', () => {
        if (res.target.width !== width || res.target.height !== height) {
          res.target.setSize(width, height);
        }
        const pose = resolveActiveCameraPoseAt(dag, seconds, uiEvaluatorCache);
        const camera = buildRenderCamera(pose, width, height);
        const scene = frame.scene;
        const prevTarget = gl.getRenderTarget();
        try {
          withEditorChromeHidden(scene, () =>
            withRenderVisibility(scene, () => {
              gl.setRenderTarget(res.target);
              gl.clear();
              gl.render(scene, camera);
            }),
          );
        } finally {
          gl.setRenderTarget(prevTarget);
        }
      });
      Object.assign(l, { state: dag, seconds, width, height, shading: view.shading, sinceDraw: 0 });
      seam.current.renders += 1;
      seam.current.lastMs = performance.now() - t0;
    }

    // Copy the target into the box: CSS pixels, y up from the canvas bottom (three scales both
    // by the pixel ratio).
    const size = frame.size;
    const y = size.height - rect.y - rect.height;
    const prevAutoClear = gl.autoClear;
    const prevToneMapping = gl.toneMapping;
    const prevExposure = gl.toneMappingExposure;
    try {
      gl.autoClear = false;
      gl.toneMapping = THREE.ACESFilmicToneMapping;
      gl.toneMappingExposure = 1;
      gl.setViewport(rect.x, y, rect.width, rect.height);
      gl.setScissor(rect.x, y, rect.width, rect.height);
      gl.setScissorTest(true);
      gl.render(res.scene, res.camera);
    } finally {
      gl.setScissorTest(false);
      gl.setViewport(0, 0, size.width, size.height);
      gl.autoClear = prevAutoClear;
      gl.toneMapping = prevToneMapping;
      gl.toneMappingExposure = prevExposure;
    }
    seam.current.drawn = true;
    seam.current.cameraId = cameraId;
  }, 3);

  return null;
}
