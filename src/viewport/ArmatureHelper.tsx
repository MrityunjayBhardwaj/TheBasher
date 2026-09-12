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

import { useCallback, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  type BoneFrame,
  boneTransforms,
  degenerateBasisCount,
  degenerateBasisNames,
  octahedralIndices,
  octahedralPositions,
  placeBones,
  resetDegenerateBasisCount,
} from './boneShape';
import { armatureBounds, posedSourceBones, referencePlacement } from './referenceRig';
import { useTimeStore } from '../app/stores/timeStore';
import { useViewportStore } from '../app/stores/viewportStore';
import { useDagStore } from '../core/dag/store';
import { useSelectionStore } from '../app/stores/selectionStore';
import { useBoneSelectionStore } from '../app/stores/boneSelectionStore';
import { getActiveBone } from '../app/boneSelection';
import { selectNode, type SelectClickLike } from './selectNodeOnClick';
import { assetIdsFor, bonesPickable, ownerNodeId, pickBone } from './armaturePick';
import type { PickNode } from './armaturePick';
import type { AnimationClipValue } from '../nodes/types';

/** Blender's default unselected bone wire. Chrome, so it reads as an overlay. */
const BONE_COLOR = '#c8d4e4';
/** The selected bone, drawn in the same accent the rest of the editor selects
 *  with. Colour, not size: a bone that grew on selection would move the very
 *  thing a director is trying to judge. */
const SELECTED_BONE_COLOR = '#f0a000';
/** The two per-instance colours. The material's own colour is white so these
 *  multiply through unchanged — a tinted material would make the selected bone
 *  a blend of two decisions rather than the colour it says it is. */
const BASE_COLOR = new THREE.Color(BONE_COLOR);
/** How far ahead of the skin a bone sorts when it is pickable at all. Small
 *  enough that no ordinary geometry can come between, and a MULTIPLIER rather
 *  than a subtraction so bones keep their own order among themselves. */
const PICK_DEPTH_BIAS = 1e-3;
const SELECTED_COLOR = new THREE.Color(SELECTED_BONE_COLOR);

/** The SOURCE rig, drawn in a different colour so the two are never confused —
 *  the entire value of the comparison depends on knowing which is which. */
const SOURCE_BONE_COLOR = '#ffb454';

/** How much of a live armature's bone names a retarget must account for before
 *  the two are treated as the same character. Well clear of both outcomes: a
 *  retarget's own target rig shares nearly all its names, and an unrelated
 *  armature shares essentially none. */
const NAME_MATCH_THRESHOLD = 0.4;

/** Hard ceiling on instances, so a pathological rig cannot allocate unboundedly.
 *  Rigs here run to ~78 bones (BVH) and a few hundred at the very most. */
const MAX_BONES = 4096;

/** How often the scene is re-traversed for armatures, in frames. */
const RESCAN_INTERVAL = 15;

/** A source rig to draw beside the character it drives (#977). */
export interface ReferenceRigInput {
  /** The retarget node's id — stable identity across frames. */
  readonly id: string;
  /** The SOURCE clip: carries its own skeleton, keyframes, duration and loop. */
  readonly clip: AnimationClipValue;
  /** The bone names of the rig this retarget DRIVES, used to find the live
   *  armature it belongs beside. */
  readonly targetBoneNames: readonly string[];
}

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
 * A bone name reduced to what BOTH sides agree on.
 *
 * 🔴 MEASURED, not defensive. The same glTF bone reaches the two sides under two
 * different names: the DAG projection reports `mixamorig_Hips` while the live
 * three.js `Bone` is `mixamorigHips`. Both are sanitisations of the file's
 * `mixamorig:Hips` — three strips the colon because `[].:/` are reserved in
 * PropertyBinding paths, and the projection replaces it with an underscore.
 * Compared raw, a rig and its own retarget target overlap by ZERO names, and the
 * reference rig silently never draws.
 *
 * Stripping every non-alphanumeric makes the match independent of which
 * sanitisation a given path applied.
 */
