// ArmatureHelper — draws every rig in the scene as Blender-style octahedral
// bones, so a character's skeleton is visible and its ROLL is judgeable by eye
// (#972, epic #971; closes the gap #970 names).
//
// Sibling of LightHelpers.tsx / CameraHelpers.tsx: a camera gets a frustum, a
// light gets a gizmo, an empty gets a glyph, a curve gets a line — and until
// now a rig got nothing. Same contract as those: renders only, marked
// `editorChrome` so the image render's hide-pass excludes it (V37), hidden in
// `rendered` shading at the mount site. V8 holds — no dispatch, no DAG write.
//
// WHY IT READS LIVE `Bone` OBJECTS RATHER THAN THE DAG VALUE:
// `GltfSkeleton.evaluate` returns the bind pose captured at import
// (GltfSkeleton.ts:48-53 — no time argument, static). The ANIMATED pose exists
// only as three.js `Bone`s, written per frame by the TRS useFrame in
// SceneFromDAG. Drawing the DAG value would show a rig frozen in bind pose
// while the character walks — which looks exactly like "the clip is not bound",
// the very confusion #970 is about.
//
// The geometry and the roll handling live in boneShape.ts, which is pure and
// unit-tested; this file is placement and plumbing.
//
// REF: THESIS.md §11; vyapti V1, V8, V37;
//      ref/GROUND_TRUTH_BLENDER_ARMATURE_DISPLAY.md.

import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { type BoneWorld, octahedralIndices, octahedralPositions, placeBones } from './boneShape';

/** Blender's default unselected bone wire. Chrome, so it reads as an overlay. */
const BONE_COLOR = '#c8d4e4';

/** Hard ceiling on instances, so a pathological rig cannot allocate unboundedly.
 *  Rigs here run to ~78 bones (BVH) and a few hundred at the very most. */
const MAX_BONES = 4096;

/** How often the scene is re-traversed for armatures, in frames. */
const RESCAN_INTERVAL = 15;

/** One armature found in the scene: its root bone, and the bones under it. */
interface ArmatureScan {
  readonly root: THREE.Object3D;
  readonly bones: THREE.Object3D[];
  /** Parent index into `bones`, or -1 when the parent is not itself a bone. */
  readonly parents: number[];
}

function isBone(o: THREE.Object3D): boolean {
  return (o as THREE.Bone).isBone === true;
}

/**
 * Collect every armature in the scene: a root is a bone whose parent is not a
 * bone, and its armature is that bone's bone-only subtree, in DFS order so
 * parents always precede children.
 */
export function scanArmatures(scene: THREE.Object3D): ArmatureScan[] {
  const out: ArmatureScan[] = [];
  scene.traverse((o) => {
    if (!isBone(o) || (o.parent != null && isBone(o.parent))) return;
    const bones: THREE.Object3D[] = [];
    const parents: number[] = [];
    const walk = (b: THREE.Object3D, parentIdx: number) => {
      if (bones.length >= MAX_BONES) return;
      const i = bones.length;
      bones.push(b);
      parents.push(parentIdx);
      for (const c of b.children) if (isBone(c)) walk(c, i);
    };
    walk(o, -1);
    if (bones.length > 0) out.push({ root: o, bones, parents });
  });
  return out;
}

/** A cheap signature that changes when the SET of bones changes (asset reload,
 *  a second character, a rig swap) but not when they merely move. */
function scanSignature(scans: ArmatureScan[]): string {
  return scans.map((s) => `${s.root.uuid}:${s.bones.length}`).join('|');
}

/**
 * One InstancedMesh for ALL armatures in the scene.
 *
 * `grep -rn "InstancedMesh" src/` was 0 hits before this — rigs run to ~78
 * bones, so a mesh per bone would add ~78 draw calls per character. One
 * octahedron geometry with a per-instance matrix keeps it at one, and gives v2
 * an `instanceId` to map back to a bone name for selection.
 */
