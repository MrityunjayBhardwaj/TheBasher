// PostFx — the viewport beauty pass: ACES tone-mapping + SMAA antialiasing +
// depth of field (UX #12), configured by the evaluated `RenderOutput` node's
// `postFx` and the active camera's DoF. The DAG is the truth; PostFx reads it,
// never writes (V8).
//
// Imperative composer (NOT drei's <EffectComposer>): drei builds its EffectPass
// by reading the React group's mounted children (`group.__r3f.objects`), which
// silently resolved to zero passes in this fiber/drei/postprocessing combo — so
// SMAA/ACES (and any DoF) never reached the screen (the composer ran only its
// RenderPass → raw, untone-mapped scene). Driving a postprocessing
// EffectComposer directly — the SAME pipeline the offscreen still uses
// (renderToImage.ts) — makes the live bokeh/tone-map deterministic AND identical
// to the rendered frame (V37 parity). We own the EffectPass, so there is no
// hidden child-reading step to fail.
//
// Render ownership: a `useFrame` at priority 1 takes over R3F's frameloop (R3F
// skips its auto-render when any positive-priority frame callback exists) and
// renders the composer to screen each frame. The renderer stays NoToneMapping
// (Viewport.tsx sets it) — the ToneMappingEffect owns tone-mapping.
//
// REF: THESIS.md §11 (viewport renders evaluated DAG output), §27 (beauty
// pass); src/render/renderToImage.ts (the matching offscreen composer);
// src/app/cameraDof.ts (DoF settings). vyapti V37 (viewport↔render parity).

import { useThree, useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import { HalfFloatType } from 'three';
import type { PostFxConfig } from '../nodes/types';
import type { DofEffectSettings } from '../app/cameraDof';

interface PostFxProps {
  config: PostFxConfig;
  /** Active camera's depth-of-field settings (UX #12), or null when DoF is off.
   *  Built by the SAME pure helper the offscreen still uses (cameraDof.ts), so
   *  the live bokeh and the rendered bokeh match. DoF runs before tone-mapping.
   *  Keyed off the render camera (the editor view) — faithful when looking
   *  through the camera; representative in free orbit. */
  dof?: DofEffectSettings | null;
}

export function PostFx({ config, dof }: PostFxProps) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const sizeW = useThree((s) => s.size.width);
  const sizeH = useThree((s) => s.size.height);

  // The composer + its persistent RenderPass. Rebuilt only when the renderer /
  // scene / camera identity changes (e.g. persp↔ortho swaps the camera).
  const composer = useMemo(() => {
    // HalfFloat so HDR survives until the ToneMappingEffect (matches the
    // offscreen still + drei's default).
    const c = new EffectComposer(gl, { frameBufferType: HalfFloatType });
    c.addPass(new RenderPass(scene, camera));
    return c;
  }, [gl, scene, camera]);

  // Dispose the composer (and its targets) when it's replaced or unmounts.
  useEffect(() => () => composer.dispose(), [composer]);

  // Keep the composer sized to the drawing buffer.
  useEffect(() => {
    composer.setSize(sizeW, sizeH);
  }, [composer, sizeW, sizeH]);

  // (Re)build the single EffectPass whenever the effect set or its params
  // change. One EffectPass merges DoF + SMAA + ToneMapping (the postprocessing
  // way) so they share one fullscreen draw.
  const useAces = config.tonemap === 'ACES';
  useEffect(() => {
    const effects = [];
    const dofEffect = dof
      ? new DepthOfFieldEffect(camera, {
          worldFocusDistance: dof.focusDistance,
          worldFocusRange: dof.focusRange,
          bokehScale: dof.bokehScale,
        })
      : null;
    if (dofEffect) effects.push(dofEffect);
    const smaa = config.smaa ? new SMAAEffect() : null;
    if (smaa) effects.push(smaa);
    const tonemap = new ToneMappingEffect({
      mode: useAces ? ToneMappingMode.ACES_FILMIC : ToneMappingMode.LINEAR,
    });
    effects.push(tonemap);

    const pass = new EffectPass(camera, ...effects);
    composer.addPass(pass);
    return () => {
      composer.removePass(pass);
      pass.dispose();
      dofEffect?.dispose();
      smaa?.dispose();
      tonemap.dispose();
    };
    // Depend on dof's PRIMITIVE fields, not the `dof` object: resolveCameraDof
    // returns a fresh object every parent render, so depending on it would
    // rebuild the pass each frame. The primitives capture every transition
    // (null↔settings flips them undefined↔number).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    composer,
    camera,
    config.smaa,
    useAces,
    dof?.focusDistance,
    dof?.focusRange,
    dof?.bokehScale,
  ]);

  // Own the main-scene render: priority 1 disables R3F's auto-render, so the
  // composer (with its effects) is what reaches the screen. The viewport's
  // <GizmoHelper> overlays at renderPriority 2 (it must NOT use the default
  // priority 1, which would re-render the main scene raw and discard these
  // effects — the bug this component documents). Order: PostFx (1) composites
  // the beauty pass → GizmoHelper (2) overlays the orientation gizmo on top.
  useFrame((_, delta) => {
    composer.render(delta);
  }, 1);

  return null;
}
