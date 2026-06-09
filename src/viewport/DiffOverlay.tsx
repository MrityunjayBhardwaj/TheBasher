// Ghost overlay — renders the forked DAG scene semi-transparent alongside
// the real scene. Mounted inside SceneFromDAG when a diff is pending.
//
// V8: this component reads from diffStore and renders R3F primitives.
// It NEVER dispatches Ops. The accept/reject buttons call into
// acceptSelectedOps / rejectDiff from src/app/.
//
// REF: THESIS.md §19 (Diff-first), krama K3, vyapti V7.

import { useMemo } from 'react';
import { useDiffStore } from '../agent/diff';
import { evaluate, createEvaluatorCache, type EvaluatorCache } from '../core/dag/evaluator';
import { useTimeStore } from '../app/stores/timeStore';
import { degVec3ToRad } from './rotation';
import type { RenderOutputValue, CameraValue, LightValue, SceneChild } from '../nodes/types';

export function DiffOverlay() {
  const pendingDiff = useDiffStore((s) => s.pendingDiff);
  const status = useDiffStore((s) => s.status);
  const diff = pendingDiff;

  if (status !== 'pending' || !diff) return null;
  return <DiffOverlayInner diff={diff} />;
}

function DiffOverlayInner({
  diff,
}: {
  diff: NonNullable<ReturnType<typeof useDiffStore.getState>['pendingDiff']>;
}) {
  const seconds = useTimeStore((s) => s.seconds);
  const frame = useTimeStore((s) => s.frame);
  const normalized = useTimeStore((s) => s.normalized);
  const cache = useMemo<EvaluatorCache>(() => createEvaluatorCache(), [diff.forkState]);

  // Evaluate the fork's render output. Mirror of SceneFromDAG's top-level
  // evaluate call, but for the forked scene.
  const target = diff.forkState.outputs['render'];
  if (!target) return null;

  const result = evaluate(diff.forkState, target.node, {
    cache,
    ctx: { time: { frame, seconds, normalized } },
  });
  const value = result.value as RenderOutputValue;

  return (
    // editorChrome: agent-diff ghost preview is an editor overlay, never part
    // of a render (#168).
    <group userData={{ editorChrome: true }}>
      {/* Scene contents with ghost styling */}
      <GhostCamera value={value.scene.camera} />
      {value.scene.lights.map((light, i) => (
        <GhostLight key={`ghost-light:${i}`} value={light} />
      ))}
      {value.scene.children.map((child, i) => (
        <GhostChild key={`ghost-child:${i}`} value={child} />
      ))}
    </group>
  );
}

function GhostCamera({ value }: { value: CameraValue | null }) {
  if (!value) return null;
  // Ghost cameras are non-functional markers in the diff view.
  // The real camera render is controlled by the live DAG.
  return null;
}

function GhostLight({ value }: { value: LightValue }) {
  return (
    <group>
      <mesh>
        <sphereGeometry args={[0.15, 8, 8]} />
        <meshBasicMaterial
          transparent
          opacity={0.5}
          color={value.color ?? '#ffffff'}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function GhostChild({ value }: { value: SceneChild }) {
  switch (value.kind) {
    case 'BoxMesh':
      return (
        <mesh
          position={value.position as [number, number, number]}
          rotation={degVec3ToRad(value.rotation as [number, number, number])}
        >
          <boxGeometry args={(value.size ?? [1, 1, 1]) as [number, number, number]} />
          <meshBasicMaterial
            transparent
            opacity={0.35}
            color={value.material.base.color}
            depthWrite={false}
            wireframe
          />
        </mesh>
      );
    case 'SphereMesh':
      return (
        <mesh
          position={value.position as [number, number, number]}
          rotation={degVec3ToRad(value.rotation as [number, number, number])}
        >
          <sphereGeometry args={[value.radius, value.widthSegments, value.heightSegments]} />
          <meshBasicMaterial
            transparent
            opacity={0.35}
            color={value.material.base.color}
            depthWrite={false}
            wireframe
          />
        </mesh>
      );
    case 'Transform':
      if (!value.child) return null;
      return (
        <group
          position={value.position as [number, number, number]}
          rotation={degVec3ToRad(value.rotation as [number, number, number])}
          scale={value.scale as [number, number, number]}
        >
          <GhostChild value={value.child} />
        </group>
      );
    case 'Group':
      return (
        <group>
          {value.children.map((c, i) => (
            <GhostChild key={`g:${i}`} value={c} />
          ))}
        </group>
      );
    case 'GltfAsset':
      return null; // glTF ghost would require asset loading — skip for v0.5
    case 'MaterialOverride':
      if (!value.child) return null;
      return <GhostChild value={value.child} />;
    case 'Scatter':
      return (
        <group>
          {value.instances.map((inst, i) => {
            const asset = value.assets[inst.assetIndex];
            if (!asset) return null;
            return (
              <group
                key={`s:${i}`}
                position={inst.position as [number, number, number]}
                rotation={inst.rotation as [number, number, number]}
                scale={inst.scale as [number, number, number]}
              >
                <GhostChild value={asset} />
              </group>
            );
          })}
        </group>
      );
    case 'Character':
      return (
        <mesh position={(value.position as [number, number, number]) ?? [0, 0.5, 0]}>
          <boxGeometry args={[0.4, 1, 0.4]} />
          <meshBasicMaterial
            transparent
            opacity={0.35}
            color="#88aaff"
            depthWrite={false}
            wireframe
          />
        </mesh>
      );
  }
}
