// Viewport-side perf instrumentation, DEV-only.
//
//   <PerfBoundary>  wraps the scene subtree in a React <Profiler> so the
//                   reconciliation + commit cost of SceneFromDAG is attributed
//                   to the `react` budget (eval runs inside it and is
//                   subtracted out by the collector).
//   <GpuProbe>      mounts inside the Canvas and samples renderer.info every
//                   frame (triangles + draw calls = steady-state GPU load).
//
// WebGL has no cheap synchronous GPU timer, so we do NOT report a GPU
// millisecond figure; the GPU-bound signal is "frame interval climbs while
// react + eval stay flat" — read off the collector summary.
//
// We count scene load by WALKING the three.js scene graph (visible meshes +
// their geometry triangle counts) rather than reading gl.info.render —
// because PostFx's EffectComposer renders the scene to an offscreen target and
// leaves gl.info reflecting only its final fullscreen pass (a constant ~handful
// of triangles), which would massively under-report the real geometry. The
// scene walk is postprocessing-independent and is the authored-load metric.
//
// Lives in src/perf/ (not src/nodes/**) so the V2 purity lint does not apply.
// In production both exports are inert: PerfBoundary renders children
// directly and GpuProbe renders nothing.

import { useFrame, useThree } from '@react-three/fiber';
import { Profiler, useEffect, type ReactNode } from 'react';
import type { BufferGeometry, Mesh } from 'three';
import { frameProfiler, installFrameProfiler } from './frameProfiler';

installFrameProfiler();

const DEV = import.meta.env.DEV;

function triCount(geom: BufferGeometry): number {
  const index = geom.index;
  if (index) return index.count / 3;
  const pos = geom.attributes.position;
  return pos ? pos.count / 3 : 0;
}

export function GpuProbe() {
  // #1727 — the `render` stage: CPU time inside every `renderer.render` the frame makes (the
  // post-processing composer calls it once per pass). Wrapped once, timed only while armed.
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    if (!DEV) return;
    const original = gl.render;
    gl.render = function timedRender(this: typeof gl, ...args: Parameters<typeof original>) {
      if (!frameProfiler.isArmed()) return original.apply(this, args);
      const t0 = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        frameProfiler.recordStage('render', performance.now() - t0);
      }
    };
    return () => {
      gl.render = original;
    };
  }, [gl]);
  useFrame(({ scene }) => {
    if (!frameProfiler.isArmed()) return;
    let triangles = 0;
    let meshes = 0;
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh && mesh.visible && mesh.geometry) {
        triangles += triCount(mesh.geometry);
        meshes += 1;
      }
    });
    // drawCalls ≈ mesh count (no instancing in the stress scene).
    frameProfiler.recordGpu(triangles, meshes, null);
  });
  return null;
}

/** `id` names the subtree: `scene` (the default) is the scene's own budget, with eval taken out;
 *  any other id is reported as its own per-frame stage, `react:<id>` (#1727). */
export function PerfBoundary({ children, id = 'scene' }: { children: ReactNode; id?: string }) {
  if (!DEV) return <>{children}</>;
  return (
    <Profiler
      id={id}
      onRender={(_id, _phase, actualDuration) => {
        if (id === 'scene') frameProfiler.recordReactCommit(actualDuration);
        else frameProfiler.recordSubtreeCommit(id, actualDuration);
      }}
    >
      {children}
    </Profiler>
  );
}
