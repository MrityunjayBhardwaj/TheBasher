// PostFx — ACES tone-mapping + SMAA antialiasing, configured by the
// evaluated `RenderOutput` node's `postFx` params. The DAG is the truth;
// PostFx reads it, never writes (V8).
//
// Distilled from RubicsWorld's PostFx (DoF/Bloom/Vignette/CA/Grade/Noise
// stripped) — those land as additional node types in P4+ if needed. The
// chain stays composable: every effect is gated on a param boolean.
//
// REF: THESIS.md §11 (viewport renders evaluated DAG output), §27 (beauty
// pass).

import { EffectComposer, SMAA, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import type { PostFxConfig } from '../nodes/types';

interface PostFxProps {
  config: PostFxConfig;
}

export function PostFx({ config }: PostFxProps) {
  const useAces = config.tonemap === 'ACES';
  return (
    <EffectComposer multisampling={0}>
      {config.smaa ? <SMAA /> : <></>}
      <ToneMapping mode={useAces ? ToneMappingMode.ACES_FILMIC : ToneMappingMode.LINEAR} />
    </EffectComposer>
  );
}
