// The placeholder box that stands where a generated model will land while it is generating
// (#1720, design board 13b).
//
// Editor chrome, not scene content: it is drawn from the session's run state
// (`modelGenerationStore`), never from the DAG, and tagged `editorChrome` so a render leaves it
// out — the same tag the grid carries. It disappears the moment the run ends; the model itself
// arrives only when a director keeps a variant, through the import road.
//
// V8: reads an app store and draws R3F primitives; never dispatches.

import { useMemo } from 'react';
import { BoxGeometry } from 'three';
import {
  GENERATION_LANDING_CENTRE,
  useModelGenerationStore,
} from '../app/stores/modelGenerationStore';
import { PROPOSAL_AMBER } from '../app/proposalStyle';

export function GenerationPlaceholder() {
  const running = useModelGenerationStore((s) => s.run !== null);
  const box = useMemo(() => new BoxGeometry(1, 1, 1), []);
  if (!running) return null;
  return (
    <group
      position={GENERATION_LANDING_CENTRE}
      userData={{ editorChrome: true, generationPlaceholder: true }}
      name="generation-placeholder"
    >
      {/* Drawn over the scene (no depth test): the box marks a place, and whatever already
          stands there — the default cube does — must not hide it or z-fight with it. */}
      <mesh renderOrder={10}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial
          color={PROPOSAL_AMBER}
          transparent
          opacity={0.12}
          depthWrite={false}
          depthTest={false}
        />
      </mesh>
      <lineSegments renderOrder={11}>
        <edgesGeometry args={[box]} />
        <lineBasicMaterial color={PROPOSAL_AMBER} transparent depthTest={false} />
      </lineSegments>
    </group>
  );
}