function normalizeBoneName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
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
export function ArmatureHelper({
  sourceRigs,
  showSourceRigs = false,
}: {
  /** Source rigs to draw beside their characters. Empty when nothing is
   *  retargeted, or when the diagnostic is off. */
  readonly sourceRigs?: readonly ReferenceRigInput[];
  readonly showSourceRigs?: boolean;
} = {}) {
  const scene = useThree((s) => s.scene);
  const boneDisplay = useViewportStore((s) => s.boneDisplay);
  const bonesInFront = useViewportStore((s) => s.bonesInFront);
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const refMeshRef = useRef<THREE.InstancedMesh>(null);
  const scans = useRef<ArmatureScan[]>([]);
  const signature = useRef('');
  // Starts at the interval so the very first frame scans.
  const sinceScan = useRef(RESCAN_INTERVAL);
  const parentInverse = useRef(new THREE.Matrix4());
  // What the LAST fill drew, so a click can be answered by the same flattening
  // that produced the instance it hit. Read in an event handler, never in
  // render, so a ref rather than state — and written in the same loop that sets
  // the matrices, so the two cannot describe different frames.
  const picks = useRef<{
    offsets: number[];
    frames: BoneFrame[];
    roots: THREE.Object3D[];
    /** Per armature: every node id that names a part of the same asset. Built on
     *  the rescan cadence, not per raycast — R3F raycasts the scene on pointer
     *  MOVE as well as on click, and a subtree walk there would cost a traverse
     *  per mouse motion. */
    assetIds: Set<string>[];
  }>({ offsets: [], frames: [], roots: [], assetIds: [] });
  // Which instance is currently painted as selected, so the colour buffer is
  // rewritten when it CHANGES rather than on every frame of a 4096-instance
  // mesh.
  const lastHighlight = useRef(-2);
  const lineRef = useRef<THREE.LineSegments>(null);
  /** What was last WRITTEN to the three materials, not read back from one. */
  const depthApplied = useRef<boolean | null>(null);
  const assetIdsCache = useRef<Set<string>[]>([]);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(octahedralPositions(), 3));
    g.setIndex(octahedralIndices());
    return g;
  }, []);

  /**
   * STICK MODE (#973). Blender's stick is not a mesh: `drw_shgroup_bone_stick`
   * pushes `{head, tail}` into a buffer (`overlay_armature.cc:210-231`) and the
   * shader widens the segment in SCREEN space — `stick_size = theme.sizes.pixel
   * * 5.0`, applied along a screen-aligned perpendicular
   * (`overlay_armature_stick_vert.glsl:63-75`). Constant screen width is the
   * property that makes it declutter: a hand's fingers stay readable at any zoom
   * because the bones do not shrink into each other.
   *
   * So ours is lines, not thin geometry. WebGL ignores `linewidth`, so a segment
   * is one device pixel against Blender's five — the same behaviour, a thinner
   * stroke. Fat lines (`LineSegments2`) would match the width and cost a second
   * geometry pipeline for a diagnostic overlay; that trade is not worth taking
   * until someone asks for it.
   */
  const lineGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_BONES * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_BONES * 6), 3));
    g.setDrawRange(0, 0);
    return g;
  }, []);

  const lineMaterial = useMemo(
    () => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
    [],
  );

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        // WHITE, with the bone colour carried per instance — see BASE_COLOR.
        color: '#ffffff',
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

  const sourceMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: SOURCE_BONE_COLOR,
        wireframe: true,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      }),
    [],
  );

  /**
   * Is this scene-object name a live DAG node? The walk up from a bone stops at
   * the first ancestor for which this is true — `SceneFromDAG` names each
   * producer's wrapping group with its node id, and an imported glTF's own group
   * names must not be mistaken for one.
   */
  const isLiveNodeId = useCallback(
    (name: string) => useDagStore.getState().state.nodes[name] !== undefined,
    [],
  );

  /**
   * Bones pick in FRONT of the skin, and only for the character being worked on.
   *
   * Two halves, and both are forced by what is already true:
   *
   * 1. THE BIAS. The helper draws with `depthTest: false` because a bone inside
   *    a mesh is invisible and the helper exists to be looked at (#972). A thing
   *    drawn in front that picks from behind is a pointer that disagrees with
   *    the picture — the click lands on the skin the director cannot see through.
   *    So the distance is scaled down, which orders bones ahead of the skinned
   *    mesh while keeping bones in their own depth order among themselves.
   *
   * 2. THE GATE. Without it that bias would take EVERY click over a bone, and
   *    most of a torso is over some bone — selecting the glTF parts of a rigged
   *    character would quietly stop working. Blender gates the same thing with a
   *    mode: a click reaches a bone only once its armature is the active object.
   *    Ours is the selection — the character has to be the thing being worked on
   *    first. Measured before it was written: six clicks on the character each
   *    selected a `GltfChild` and the helper's handler never fired at all.
   */
  const raycastBones = useCallback(
    (raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) => {
      const mesh = meshRef.current;
      if (!mesh || !mesh.visible || mesh.count === 0) return;
      const selectedId = useSelectionStore.getState().primaryNodeId;
      if (!selectedId) return;

      const hits: THREE.Intersection[] = [];
      THREE.InstancedMesh.prototype.raycast.call(mesh, raycaster, hits);
      if (hits.length === 0) return;

      const { offsets, frames } = picks.current;
      for (const hit of hits) {
        const id = hit.instanceId;
        if (id === undefined) continue;
        const bone = pickBone(id, offsets, frames);
        if (!bone) continue;
        if (!bonesPickable(picks.current.assetIds[bone.armature] ?? new Set(), selectedId))
          continue;
        intersects.push({ ...hit, distance: hit.distance * PICK_DEPTH_BIAS });
      }
    },
    [],
  );

  const onBoneClick = useCallback(
    (e: SelectClickLike & { instanceId?: number | null }) => {
      const id = e.instanceId;
      if (id === undefined || id === null) return;
      const { offsets, frames, roots } = picks.current;
      const hit = pickBone(id, offsets, frames);
      if (!hit) return;
      const nodeId = ownerNodeId(roots[hit.armature] ?? null, isLiveNodeId);
      // No owning node means nothing to select. The click is deliberately NOT
      // consumed in that case — `selectNode` leaves propagation alone for a null
      // id, so an unroutable click still reaches OrbitControls, which is what
      // every other picker in the viewport does.
      if (!nodeId) return;
      useBoneSelectionStore.getState().selectBone(nodeId, hit.name, hit.chain);
      // The NODE selection goes through the one handler (#211): a helper earns
      // selection by calling `selectNode`, never by writing the store itself.
      selectNode(nodeId, e);
    },
    [isLiveNodeId],
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
        // The set of bones changed — a rig was added, removed, reloaded or
        // swapped. A bone selection made against the old set may now name a
        // bone that is not there, and the node id it hangs off can survive the
        // swap, so the selection cannot detect this for itself. Cleared HERE,
        // at the one place that knows, rather than guessed at by the reader.
        if (signature.current !== '') useBoneSelectionStore.getState().clear();
        signature.current = sig;
        scans.current = fresh;
        assetIdsCache.current = fresh.map((s) =>
          assetIdsFor(s.root as unknown as PickNode, isLiveNodeId),
        );
      }
    }
    const current = scans.current;

    // The TRS useFrame that poses the bones and this one both run at the
    // default priority, so their order is mount order, not something to rely
    // on. Forcing the update here makes the read correct either way.
    for (const s of current) s.root.updateWorldMatrix(true, true);

    // Kept PER ARMATURE, not flattened away: a reference rig has to be sized
    // and placed against the bounds of the one character it belongs beside.
    resetDegenerateBasisCount();
    const perArmature = current.map((s) =>
      placeBones(
        s.bones.map((b, i) => ({ name: b.name, parent: s.parents[i], matrix: b.matrixWorld })),
      ),
    );
    const frames = perArmature.flat();

    // The offsets ARE the flattening, recorded rather than re-derived: a click
    // handler that recomputed them from `perArmature` would be a second copy of
    // this loop's arithmetic, free to disagree with it by a frame.
    const offsets: number[] = [];
    let running = 0;
    for (const armature of perArmature) {
      offsets.push(running);
      running += armature.length;
    }
    picks.current = {
      offsets,
      frames,
      roots: current.map((s) => s.root),
      assetIds: assetIdsCache.current,
    };

    // Instance matrices are in the mesh's LOCAL space; the bone matrices are
    // world. Without this the whole armature rides any ancestor transform twice.
    if (mesh.parent) {
      mesh.parent.updateWorldMatrix(true, false);
      parentInverse.current.copy(mesh.parent.matrixWorld).invert();
    } else {
      parentInverse.current.identity();
    }

    const count = Math.min(frames.length, MAX_BONES);
    mesh.count = count;
    mesh.visible = count > 0;
    const local = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      local.multiplyMatrices(parentInverse.current, frames[i].matrix);
      mesh.setMatrixAt(i, local);
    }
    mesh.instanceMatrix.needsUpdate = true;

    // ── the two display switches ────────────────────────────────────────────
    // Written every frame from the store rather than through a React effect:
    // the fill already runs here, and a material flag set in two places is a
    // material flag that will one day disagree with itself.
    // 🔴 The applied value is tracked HERE, not read back off one of the three
    // materials. Reading `material.depthTest` was tried and is a silent
    // no-op-forever: the mesh material is CONSTRUCTED with depthTest false, so
    // the condition was already satisfied on frame one and the line material —
    // constructed with three's default of TRUE — never received it. Sticks drew
    // inside the skin and read as "stick mode draws nothing", which is [[H697]]
    // wearing a different hat. One writer, one record of what it wrote.
    const wantDepth = !bonesInFront;
    if (depthApplied.current !== wantDepth) {
      depthApplied.current = wantDepth;
      for (const m of [material, sourceMaterial, lineMaterial]) {
        m.depthTest = wantDepth;
        m.depthWrite = wantDepth ? false : m.depthWrite;
        m.needsUpdate = true;
      }
    }
    const stick = boneDisplay === 'stick';
    // In stick mode the octahedra stay MOUNTED AND RAYCASTABLE and stop
    // drawing: `visible = false` would remove them from the ray, and picking a
    // bone would quietly stop working in one of two display modes. The pick
    // volume is the bone's shape either way — which is what Blender does too,
    // where selection in stick mode still hits the bone.
    if (material.colorWrite === stick) {
      material.colorWrite = !stick;
      material.needsUpdate = true;
    }

    // ── the selected bone, in a second colour ───────────────────────────────
    // Per-instance colour rather than a second mesh: one draw call is the whole
    // reason this helper is instanced, and a highlight that cost a second one
    // would trade the property the design was chosen for.
    const active = getActiveBone();
    const wantedNode = active?.nodeId ?? null;
    const wantedBone = active ? normalizeBoneName(active.boneName) : null;
    let highlighted = -1;
    if (wantedBone !== null) {
      for (let a = 0; a < current.length && highlighted < 0; a++) {
        // The owner is checked per armature, not per bone: two characters can
        // carry identically named bones, and a name alone would light the wrong
        // one on whichever rig the scan happened to reach first.
        if (ownerNodeId(current[a].root, isLiveNodeId) !== wantedNode) continue;
        const base = offsets[a];
        const end = a + 1 < offsets.length ? offsets[a + 1] : frames.length;
        for (let i = base; i < end && i < count; i++) {
          if (normalizeBoneName(frames[i].name) === wantedBone) {
            highlighted = i;
            break;
          }
        }
      }
    }
    if (highlighted !== lastHighlight.current || mesh.instanceColor === null) {
      lastHighlight.current = highlighted;
      for (let i = 0; i < count; i++) {
        mesh.setColorAt(i, i === highlighted ? SELECTED_COLOR : BASE_COLOR);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    // ── the sticks ──────────────────────────────────────────────────────────
    const lines = lineRef.current;
    if (lines) {
      lines.visible = stick && count > 0;
      if (lines.visible) {
        const pos = lineGeometry.getAttribute('position') as THREE.BufferAttribute;
        const col = lineGeometry.getAttribute('color') as THREE.BufferAttribute;
        const p = new THREE.Vector3();
        for (let i = 0; i < count; i++) {
          const f = frames[i];
          const c = i === highlighted ? SELECTED_COLOR : BASE_COLOR;
          p.set(f.head[0], f.head[1], f.head[2]).applyMatrix4(parentInverse.current);
          pos.setXYZ(i * 2, p.x, p.y, p.z);
          p.set(f.tail[0], f.tail[1], f.tail[2]).applyMatrix4(parentInverse.current);
          pos.setXYZ(i * 2 + 1, p.x, p.y, p.z);
          col.setXYZ(i * 2, c.r, c.g, c.b);
          col.setXYZ(i * 2 + 1, c.r, c.g, c.b);
        }
        pos.needsUpdate = true;
        col.needsUpdate = true;
        lineGeometry.setDrawRange(0, count * 2);
      }
    }

    // ── the SOURCE rigs, beside the characters they drive (#977) ────────────
    // Deliberately NOT behind the `count === 0` early return that used to sit
    // here: the two meshes are independent, and a frame with no live armature
    // must still leave the reference mesh in a defined state rather than
    // showing whatever it held last.
    const refMesh = refMeshRef.current;
    // Kept for the DEV seam: the source rig's drawn frames, so a probe can
    // compare limb directions against the live rig without a second sampling
    // path (which would be a second answer to the pose it is measuring).
    const refNames: string[] = [];
    const refMatrices: number[][] = [];
    if (refMesh) {
      let refCount = 0;
      if (showSourceRigs && sourceRigs && sourceRigs.length > 0 && perArmature.length > 0) {
        const seconds = useTimeStore.getState().seconds;
        for (const rig of sourceRigs) {
          // Which live armature is this retarget's character? Matched on the
          // TARGET rig's bone names rather than on index or id order, so two
          // characters in one scene cannot swap reference rigs (V22).
          const wanted = new Set(rig.targetBoneNames.map(normalizeBoneName));
          if (wanted.size === 0) continue;
          let best: BoneFrame[] | null = null;
          let bestScore = 0;
          for (const armature of perArmature) {
            if (armature.length === 0) continue;
            let hits = 0;
            for (const f of armature) if (wanted.has(normalizeBoneName(f.name))) hits++;
            const score = hits / armature.length;
            if (score > bestScore) {
              bestScore = score;
              best = armature;
            }
          }
          if (!best || bestScore < NAME_MATCH_THRESHOLD) continue;

          const posed = boneTransforms(posedSourceBones(rig.clip, seconds));
          if (posed.length === 0) continue;
          const srcB = armatureBounds(posed);
          const tgtB = armatureBounds(best);
          const place = referencePlacement(srcB, tgtB);
          for (const f of posed) {
            if (refCount >= MAX_BONES) break;
            // Skip the rig's transport node for the same reason armatureBounds
            // excludes it: its octahedron runs from the world origin to a pelvis
            // that walks away, so it is a connector rather than anatomy and it
            // dominates the very comparison this rig is drawn for.
            if (f.parent < 0) continue;
            local.multiplyMatrices(parentInverse.current, place).multiply(f.matrix);
            refMesh.setMatrixAt(refCount++, local);
            if (import.meta.env.DEV) {
              refNames.push(f.name);
              refMatrices.push([...local.elements]);
            }
          }
        }
      }
      refMesh.count = refCount;
      refMesh.visible = refCount > 0;
      refMesh.instanceMatrix.needsUpdate = true;
    }

    if (count === 0) return;

    // DEV observation seam, the LightHelpers pattern: what the helper actually
    // drew this frame, so an e2e can assert on the rig rather than on pixels.
    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __basher_armature?: {
          armatures: number;
          bones: number;
          names: string[];
          matrices: number[][];
          // #977 — the REFERENCE rigs get their own counters. Without them the
          // seam reports the live mesh only, and "the source rig did not draw"
          // is indistinguishable from "it drew outside the camera frustum".
          sourceRigsOffered: number;
          sourceBones: number;
          sourceNames: string[];
          sourceMatrices: number[][];
          degenerateBases: number;
          degenerateNames: string[];
          highlightedBone: string | null;
        };
      };
      w.__basher_armature = {
        armatures: current.length,
        bones: count,
        names: frames.slice(0, count).map((f) => f.name),
        matrices: frames.slice(0, count).map((f) => [...f.matrix.elements]),
        sourceRigsOffered: showSourceRigs ? (sourceRigs?.length ?? 0) : 0,
        sourceBones: refMeshRef.current?.count ?? 0,
        sourceNames: refNames,
        sourceMatrices: refMatrices,
        degenerateBases: degenerateBasisCount,
        degenerateNames: [...degenerateBasisNames],
        // WHICH bone is painted as selected, by name rather than by index —
        // an index means nothing to a reader and would have to be resolved
        // against this same array to say anything, which is a second chance to
        // resolve it differently. null when nothing is highlighted (#973).
        highlightedBone: highlighted >= 0 ? (frames[highlighted]?.name ?? null) : null,
      };
    }
  });

  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[geometry, material, MAX_BONES]}
        frustumCulled={false}
        renderOrder={999}
        visible={false}
        onClick={onBoneClick}
        raycast={raycastBones}
        // Never part of a production render — Blender does not render armatures
        // either. V37's hide-pass keys on exactly this flag.
        userData={{ editorChrome: true }}
      />
      {/* The sticks. Deliberately NOT applied to the reference rig below: that
          rig exists to judge ROLL against the live one, and a stick is a head
          and a tail with no third axis — comparing roll with sticks is
          comparing something neither shape carries. */}
      <lineSegments
        ref={lineRef}
        args={[lineGeometry, lineMaterial]}
        frustumCulled={false}
        renderOrder={999}
        visible={false}
        userData={{ editorChrome: true }}
      />
      <instancedMesh
        ref={refMeshRef}
        args={[geometry, sourceMaterial, MAX_BONES]}
        frustumCulled={false}
        renderOrder={999}
        visible={false}
        userData={{ editorChrome: true }}
      />
    </>
  );
}
