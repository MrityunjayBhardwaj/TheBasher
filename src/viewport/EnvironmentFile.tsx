// UX #9 slice 2 — renders an imported HDRI (OPFS .hdr/.exr) as the scene env.
//
// Suspends on the OPFS read + RGBELoader/EXRLoader decode (environmentTextureLoader),
// then hands the decoded equirect texture to drei's <Environment map={…}>, which
// assigns it to `scene.environment` (+ `scene.background` when the skybox toggle
// is on). The texture already carries EquirectangularReflectionMapping
// (envHdriStore.loadEnvHdri), so three uses it as an env map directly.
//
// REF: src/app/asset/environmentTextureLoader.ts; src/viewport/SceneEnvironment.tsx.

import { Environment } from '@react-three/drei';
import { useEnvironmentTexture } from '../app/asset/environmentTextureLoader';

export function EnvironmentFile({
  assetRef,
  background,
  intensity,
  rotation,
}: {
  assetRef: string;
  background: boolean;
  intensity: number;
  rotation: [number, number, number];
}) {
  const texture = useEnvironmentTexture(assetRef);
  return (
    <Environment
      map={texture}
      background={background}
      environmentIntensity={intensity}
      environmentRotation={rotation}
      backgroundRotation={rotation}
    />
  );
}