export function ArmatureHelper() {
  const scene = useThree((s) => s.scene);
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const scans = useRef<ArmatureScan[]>([]);
  const signature = useRef('');
  // Starts at the interval so the very first frame scans.
  const sinceScan = useRef(RESCAN_INTERVAL);
  const parentInverse = useRef(new THREE.Matrix4());

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(octahedralPositions(), 3));
    g.setIndex(octahedralIndices());
    return g;
  }, []);

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: BONE_COLOR,
        // The octahedron's 8 triangles have exactly the 12 edges of
        // `OCTAHEDRAL_WIRE_LINES`, so wireframe draws Blender's bone outline
        // with no second buffer — and an unshaded solid would read as a blob.
        wireframe: true,
        transparent: true,
        opacity: 0.9,
        // DRAWN THROUGH THE SKIN, and this is not a preference. Observed on
        // mixamo-xbot: with depth testing on, the bones sit INSIDE the mesh and
        // only fragments at the shins and feet are visible — so the one thing
        // this helper exists for, judging the leg chain's roll by eye, is
        // exactly the thing you cannot do. #971 filed x-ray as a v2 nicety;
        // the picture says it is v1's exit condition. Blender has the same
        // switch ("In Front") for the same reason. A toggle belongs in v2.
        depthTest: false,
        depthWrite: false,
      }),
    [],
  );

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // The whole-scene traverse is the expensive part here, so it runs on a
    // fixed cadence rather than every frame; in between, the topology is reused
    // and only the ~78 bone matrices are refreshed. RESCAN_INTERVAL frames is
    // therefore also the longest a rig that was just added or removed can stay
    // wrong on screen (~0.25 s at 60fps), which is the trade being made.
    if (++sinceScan.current >= RESCAN_INTERVAL) {
      sinceScan.current = 0;
      const fresh = scanArmatures(scene);
      const sig = scanSignature(fresh);
      if (sig !== signature.current) {
        signature.current = sig;
        scans.current = fresh;
      }
    }
    const current = scans.current;

    // The TRS useFrame that poses the bones and this one both run at the
    // default priority, so their order is mount order, not something to rely
    // on. Forcing the update here makes the read correct either way.
    for (const s of current) s.root.updateWorldMatrix(true, true);

    const frames = current.flatMap((s) => {
      const input: BoneWorld[] = s.bones.map((b, i) => ({
        name: b.name,
        parent: s.parents[i],
        matrix: b.matrixWorld,
      }));
      return placeBones(input);
    });

    const count = Math.min(frames.length, MAX_BONES);
    mesh.count = count;
    mesh.visible = count > 0;
    if (count === 0) return;

    // Instance matrices are in the mesh's LOCAL space; the bone matrices are
    // world. Without this the whole armature rides any ancestor transform twice.
    if (mesh.parent) {
      mesh.parent.updateWorldMatrix(true, false);
      parentInverse.current.copy(mesh.parent.matrixWorld).invert();
    } else {
      parentInverse.current.identity();
    }
    const local = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      local.multiplyMatrices(parentInverse.current, frames[i].matrix);
      mesh.setMatrixAt(i, local);
    }
    mesh.instanceMatrix.needsUpdate = true;

    // DEV observation seam, the LightHelpers pattern: what the helper actually
    // drew this frame, so an e2e can assert on the rig rather than on pixels.
    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __basher_armature?: {
          armatures: number;
          bones: number;
          names: string[];
          matrices: number[][];
        };
      };
      w.__basher_armature = {
        armatures: current.length,
        bones: count,
        names: frames.slice(0, count).map((f) => f.name),
        matrices: frames.slice(0, count).map((f) => [...f.matrix.elements]),
      };
    }
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, MAX_BONES]}
      frustumCulled={false}
      renderOrder={999}
      visible={false}
      // Never part of a production render — Blender does not render armatures
      // either. V37's hide-pass keys on exactly this flag.
      userData={{ editorChrome: true }}
    />
  );
}
