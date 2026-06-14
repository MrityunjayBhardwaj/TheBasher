// UX #9 — mounts a drei <Environment> from the evaluated SceneValue.environment.
//
// This is the renderer half of the scene-level HDRI/IBL feature (vyapti V47).
// The env config is authored as Scene-node params, folded by Scene.evaluate into
// SceneValue.environment, and consumed HERE. drei's <Environment> handles the
// RGBELoader/EXRLoader + PMREM prefiltering + the optional skybox; it sets
// `scene.environment` (and `scene.background` when `background` is on) on the
// LIVE three.js scene.
//
// Why this matters for production parity: `scene.environment` is a scene
// PROPERTY, not a child object — so the renderToImage chrome hide-pass
// (renderToImage.ts, which only hides traversed `editorChrome` objects) never
// touches it. The HDRI lights the offscreen render with ZERO special-casing.
// ⇒ this component must NEVER be marked editorChrome (the V37 inverse).
//
// Source paths (decision 2026-06-15, AskUserQuestion):
//   - 'none'   → render nothing (the default; scene stays the dark stage).
//   - 'preset' → drei built-in preset (CDN fetch — NOT embedded in .basher, V41).
//   - 'file'   → an imported .hdr/.exr from OPFS (slice 2 — environmentTextureLoader).
//
// REF: vyapti V47; src/nodes/types.ts (EnvironmentValue); drei <Environment>.

import { Environment } from '@react-three/drei';
import type { PresetsType } from '@react-three/drei/helpers/environment-assets';
import { Suspense } from 'react';
import type { EnvironmentValue } from '../nodes/types';

// drei ships a fixed catalog of preset names; we expose them through the
// inspector (slice 3). Narrow an arbitrary string back to a PresetsType for the
// drei prop — an unknown name falls through to 'studio' rather than throwing.
const PRESET_NAMES: readonly PresetsType[] = [
  'apartment',
  'city',
  'dawn',
  'forest',
  'lobby',
  'night',
  'park',
  'studio',
  'sunset',
  'warehouse',
];

export function isEnvPreset(name: string): name is PresetsType {
  return (PRESET_NAMES as readonly string[]).includes(name);
}

export function SceneEnvironment({ value }: { value: EnvironmentValue | undefined }) {
  // Second-layer V10/H14 default — a SceneValue constructed without an
  // environment (defensive against an un-migrated path) resolves to `none`.
  const env = value ?? {
    source: { kind: 'none' as const },
    intensity: 1,
    rotationY: 0,
    background: false,
  };
  const source = env.source;
  if (source.kind === 'none') return null;

  // Y-rotation authored in degrees; three's environmentRotation is an Euler in
  // radians.
  const rotation: [number, number, number] = [0, (env.rotationY * Math.PI) / 180, 0];

  if (source.kind === 'preset') {
    const preset = isEnvPreset(source.name) ? source.name : 'studio';
    return (
      <Suspense fallback={null}>
        <Environment
          preset={preset}
          background={env.background}
          environmentIntensity={env.intensity}
          environmentRotation={rotation}
          backgroundRotation={rotation}
        />
      </Suspense>
    );
  }

  // source.kind === 'file' — the OPFS-backed imported HDRI. Wired in slice 2
  // (environmentTextureLoader, mirroring bakedTextureLoader). Until then an
  // imported source renders nothing rather than throwing.
  return null;
}
