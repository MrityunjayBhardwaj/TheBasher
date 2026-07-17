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
import { resolveConstraintPosition, resolveConstraintRotation } from '../app/nodeConstraints';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import { degVec3ToRad } from './rotation';
import type { RenderOutputValue, CameraValue, LightValue, SceneObject } from '../nodes/types';

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

  const ctx: EvalCtx = { time: { frame, seconds, normalized } };
  const result = evaluate(diff.forkState, target.node, { cache, ctx });
  const value = result.value as RenderOutputValue;

  // #352 — recover each top-level ghost child's producer nodeId so the pose band can be
  // applied to it. Index i in `value.scene.children` corresponds to index i in the Scene
  // aggregator's `inputs.children` — the SAME index-correspondence the renderer uses to
  // recover pick ids (SceneFromDAG.tsx). Read from the FORK: the proposal's scene.
  const sceneRef = diff.forkState.outputs.scene;
  const sceneNode = sceneRef ? diff.forkState.nodes[sceneRef.node] : null;
  const childRefs =
    sceneNode && Array.isArray(sceneNode.inputs.children)
      ? (sceneNode.inputs.children as { node: string; socket: string }[])
      : [];

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
        <GhostChild
          key={`ghost-child:${i}`}
          value={applyGhostPoseBand(diff.forkState, childRefs[i]?.node ?? null, child, ctx, cache)}
        />
      ))}
    </group>
  );
}

/** #352 / [[V104]] — apply the pose bands on top of a ghost child's purely-evaluated
 *  value. The ghost READS nothing and DISPLAYS a result, so it applies the band; the
 *  band's own inputs (the curve's world, the aim target's world) keep reading the fork's
 *  PURE walk, and that split is the cycle guard — no guard needed here.
 *
 *  This is the mirror of `ConstrainedR`'s patch (SceneFromDAG.tsx): the fork evaluate
 *  above mirrors SceneFromDAG's TOP-LEVEL evaluate but never its ConstrainedR wrapper,
 *  which is exactly why the ghost was [[H170]]'s unfolded FIFTH road — it ghosted a
 *  proposed "cube follows path" at the cube's AUTHORED position, showing no change at
 *  the very moment the director is asked to judge one.
 *
 *  Resolves against the FORK — the PROPOSED scene — never the live store: the whole
 *  point is to show what the un-committed op would do.
 *
 *  BOTH BANDS, because the road's job is "place the object as the proposal would" and
 *  a Track-To places it by ORIENTATION. Applying only the position band (the one the
 *  #352 observation happened to name, via Follow-Path) left "point the cube at the
 *  target — accept?" previewing an UNROTATED cube — this bug's own defect surviving in
 *  the other band, and a miss hiding behind a correct sibling ([[V104]]). Found by
 *  observing a proposed Track-To rather than by trusting the first fix's symmetry.
 *
 *  Kind-agnostic by patching the value rather than each switch arm, so every ghost kind
 *  carrying `position`/`rotation` gets it. `resolveConstraintRotation` returns Euler XYZ
 *  DEGREES — the shape `GhostChild` already feeds to `degVec3ToRad`, matching the
 *  renderer (V37/H40). For a TOP-LEVEL child the parent world is identity, so the
 *  parent-local values the resolvers return ARE what this ghost renders at —
 *  ConstrainedR's own v1 contract. A nested child under a followed container is the
 *  #346 analogue. Scale is untouched: no band writes it.
 */
function applyGhostPoseBand(
  state: DagState,
  nodeId: string | null,
  value: SceneObject,
  ctx: EvalCtx,
  cache: EvaluatorCache,
): SceneObject {
  if (!nodeId) return value;
  const rec = value as unknown as Record<string, unknown>;
  const aim = resolveConstraintRotation(state, nodeId, ctx, cache);
  const followed = resolveConstraintPosition(state, nodeId, ctx, cache);
  const patch: Record<string, unknown> = {};
  if (aim && 'rotation' in rec) patch.rotation = aim;
  if (followed && 'position' in rec) patch.position = followed;
  if (Object.keys(patch).length === 0) return value;
  return { ...rec, ...patch } as unknown as SceneObject;
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

// Kinds a diff-ghost deliberately does NOT preview — a VISIBLE opt-out (§9), not a
// silent fall-through. Lights/cameras carry no geometry; a glTF/baked/modified mesh
// needs its loaded asset clone or OPFS bytes (async, outside this sync overlay). A
// NEW SceneObject kind lands in neither a case below nor this list, so the `.includes`
// exhaustiveness gate in `default` stops compiling — the add-a-kind decision (ghost
// it, or opt out here) can no longer be made silently (#357 / K22 step 8).
const GHOSTLESS_KINDS = [
  'GltfAsset',
  'BakedMesh',
  'ModifiedMesh',
  'DirectionalLight',
  'PointLight',
  'SpotLight',
  'AreaLight',
  'AmbientLight',
  'PerspectiveCamera',
  'OrthographicCamera',
] as const satisfies readonly SceneObject['kind'][];

function GhostChild({ value }: { value: SceneObject }) {
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
    // #324 — the two objects the agent can now CREATE must also be PREVIEWABLE. Without a
    // ghost they fell to the default below and the diff bar offered the director "add a
    // curve — accept?" over an unchanged viewport: nothing to approve but a sentence. An
    // agent proposal you cannot SEE is a proposal you cannot judge.
    case 'Curve':
      return (
        <group
          position={value.position as [number, number, number]}
          rotation={degVec3ToRad(value.rotation as [number, number, number])}
          scale={value.scale as [number, number, number]}
        >
          {/* The baked polyline — the same `samples` the real CurveLine draws, so the ghost
              is the SHAPE the director will get, not a stand-in box for it. */}
          <line>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[new Float32Array((value.samples ?? []).flat()), 3]}
              />
            </bufferGeometry>
            <lineBasicMaterial transparent opacity={0.6} color="#d98a2b" depthWrite={false} />
          </line>
        </group>
      );
    case 'Null':
      return (
        <mesh position={value.position as [number, number, number]}>
          <sphereGeometry args={[0.12, 10, 8]} />
          <meshBasicMaterial
            transparent
            opacity={0.4}
            color="#9ad0ff"
            depthWrite={false}
            wireframe
          />
        </mesh>
      );
    case 'Object': {
      // The object↔data split (#362): an Object ghosts its data's geometry at its
      // own TRS — the same thing ObjectR renders — so an agent's "add an Object"
      // proposal is SEEN, not just described. `data: null` is an Empty, and a
      // gltf/baked/array/mirror handle needs the loaded asset, so those ghost
      // nothing (the same contract GltfAsset has in GHOSTLESS_KINDS above).
      const data = value.data;
      if (!data || data.kind !== 'MeshData') return null;
      const desc = data.geometry.descriptor;
      const color = data.material && 'base' in data.material ? data.material.base.color : '#ffffff';
      const geom =
        desc.kind === 'box' ? (
          <boxGeometry args={desc.size as [number, number, number]} />
        ) : desc.kind === 'sphere' ? (
          <sphereGeometry args={[desc.radius, desc.widthSegments, desc.heightSegments]} />
        ) : null;
      if (!geom) return null;
      return (
        <mesh
          position={value.position as [number, number, number]}
          rotation={degVec3ToRad(value.rotation as [number, number, number])}
          scale={value.scale as [number, number, number]}
        >
          {geom}
          <meshBasicMaterial
            transparent
            opacity={0.35}
            color={color}
            depthWrite={false}
            wireframe
          />
        </mesh>
      );
    }
    default:
      // Exhaustiveness gate (§9 / #357): `.includes` on the `as const` list types its
      // argument as a declared ghostless kind, so a NEW SceneObject kind that is neither
      // cased above nor listed there fails to compile HERE — the ghost decision (draw it,
      // or opt out) can no longer be made silently. The list is also the runtime source.
      GHOSTLESS_KINDS.includes(value.kind);
      return null;
  }
}
