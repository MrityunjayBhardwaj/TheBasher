// Migration observation gate (v0.6 #1 scale, issue #150; v0.6 #2 material, #178).
//
// The pre-mortem (CONTEXT §E): a partial / non-identity migration that changes
// the rendered result for an EXISTING saved project. This suite is the
// byte-identical-render gate — it runs a REAL serialized v1 BoxMesh project
// (real bytes, the boundary the user hits via loadProject) through the
// production migration path and asserts the saved look is preserved across BOTH
// migration steps (v1→v2 scale, v2→v3 material).
//
// THE R1 TWO-DEFAULTS-ON-PURPOSE GATE (v0.6 #2): a MIGRATED box gets
// specular.roughness 0.5 (CURRENT look) so it renders byte-identically; a FRESH
// box (zod default) gets the OpenPBR 0.3. This suite proves BOTH — the migrated
// box at 0.5 AND the fresh box at 0.3 — so a future reader cannot "fix" the
// discrepancy without a RED test.
//
// REF: PLAN.md W1 (1.6); THESIS §52; vyapti V4/V10/V32; hetvabhasa H14/H25; #178.

import { primaryMaterial } from '../../app/materialAssignment';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../dag';
import { getNodeType } from '../dag/registry';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { resolveEvaluatedMesh } from '../../app/resolveEvaluatedMesh';
import { resolveEvaluatedTransform } from '../../app/resolveEvaluatedTransform';
import { DEFAULT_CAMERA_POSE, resolveCameraPoseAt } from '../../app/activeCamera';
import { sphereGeometryRef } from '../../app/modifierGeometry';
import { hydrateInlineMaterial, openpbrMaterialSchema } from '../../nodes/materialSchema';
import { CURRENT_LOOK_ROUGHNESS } from '../../nodes/materialSchema';
import { evaluate } from '../dag/evaluator';
import { sampleCurve } from '../../nodes/curveMath';
import type { BakedDataValue, CurveDataValue, InlineMaterialSpec, Vec3 } from '../../nodes/types';
import {
  KeyframeChannelNumberNode,
  type KeyframeChannelNumberParams,
} from '../../nodes/KeyframeChannelNumber';
import { sampleScalarKeyframesExtended, type ChannelExtend } from '../../nodes/keyframeInterp';
import type { FModNoise } from '../../nodes/channelModifiers';
import { makeSplitCamera } from '../../test-utils/splitCamera';
import { migrateNodes, migrateProjectFormat } from './migrations';
import { buildDefaultDagState } from './default';
import { ProjectSchema, type Project } from './schema';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

/** A serialized pre-this-milestone (v1) BoxMesh project — NO scale, flat material. */
const V1_BOX_PROJECT = {
  formatVersion: 1,
  id: 'p150-migration',
  name: 'pre-scale box',
  createdAt: 0,
  updatedAt: 0,
  nodeVersions: { BoxMesh: 1 },
  state: {
    nodes: {
      n_box: {
        id: 'n_box',
        type: 'BoxMesh',
        version: 1,
        params: {
          size: [2, 3, 4],
          position: [1, 0, -1],
          rotation: [0, 45, 0],
          material: { name: 'default', color: '#5af07a' },
        },
        inputs: {},
      },
    },
    outputs: {},
  },
};

function loadFromBytes(obj: unknown): Project {
  // Mirror loadProject (io.ts) exactly: real JSON round-trip → format migration
  // → schema parse → node migration.
  const raw = JSON.parse(JSON.stringify(obj));
  const formatMigrated = migrateProjectFormat(raw);
  const project = ProjectSchema.parse(formatMigrated);
  return migrateNodes(project);
}

function ctxAt(seconds: number) {
  return { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
}

// ── Building a PRE-migration graph the way the subject receives it ──────────────────────
//
// The seven unentangled fused types are DELETED (#365 Phase 5), so `addNode`/`connect`
// cannot mint them: both call `requireNodeType` (`ops.ts:145`/`:203-204`) and throw on a
// type the registry lacks. That gate is the HARNESS's, not the subject's — `migrateProjectFormat`
// reads raw JSON off disk and never consults the registry, which is exactly why a real project
// containing a fused box still loads and still splits with the relics gone.
//
// Building these fixtures through `addNode` therefore imposed a precondition the code under
// test does not have. It made this file read as the blocker for the deletion it exists to
// license: delete the types, and thirty assertions light up in the one file whose whole job is
// to prove old projects survive. Every one of them failed inside `buildFused*` — none inside a
// migration.
//
// So the retired shapes are written out HERE, defaults included, exactly as `addNode` stored
// them (it PARSES, so a saved project carries the fully-defaulted shape and the byte-identity
// comparisons below depend on it). The material blob comes from the LIVE `openpbrMaterialSchema`
// rather than a hand-copied literal — it is the same schema the relics' own `material` param
// used, so it cannot drift from what a v2 save actually contained.
//
// ⚠️ The `type: '<relic>'` literals below are DELIBERATE, and are the one case where naming a
// retired kind is the right tool rather than the hazard #594 tracks: this fixture's subject
// genuinely IS a shape the product can no longer build. A migration that does not build the
// pre-migration shape is not testing a migration.
//
// EVERY fused construction in this file now goes through `addRetiredNode` (#599 converted the
// last three — Curve, PerspectiveCamera, BakedMesh — when their live exports were rehomed and
// the definitions deleted). Nothing here reaches the registry for a relic any more, which is
// also why the file is no longer listed in the retire-a-kind gate's `RELIC_IS_THE_SUBJECT`:
// the exemption had stopped protecting anything the gate could see.

/** The transform triple every fused posable type defaulted to. */
const FUSED_TRS = {
  position: [0, 0, 0] as Vec3,
  rotation: [0, 0, 0] as Vec3,
  scale: [1, 1, 1] as Vec3,
};

/**
 * The fully-defaulted param bag a fused `PerspectiveCamera` stored, given what was authored.
 *
 * `addNode` PARSED against the node's schema, so every key the author left out still reached
 * the save carrying its default — and once the definition is deleted there is no schema left
 * to re-derive them from. Spelled ONCE rather than at each of the five call sites: five copies
 * of a default set agree right up until one of them is edited.
 */
function fusedPerspectiveCamera(authored: Record<string, unknown>): Record<string, unknown> {
  return {
    sensorSize: 36,
    near: 0.01,
    far: 500,
    dofEnabled: false,
    focusDistance: 5,
    fStop: 2.8,
    focusOnTarget: false,
    lookAt: [0, 0, 0],
    roll: 0,
    ...authored,
  };
}

/** The same, for the fused `Curve` (#321) — TRS plus the closure/resolution pair. Every call
 *  site authors `points`, which is why there is no default for it here. */
function fusedCurve(authored: Record<string, unknown>): Record<string, unknown> {
  return { ...FUSED_TRS, closed: false, resolution: 16, ...authored };
}

/** The fully-defaulted inline material a fused mesh stored for an authored colour. */
function fusedMaterial(color: string): InlineMaterialSpec {
  return openpbrMaterialSchema().parse({
    name: 'default',
    base: { color },
  }) as InlineMaterialSpec;
}

/**
 * Insert a node of a type the registry no longer has.
 *
 * Mirrors `applyAddNode` (`ops.ts:142-165`) exactly, minus the `requireNodeType` lookup and
 * the schema parse it feeds — the caller supplies the already-parsed params, because there is
 * no schema left to parse against and a saved project carries the parsed shape anyway.
 */
function addRetiredNode(
  s: DagState,
  nodeId: string,
  type: string,
  version: number,
  params: Record<string, unknown>,
): DagState {
  if (s.nodes[nodeId]) throw new Error(`addRetiredNode: id already exists: ${nodeId}`);
  return {
    ...s,
    nodes: { ...s.nodes, [nodeId]: { id: nodeId, type, version, params, inputs: {} } },
  };
}

/**
 * Wire an edge whose PRODUCER is a retired type.
 *
 * `applyConnect` resolves both ends through the registry to compare socket types, so a live
 * consumer cannot accept a relic either. The consumer here is always a live type (Scene,
 * Group), so its cardinality is still looked up for real rather than passed in — asserted,
 * so a future fixture that wires relic→relic fails loudly instead of guessing 'single'.
 */
function connectFromRetired(
  s: DagState,
  from: { node: string; socket: string },
  to: { node: string; socket: string },
): DagState {
  const consumer = s.nodes[to.node];
  if (!consumer) throw new Error(`connectFromRetired: no consumer ${to.node}`);
  const def = getNodeType(consumer.type);
  if (!def) {
    throw new Error(
      `connectFromRetired: consumer ${to.node} is itself a retired type (${consumer.type}) — ` +
        `its socket cardinality cannot be looked up, so this helper cannot wire it`,
    );
  }
  const desc = def.inputs[to.socket];
  if (!desc) throw new Error(`connectFromRetired: ${consumer.type} has no input '${to.socket}'`);
  const ref = { node: from.node, socket: from.socket };
  const prior = consumer.inputs[to.socket];
  const binding =
    desc.cardinality === 'list'
      ? [...(Array.isArray(prior) ? prior : prior ? [prior] : []), ref]
      : ref;
  return {
    ...s,
    nodes: {
      ...s.nodes,
      [to.node]: { ...consumer, inputs: { ...consumer.inputs, [to.socket]: binding } },
    },
  };
}

describe('v1 box → normalize + split to Object + BoxData (byte-identical render gate)', () => {
  it('normalizes a v1 box through BoxMesh’s OWN ladder, THEN splits (Object gets scale=identity)', () => {
    const migrated = loadFromBytes(V1_BOX_PROJECT);
    // formatVersion 1 → 2 (AnimationLayer) → 3 (box split) → 4 (sphere split). The box
    // node keeps its id but is now an Object; the v1→v4 normalization ran first (scale=identity).
    const obj = migrated.state.nodes.n_box;
    expect(obj.type).toBe('Object');
    expect((obj.params as { scale?: unknown }).scale).toEqual([1, 1, 1]);
    const data = splitDataNode(migrated, 'n_box');
    expect(data).toBeDefined();
    expect((data!.params as { size?: unknown }).size).toEqual([2, 3, 4]);
  });

  it('splits byte-identically: position → Object; size + widened material → the data node (look preserved, roughness 0.5)', () => {
    const migrated = loadFromBytes(V1_BOX_PROJECT);
    const orig = V1_BOX_PROJECT.state.nodes.n_box.params;
    // Transform lands on the Object, byte-identical.
    const op = migrated.state.nodes.n_box.params as Record<string, unknown>;
    expect(op.position).toEqual(orig.position);
    expect(op.rotation).toEqual(orig.rotation);
    // Geometry + material land on the data node. The v1 flat material widened to
    // the OpenPBR IR but the LOOK is preserved (roughness = CURRENT look 0.5), so
    // the normalize-then-split keeps a pre-#178 box byte-identical.
    const data = splitDataNode(migrated, 'n_box')!;
    expect((data.params as { size?: unknown }).size).toEqual(orig.size);
    const mat = (data.params as { material: InlineMaterialSpec }).material;
    expect(mat.base.color).toBe('#5af07a'); // preserved from the v1 flat color
    expect(mat.specular.roughness).toBe(CURRENT_LOOK_ROUGHNESS); // 0.5, not OpenPBR 0.3 (R1)
    expect(mat.base.metalness).toBe(0);
    expect(mat.geometry.opacity).toBe(1);
    expect(mat.emission.color).toBe('#000000');
    expect(mat.maps.albedo).toBeNull();
    // v0.6 #3 — uvTransform migrates to IDENTITY (no placement) → byte-identical render.
    expect(mat.uvTransform.tiling).toEqual([1, 1]);
    expect(mat.uvTransform.offset).toEqual([0, 0]);
    expect(mat.uvTransform.rotation).toBe(0);
  });

  it('renders identically — evaluated material is the CURRENT look (R1: roughness 0.5)', () => {
    const migrated = loadFromBytes(V1_BOX_PROJECT);
    const mesh = resolveEvaluatedMesh(migrated.state, 'n_box', ctxAt(0));
    expect(mesh).not.toBeNull();
    expect(mesh!.geometry.descriptor).toEqual({ kind: 'box', size: [2, 3, 4] });
    expect(mesh!.transform.scale).toEqual([1, 1, 1]); // identity → renderer no-op
    expect(mesh!.transform.position).toEqual([1, 0, -1]);
    const mat = primaryMaterial(mesh!.materials) as InlineMaterialSpec;
    expect(mat.base.color).toBe('#5af07a');
    expect(mat.specular.roughness).toBe(0.5); // MIGRATED box = current look
  });

  it('R1 contrast — a FRESH box gets OpenPBR roughness 0.3 (NOT the migrated 0.5)', () => {
    // The two-defaults-on-purpose split: a brand-new box (zod default, never
    // migrated) renders with the correct OpenPBR roughness, while the migrated
    // box above preserves the legacy 0.5. If these two ever converge, R1 broke.
    const fresh = buildDefaultDagState();
    const mesh = resolveEvaluatedMesh(fresh, 'n_box', ctxAt(0));
    expect(mesh).not.toBeNull();
    const mat = primaryMaterial(mesh!.materials) as InlineMaterialSpec;
    expect(mat.specular.roughness).toBe(0.3); // FRESH box = OpenPBR
    expect(mat.specular.roughness).not.toBe(CURRENT_LOOK_ROUGHNESS);
  });

  it('is idempotent — re-loading a split project is a stable no-op', () => {
    const once = loadFromBytes(V1_BOX_PROJECT);
    // Re-serialize the migrated (split) project and load again — the round-trip
    // the user hits on every subsequent save/load. formatVersion is now 5, so no
    // format migration runs; the Object + BoxData pair is stable.
    const twice = loadFromBytes(once);
    expect(twice.state.nodes.n_box).toEqual(once.state.nodes.n_box);
    expect(splitDataNode(twice, 'n_box')).toEqual(splitDataNode(once, 'n_box'));
    expect(twice.state.nodes.n_box.type).toBe('Object');
  });
});

// ── object↔data split (#365 Phase 5a): fused BoxMesh → Object + BoxData ──────
// A formatVersion-2 project with a fused BoxMesh is split on load: the box node
// becomes an `Object` (INHERITS the id — so every edge/channel/constraint that
// named it still resolves) + a fresh `BoxData` (size + material). THE gate:
// resolveEvaluatedMesh('<box id>') — the SAME read the renderer draws — is
// byte-identical to a fused box; a `position` channel stays on the Object while a
// `size` channel re-targets the data node. REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §5.

/** The colour the fused fixture AUTHORS. A saved project records its colour, and the canonical
 *  split pair authors the same one — so the byte-identity comparison is about the SPLIT being
 *  invisible, not about whatever the canonical seed happens to default to (#394 D7). */
const FUSED_BOX_COLOR = '#5af07a';

/** A genuinely FUSED BoxMesh scene, wired into a Scene — the pre-split shape. The default
 *  project is split-native now (#365 Phase 5a Slice 1b), so a migration fixture must build a
 *  real fused BoxMesh by hand; it authors the same size + material as the canonical split pair
 *  below, so the byte-identical comparison holds. */
function buildFusedBoxDagState(): DagState {
  let s = emptyDagState();
  const add = (op: Parameters<typeof applyOp>[1]) => {
    s = applyOp(s, op).next;
  };
  s = addRetiredNode(s, 'n_box', 'BoxMesh', 4, {
    size: [1, 1, 1],
    ...FUSED_TRS,
    material: fusedMaterial(FUSED_BOX_COLOR),
  });
  s = addRetiredNode(
    s,
    'n_camera',
    'PerspectiveCamera',
    1,
    fusedPerspectiveCamera({ fov: 45, near: 0.01, far: 500, position: [3, 2, 3] }),
  );
  add({ type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} });
  add({
    type: 'addNode',
    nodeId: 'n_render',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'ACES', smaa: true } },
  });
  s = connectFromRetired(
    s,
    { node: 'n_box', socket: 'out' },
    { node: 'n_scene', socket: 'children' },
  );
  s = connectFromRetired(
    s,
    { node: 'n_camera', socket: 'out' },
    { node: 'n_scene', socket: 'camera' },
  );
  add({
    type: 'connect',
    from: { node: 'n_scene', socket: 'out' },
    to: { node: 'n_render', socket: 'scene' },
  });
  return {
    ...s,
    outputs: {
      scene: { node: 'n_scene', socket: 'out' },
      render: { node: 'n_render', socket: 'out' },
    },
  };
}

/** The CANONICAL split pair for the fused fixture above — same size, same authored
 *  material, hand-built rather than taken from the default project. The claim under test
 *  is "migrating a fused box yields the same thing as authoring the split pair directly",
 *  which has nothing to do with what colour the canonical seed happens to ship (#394 D7);
 *  reaching for `buildDefaultDagState()` quietly coupled the two. */
function buildCanonicalSplitBoxState(): DagState {
  let s = emptyDagState();
  const add = (op: Parameters<typeof applyOp>[1]) => {
    s = applyOp(s, op).next;
  };
  add({
    type: 'addNode',
    nodeId: 'n_box_data',
    nodeType: 'BoxData',
    params: { size: [1, 1, 1], material: { name: 'default', base: { color: FUSED_BOX_COLOR } } },
  });
  add({
    type: 'addNode',
    nodeId: 'n_box',
    nodeType: 'Object',
    params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  add({
    type: 'connect',
    from: { node: 'n_box_data', socket: 'out' },
    to: { node: 'n_box', socket: 'data' },
  });
  add({ type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} });
  add({
    type: 'connect',
    from: { node: 'n_box', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  });
  return { ...s, outputs: { scene: { node: 'n_scene', socket: 'out' } } };
}

/** A serialized formatVersion-2 (pre-split) project: one fused BoxMesh built by
 *  the real pipeline (authoritative shape) + a position channel and a size
 *  channel targeting it, then stamped formatVersion 2. */
function buildV2FusedBoxJson() {
  let s = buildFusedBoxDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_pos',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: 'n_box',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 1, value: [0, 6, 0], easing: 'linear' },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_size',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'size',
      target: 'n_box',
      paramPath: 'size',
      keyframes: [
        { time: 0, value: [1, 1, 1], easing: 'linear' },
        { time: 1, value: [2, 2, 2], easing: 'linear' },
      ],
    },
  }).next;
  const nodes = JSON.parse(JSON.stringify(s.nodes));
  return {
    formatVersion: 2,
    id: 'p365-split',
    name: 'pre-split box',
    createdAt: 0,
    updatedAt: 0,
    nodeVersions: { BoxMesh: nodes.n_box.version, KeyframeChannelVec3: nodes.n_pos.version },
    state: { nodes, outputs: s.outputs },
  };
}

/** The BoxData node a split produced from the box `boxId` (the sole BoxData whose
 *  id starts with `${boxId}__data`). */
function splitDataNode(project: Project, boxId: string) {
  return Object.values(project.state.nodes).find(
    (n) => n.type === 'BoxData' && n.id.startsWith(`${boxId}__data`),
  );
}

describe('object↔data split v2 → v3: fused BoxMesh → Object + BoxData (#365)', () => {
  it('splits the box: n_box becomes an Object (id inherited) + a wired BoxData', () => {
    const migrated = loadFromBytes(buildV2FusedBoxJson());
    // 2 → 3 (box split) → 4 (sphere pass, no spheres) → 5 (curve pass, no curves)
    // → 6 (light pass, no lights) → 7 (camera split — this fixture HAS a camera)
    // → 8 (baked pass, no baked meshes).
    expect(migrated.formatVersion).toBe(9);
    // The box node keeps its id but is now an Object owning only the transform.
    const obj = migrated.state.nodes.n_box;
    expect(obj.type).toBe('Object');
    const op = obj.params as Record<string, unknown>;
    expect(op.position).toEqual([0, 0, 0]);
    expect(op.scale).toEqual([1, 1, 1]);
    expect(op.size).toBeUndefined(); // size left the Object
    expect(op.material).toBeUndefined(); // material left the Object
    // A fresh BoxData owns the geometry + material and nothing else.
    const data = splitDataNode(migrated, 'n_box');
    expect(data).toBeDefined();
    expect((data!.params as { size?: unknown }).size).toEqual([1, 1, 1]);
    expect((data!.params as { material?: unknown }).material).toBeDefined();
    // The Object points at the data node through `data`.
    const dataRef = (obj.inputs as Record<string, { node: string }>).data;
    expect(dataRef.node).toBe(data!.id);
  });

  it('renders byte-identically to a fused box (the split is invisible)', () => {
    const migrated = loadFromBytes(buildV2FusedBoxJson());
    const split = resolveEvaluatedMesh(migrated.state, 'n_box', ctxAt(0));
    const fused = resolveEvaluatedMesh(buildCanonicalSplitBoxState(), 'n_box', ctxAt(0));
    expect(split).not.toBeNull();
    expect(fused).not.toBeNull();
    expect(split!.geometry.descriptor).toEqual(fused!.geometry.descriptor);
    expect(primaryMaterial(split!.materials)).toEqual(primaryMaterial(fused!.materials));
    expect(split!.transform.position).toEqual(fused!.transform.position);
    expect(split!.transform.scale).toEqual(fused!.transform.scale);
  });

  it('the Object inherits the id, so a position channel still animates it', () => {
    const migrated = loadFromBytes(buildV2FusedBoxJson());
    // The position channel still targets n_box (now the Object) — unchanged.
    expect((migrated.state.nodes.n_pos.params as { target: string }).target).toBe('n_box');
    const p0 = resolveEvaluatedTransform(migrated.state, 'n_box', ctxAt(0))!.position;
    const p1 = resolveEvaluatedTransform(migrated.state, 'n_box', ctxAt(1))!.position;
    expect(p0[1]).toBe(0);
    expect(p1[1]).toBe(6); // the channel drives the Object's position
  });

  it('routes channels by paramPath: data params (size, material.*) → the data node, transform → the Object', () => {
    const migrated = loadFromBytes(buildV2FusedBoxJson());
    const data = splitDataNode(migrated, 'n_box')!;
    // A `size` channel addresses a param that now lives on the data node, so it
    // re-targets there — NOT orphaned onto the transform-only Object. (A
    // `material.*` channel takes the identical branch.) The §5/§9 no-orphan crux.
    expect((migrated.state.nodes.n_size.params as { target: string }).target).toBe(data.id);
    expect('size' in (data.params as object)).toBe(true); // the target actually owns `size`
    // A `position` channel addresses the transform → it stays on the inherited-id
    // Object (zero rewrite — the whole point of inheriting the box's id).
    expect((migrated.state.nodes.n_pos.params as { target: string }).target).toBe('n_box');
  });

  it('is idempotent — re-loading a split project is a stable no-op', () => {
    const once = loadFromBytes(buildV2FusedBoxJson());
    const twice = loadFromBytes(once);
    expect(twice.state.nodes.n_box).toEqual(once.state.nodes.n_box);
    expect(splitDataNode(twice, 'n_box')).toEqual(splitDataNode(once, 'n_box'));
    expect(Object.values(twice.state.nodes).some((n) => n.type === 'BoxMesh')).toBe(false);
  });
});

// ── object↔data split (#384 Stage C · C1): fused SphereMesh → Object + SphereData ──
// The per-kind repeat of the box split above, one format version later (v3 → v4). A
// formatVersion-2 project that carries BOTH a fused box and a fused sphere migrates in
// two sequential steps on load: 2→3 splits the box, 3→4 splits the sphere. The gate is
// the same — resolveEvaluatedMesh('<sphere id>') is byte-identical to the canonical
// split sphere, a `radius` channel re-targets to the fresh SphereData while a `position`
// channel stays on the inherited-id Object, and a fused box in the SAME fixture still
// splits correctly through the coexisting 2→3 pass (the CONTROL). Non-default geometry
// (radius 1.3, 32×20 segments) so a dropped param can't pass vacuously (H180).
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §5.

// The colour the FIXTURE's saved sphere recorded. It is authored into the fixture below
// (#394 D7) rather than left to the schema default: when the fixture omitted `material`,
// both the saved value AND the expectation came from the live schema, so the byte-identity
// assertion re-derived itself and could not fail when the default moved. The claim under
// test is that the migration PRESERVES what a save recorded — so the save must record it.
const SPHERE_MIG_SAVED_COLOR = '#88aaff';
const SPHERE_MIG_RADIUS = 1.3;
const SPHERE_MIG_WS = 32;
const SPHERE_MIG_HS = 20;

/** A genuinely FUSED scene — a fused SphereMesh (n_sphere) AND a fused BoxMesh (n_box,
 *  the control) wired into a Scene, camera + render attached. Both primitives are built
 *  by hand at their current node version so the split is the ONLY transformation under
 *  test. */
function buildFusedBoxSphereDagState(): DagState {
  let s = emptyDagState();
  const add = (op: Parameters<typeof applyOp>[1]) => {
    s = applyOp(s, op).next;
  };
  s = addRetiredNode(s, 'n_sphere', 'SphereMesh', 4, {
    radius: SPHERE_MIG_RADIUS,
    widthSegments: SPHERE_MIG_WS,
    heightSegments: SPHERE_MIG_HS,
    ...FUSED_TRS,
    // AUTHORED, like the box below — this is a saved project, and a saved project
    // records its colour. See SPHERE_MIG_SAVED_COLOR.
    material: fusedMaterial(SPHERE_MIG_SAVED_COLOR),
  });
  s = addRetiredNode(s, 'n_box', 'BoxMesh', 4, {
    size: [1, 1, 1],
    ...FUSED_TRS,
    material: fusedMaterial('#5af07a'),
  });
  s = addRetiredNode(
    s,
    'n_camera',
    'PerspectiveCamera',
    1,
    fusedPerspectiveCamera({ fov: 45, near: 0.01, far: 500, position: [3, 2, 3] }),
  );
  add({ type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} });
  add({
    type: 'addNode',
    nodeId: 'n_render',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'ACES', smaa: true } },
  });
  s = connectFromRetired(
    s,
    { node: 'n_sphere', socket: 'out' },
    { node: 'n_scene', socket: 'children' },
  );
  s = connectFromRetired(
    s,
    { node: 'n_box', socket: 'out' },
    { node: 'n_scene', socket: 'children' },
  );
  s = connectFromRetired(
    s,
    { node: 'n_camera', socket: 'out' },
    { node: 'n_scene', socket: 'camera' },
  );
  add({
    type: 'connect',
    from: { node: 'n_scene', socket: 'out' },
    to: { node: 'n_render', socket: 'scene' },
  });
  return {
    ...s,
    outputs: {
      scene: { node: 'n_scene', socket: 'out' },
      render: { node: 'n_render', socket: 'out' },
    },
  };
}

/** A serialized formatVersion-2 project: the fused box+sphere scene + a `radius` channel
 *  and a `position` channel targeting the sphere + a `size` channel targeting the box
 *  (the control), then stamped formatVersion 2. */
function buildV2FusedBoxSphereJson() {
  let s = buildFusedBoxSphereDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_radius',
    nodeType: 'KeyframeChannelNumber',
    params: {
      name: 'radius',
      target: 'n_sphere',
      paramPath: 'radius',
      keyframes: [
        { time: 0, value: SPHERE_MIG_RADIUS, easing: 'linear' },
        { time: 1, value: 2.6, easing: 'linear' },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_pos',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: 'n_sphere',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 1, value: [0, 6, 0], easing: 'linear' },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_size',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'size',
      target: 'n_box',
      paramPath: 'size',
      keyframes: [
        { time: 0, value: [1, 1, 1], easing: 'linear' },
        { time: 1, value: [2, 2, 2], easing: 'linear' },
      ],
    },
  }).next;
  const nodes = JSON.parse(JSON.stringify(s.nodes));
  return {
    formatVersion: 2,
    id: 'p384-sphere-split',
    name: 'pre-split box+sphere',
    createdAt: 0,
    updatedAt: 0,
    nodeVersions: {
      SphereMesh: nodes.n_sphere.version,
      BoxMesh: nodes.n_box.version,
      KeyframeChannelNumber: nodes.n_radius.version,
      KeyframeChannelVec3: nodes.n_pos.version,
    },
    state: { nodes, outputs: s.outputs },
  };
}

/** The SphereData node a split produced from the sphere `sphereId`. */
function splitSphereDataNode(project: Project, sphereId: string) {
  return Object.values(project.state.nodes).find(
    (n) => n.type === 'SphereData' && n.id.startsWith(`${sphereId}__data`),
  );
}

describe('object↔data split v3 → v4: fused SphereMesh → Object + SphereData (#384)', () => {
  it('splits the sphere: n_sphere becomes an Object (id inherited) + a wired SphereData', () => {
    const migrated = loadFromBytes(buildV2FusedBoxSphereJson());
    // 2 → 3 (box split) → 4 (sphere split) → 5 (curve pass) → 6 (light pass, no
    // lights) → 7 (camera split — this fixture HAS a camera) → 8 (baked pass, none).
    expect(migrated.formatVersion).toBe(9);
    // The sphere node keeps its id but is now an Object owning only the transform.
    const obj = migrated.state.nodes.n_sphere;
    expect(obj.type).toBe('Object');
    const op = obj.params as Record<string, unknown>;
    expect(op.position).toEqual([0, 0, 0]);
    expect(op.scale).toEqual([1, 1, 1]);
    expect(op.radius).toBeUndefined(); // geometry left the Object
    expect(op.material).toBeUndefined(); // material left the Object
    // A fresh SphereData owns the geometry + material and nothing else.
    const data = splitSphereDataNode(migrated, 'n_sphere');
    expect(data).toBeDefined();
    const dp = data!.params as Record<string, unknown>;
    expect(dp.radius).toBe(SPHERE_MIG_RADIUS);
    expect(dp.widthSegments).toBe(SPHERE_MIG_WS);
    expect(dp.heightSegments).toBe(SPHERE_MIG_HS);
    expect(dp.material).toBeDefined();
    // The Object points at the data node through `data`.
    const dataRef = (obj.inputs as Record<string, { node: string }>).data;
    expect(dataRef.node).toBe(data!.id);
  });

  it('renders byte-identically to the canonical split sphere (the split is invisible)', () => {
    const migrated = loadFromBytes(buildV2FusedBoxSphereJson());
    const split = resolveEvaluatedMesh(migrated.state, 'n_sphere', ctxAt(0));
    expect(split).not.toBeNull();
    // The geometry handle the renderer builds from is the canonical sphere handle —
    // Slice-4-durable: it compares against sphereGeometryRef, not a live fused resolve.
    const canonical = sphereGeometryRef(SPHERE_MIG_RADIUS, SPHERE_MIG_WS, SPHERE_MIG_HS, null);
    expect(split!.geometry.descriptor).toEqual(canonical.descriptor);
    // The saved colour survives the migration untouched — the literal, so this can fail.
    expect((primaryMaterial(split!.materials) as InlineMaterialSpec).base.color).toBe(
      SPHERE_MIG_SAVED_COLOR,
    );
    // …and the rest of the IR is the canonical hydrated OpenPBR default.
    const expectedMaterial = hydrateInlineMaterial({
      ...openpbrMaterialSchema().parse(undefined),
      base: { color: SPHERE_MIG_SAVED_COLOR, metalness: 0 },
    });
    expect(primaryMaterial(split!.materials)).toEqual(expectedMaterial);
    expect(split!.transform.position).toEqual([0, 0, 0]);
    expect(split!.transform.scale).toEqual([1, 1, 1]);
  });

  it('the Object inherits the id, so a position channel still animates it', () => {
    const migrated = loadFromBytes(buildV2FusedBoxSphereJson());
    // The position channel still targets n_sphere (now the Object) — unchanged.
    expect((migrated.state.nodes.n_pos.params as { target: string }).target).toBe('n_sphere');
    const p0 = resolveEvaluatedTransform(migrated.state, 'n_sphere', ctxAt(0))!.position;
    const p1 = resolveEvaluatedTransform(migrated.state, 'n_sphere', ctxAt(1))!.position;
    expect(p0[1]).toBe(0);
    expect(p1[1]).toBe(6); // the channel drives the Object's position
  });

  it('routes channels by paramPath: radius → the SphereData, position → the Object', () => {
    const migrated = loadFromBytes(buildV2FusedBoxSphereJson());
    const data = splitSphereDataNode(migrated, 'n_sphere')!;
    // A `radius` channel addresses a param that now lives on the data node, so it
    // re-targets there — NOT orphaned onto the transform-only Object. The §5/§9 no-orphan
    // crux, and the specific arm this slice added to isDataParamPath.
    expect((migrated.state.nodes.n_radius.params as { target: string }).target).toBe(data.id);
    expect('radius' in (data.params as object)).toBe(true); // the target actually owns `radius`
    // A `position` channel addresses the transform → it stays on the inherited-id Object.
    expect((migrated.state.nodes.n_pos.params as { target: string }).target).toBe('n_sphere');
  });

  it('CONTROL: a fused box in the same fixture still splits through the coexisting 2→3 pass', () => {
    const migrated = loadFromBytes(buildV2FusedBoxSphereJson());
    // The box also became an Object + BoxData (proves the v2→v3 arm is untouched).
    const boxObj = migrated.state.nodes.n_box;
    expect(boxObj.type).toBe('Object');
    const boxData = Object.values(migrated.state.nodes).find(
      (n) => n.type === 'BoxData' && n.id.startsWith('n_box__data'),
    );
    expect(boxData).toBeDefined();
    // Its `size` channel re-targeted to the BoxData (box arm of isDataParamPath intact).
    expect((migrated.state.nodes.n_size.params as { target: string }).target).toBe(boxData!.id);
  });

  it('is idempotent — re-loading a split project is a stable no-op', () => {
    const once = loadFromBytes(buildV2FusedBoxSphereJson());
    const twice = loadFromBytes(once);
    expect(twice.state.nodes.n_sphere).toEqual(once.state.nodes.n_sphere);
    expect(splitSphereDataNode(twice, 'n_sphere')).toEqual(splitSphereDataNode(once, 'n_sphere'));
    // No fused primitive of either kind survives.
    expect(Object.values(twice.state.nodes).some((n) => n.type === 'SphereMesh')).toBe(false);
    expect(Object.values(twice.state.nodes).some((n) => n.type === 'BoxMesh')).toBe(false);
  });
});

// ── object↔data split (#385 Stage C · C2): fused Curve → Object + CurveData ──
// The per-kind repeat for the FIRST non-mesh data, one format version later (v4→v5).
// The SAME combined fused scene (box + sphere) is the live CONTROL: a v2 project
// carrying a fused box, sphere AND curve migrates in FOUR sequential steps on load
// (2→3 box, 3→4 sphere, 4→5 curve). The gate: the split curve's evaluated CurveData
// draws the CANONICAL sampleCurve polyline (Slice-4-durable — compared against
// sampleCurve, not a live fused resolve), a `resolution` channel re-targets to the
// fresh CurveData while a `position` channel stays on the inherited-id Object, the
// box + sphere in the SAME fixture still split (the CONTROLS), and a v1 bare-Vec3
// curve is normalized through Curve's node ladder to {id,co} BEFORE the split (the
// stable point ids the selection + #326 fix depend on). Non-default points +
// resolution 8 so a dropped param can't pass vacuously (H180/H177).
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §5; K23; issue #385.

const CURVE_MIG_ENTRIES = [
  { id: 'cp0', co: [1.3, 0.4, -0.7] as Vec3 },
  { id: 'cp1', co: [-0.9, 1.1, 2.2] as Vec3 },
  { id: 'cp2', co: [3.1, -0.5, 0.8] as Vec3 },
];
const CURVE_MIG_COS: Vec3[] = CURVE_MIG_ENTRIES.map((e) => e.co);
const CURVE_MIG_RESOLUTION = 8;

/** The fused box+sphere scene (both CONTROLS) + a fused Curve (non-default points +
 *  resolution) + a `resolution` channel (data-param) and a `position` channel
 *  (transform) targeting the curve, then stamped formatVersion 2. The curve is built
 *  at its current node version (v2, id'd points) so applyOp validates it; the v1→v2
 *  node normalize inside the split is proven separately below. */
function buildV2FusedBoxSphereCurveJson() {
  let s = buildFusedBoxSphereDagState();
  const add = (op: Parameters<typeof applyOp>[1]) => {
    s = applyOp(s, op).next;
  };
  s = addRetiredNode(s, 'n_curve', 'Curve', 2, {
    position: [2, 0, -1],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    points: CURVE_MIG_ENTRIES,
    closed: false,
    resolution: CURVE_MIG_RESOLUTION,
  });
  s = connectFromRetired(
    s,
    { node: 'n_curve', socket: 'out' },
    { node: 'n_scene', socket: 'children' },
  );
  add({
    type: 'addNode',
    nodeId: 'n_res',
    nodeType: 'KeyframeChannelNumber',
    params: {
      name: 'resolution',
      target: 'n_curve',
      paramPath: 'resolution',
      keyframes: [
        { time: 0, value: CURVE_MIG_RESOLUTION, easing: 'linear' },
        { time: 1, value: 24, easing: 'linear' },
      ],
    },
  });
  add({
    type: 'addNode',
    nodeId: 'n_cpos',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: 'n_curve',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [2, 0, -1], easing: 'linear' },
        { time: 1, value: [2, 5, -1], easing: 'linear' },
      ],
    },
  });
  const nodes = JSON.parse(JSON.stringify(s.nodes));
  return {
    formatVersion: 2,
    id: 'p385-curve-split',
    name: 'pre-split box+sphere+curve',
    createdAt: 0,
    updatedAt: 0,
    nodeVersions: {
      Curve: nodes.n_curve.version,
      SphereMesh: nodes.n_sphere.version,
      BoxMesh: nodes.n_box.version,
    },
    state: { nodes, outputs: s.outputs },
  };
}

/** The CurveData node a split produced from the curve `curveId`. */
function splitCurveDataNode(project: Project, curveId: string) {
  return Object.values(project.state.nodes).find(
    (n) => n.type === 'CurveData' && n.id.startsWith(`${curveId}__data`),
  );
}

describe('object↔data split v4 → v5: fused Curve → Object + CurveData (#385)', () => {
  it('splits the curve: n_curve becomes an Object (id inherited) + a wired CurveData', () => {
    const migrated = loadFromBytes(buildV2FusedBoxSphereCurveJson());
    // 2 → 3 (box) → 4 (sphere) → 5 (curve) → 6 (light pass, no lights) → 7 (camera)
    // → 8 (baked pass, no baked meshes).
    expect(migrated.formatVersion).toBe(9);
    const obj = migrated.state.nodes.n_curve;
    expect(obj.type).toBe('Object');
    const op = obj.params as Record<string, unknown>;
    expect(op.position).toEqual([2, 0, -1]);
    expect(op.scale).toEqual([1, 1, 1]);
    expect(op.points).toBeUndefined(); // geometry left the Object
    expect(op.resolution).toBeUndefined();
    expect(op.closed).toBeUndefined();
    // A fresh CurveData owns points/closed/resolution and nothing else (no material —
    // a curve is not render geometry).
    const data = splitCurveDataNode(migrated, 'n_curve')!;
    expect(data).toBeDefined();
    const dp = data.params as Record<string, unknown>;
    expect(dp.points).toEqual(CURVE_MIG_ENTRIES);
    expect(dp.resolution).toBe(CURVE_MIG_RESOLUTION);
    expect(dp.closed).toBe(false);
    expect('material' in dp).toBe(false);
    // The Object points at the data node through `data`.
    const dataRef = (obj.inputs as Record<string, { node: string }>).data;
    expect(dataRef.node).toBe(data.id);
  });

  it('draws the CANONICAL sampleCurve polyline (the split is invisible)', () => {
    const migrated = loadFromBytes(buildV2FusedBoxSphereCurveJson());
    const data = splitCurveDataNode(migrated, 'n_curve')!;
    const value = evaluate(migrated.state, data.id).value as CurveDataValue;
    expect(value.kind).toBe('CurveData');
    // The polyline the renderer draws is the canonical sampler over the migrated
    // points — compared against sampleCurve, NOT a live fused resolve (Slice-4-durable).
    expect(value.points).toEqual(CURVE_MIG_COS);
    expect(value.closed).toBe(false);
    expect(value.samples).toEqual(sampleCurve(CURVE_MIG_COS, false, CURVE_MIG_RESOLUTION));
  });

  it('the Object inherits the id, so a position channel still animates it', () => {
    const migrated = loadFromBytes(buildV2FusedBoxSphereCurveJson());
    // The position channel still targets n_curve (now the Object) — unchanged.
    expect((migrated.state.nodes.n_cpos.params as { target: string }).target).toBe('n_curve');
    const p0 = resolveEvaluatedTransform(migrated.state, 'n_curve', ctxAt(0))!.position;
    const p1 = resolveEvaluatedTransform(migrated.state, 'n_curve', ctxAt(1))!.position;
    expect(p0[1]).toBe(0);
    expect(p1[1]).toBe(5); // the channel drives the Object's position
  });

  it('routes channels by paramPath: resolution → the CurveData, position → the Object', () => {
    const migrated = loadFromBytes(buildV2FusedBoxSphereCurveJson());
    const data = splitCurveDataNode(migrated, 'n_curve')!;
    // A `resolution` channel addresses a param that now lives on the data node, so it
    // re-targets there — NOT orphaned onto the transform-only Object (the arm this
    // slice added to isDataParamPath).
    expect((migrated.state.nodes.n_res.params as { target: string }).target).toBe(data.id);
    expect('resolution' in (data.params as object)).toBe(true);
    // A `position` channel addresses the transform → it stays on the inherited-id Object.
    expect((migrated.state.nodes.n_cpos.params as { target: string }).target).toBe('n_curve');
  });

  it('CONTROLS: the box AND sphere in the same fixture still split (2→3, 3→4 intact)', () => {
    const migrated = loadFromBytes(buildV2FusedBoxSphereCurveJson());
    expect(migrated.state.nodes.n_box.type).toBe('Object');
    expect(migrated.state.nodes.n_sphere.type).toBe('Object');
    expect(Object.values(migrated.state.nodes).some((n) => n.type === 'BoxData')).toBe(true);
    expect(Object.values(migrated.state.nodes).some((n) => n.type === 'SphereData')).toBe(true);
  });

  it('normalizes a v1 bare-Vec3 curve through the node ladder BEFORE splitting', () => {
    // A hand-written formatVersion-2 project with a version-1 Curve carrying BARE Vec3
    // points (the pre-#453 shape applyOp would reject). The split must run Curve's own
    // v1→v2 migration first, so the CurveData ends with {id,co} points (cp0..).
    const v1Curve = {
      formatVersion: 2,
      id: 'p385-v1-curve-normalize',
      name: 'pre-id fused curve',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: { Curve: 1 },
      state: {
        nodes: {
          n_curve: {
            id: 'n_curve',
            type: 'Curve',
            version: 1,
            params: {
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
              points: [
                [1.3, 0.4, -0.7],
                [-0.9, 1.1, 2.2],
                [3.1, -0.5, 0.8],
              ],
              closed: false,
              resolution: CURVE_MIG_RESOLUTION,
            },
            inputs: {},
          },
        },
        outputs: {},
      },
    };
    const migrated = loadFromBytes(v1Curve);
    expect(migrated.state.nodes.n_curve.type).toBe('Object');
    const data = splitCurveDataNode(migrated, 'n_curve')!;
    expect((data.params as { points: unknown }).points).toEqual(CURVE_MIG_ENTRIES);
  });

  it('is idempotent — re-loading a split project is a stable no-op', () => {
    const once = loadFromBytes(buildV2FusedBoxSphereCurveJson());
    const twice = loadFromBytes(once);
    expect(twice.state.nodes.n_curve).toEqual(once.state.nodes.n_curve);
    expect(splitCurveDataNode(twice, 'n_curve')).toEqual(splitCurveDataNode(once, 'n_curve'));
    // No fused primitive of any kind survives.
    expect(Object.values(twice.state.nodes).some((n) => n.type === 'Curve')).toBe(false);
    expect(Object.values(twice.state.nodes).some((n) => n.type === 'SphereMesh')).toBe(false);
    expect(Object.values(twice.state.nodes).some((n) => n.type === 'BoxMesh')).toBe(false);
  });
});

// ── v5 → v6: fused posable lights → Object + LightData (#386) ──────────────────
// The per-kind mirror of the box/sphere/curve splits, for the SECOND non-mesh data
// and the FIRST PARTIAL retirement (AmbientLight stays fused). Proves per-kind
// byte-identity against the canonical split shape, per-kind hydrate from the SOURCE
// schema defaults, the SUPERSET range (an intensity:50 area light survives), the
// ambient-skip, shading-channel re-targeting, and coexistence with the earlier passes.
// NON-DEFAULT shading on purpose (H177): a dropped field would otherwise read the
// schema default and the golden would pass vacuously.

/** The fused posable lights (non-default shading), an AmbientLight (skip control), and
 *  an intensity + a position channel on the point light, stamped formatVersion 5 so
 *  ONLY the light pass runs (the box/sphere/curve controls live in the mixed fixture). */
function buildFusedLightsJson() {
  let s = emptyDagState();
  const add = (op: Parameters<typeof applyOp>[1]) => {
    s = applyOp(s, op).next;
  };
  s = addRetiredNode(s, 'n_dir', 'DirectionalLight', 1, {
    ...FUSED_TRS,
    intensity: 3.7,
    color: '#ffee00',
    position: [1, 2, 3],
    rotation: [0.1, 0, 0],
  });
  s = addRetiredNode(s, 'n_point', 'PointLight', 1, {
    ...FUSED_TRS,
    intensity: 4.2,
    color: '#00ff88',
    position: [4, 5, 6],
    distance: 12,
    decay: 1.5,
  });
  s = addRetiredNode(s, 'n_spot', 'SpotLight', 1, {
    ...FUSED_TRS,
    intensity: 5.5,
    color: '#ff00aa',
    position: [7, 8, 9],
    target: [1, 1, 1],
    angle: 0.5,
    penumbra: 0.45,
    distance: 8,
    decay: 3,
  });
  s = addRetiredNode(s, 'n_area', 'AreaLight', 1, {
    ...FUSED_TRS,
    intensity: 6.5,
    color: '#0088ff',
    position: [1, 0, 1],
    width: 3.25,
    height: 4.75,
    lookAt: [2, 2, 2],
    tex: 'assets/hdri.exr',
  });
  add({ type: 'addNode', nodeId: 'n_amb', nodeType: 'AmbientLight', params: { intensity: 0.7 } });
  add({
    type: 'addNode',
    nodeId: 'n_lint',
    nodeType: 'KeyframeChannelNumber',
    params: {
      name: 'intensity',
      target: 'n_point',
      paramPath: 'intensity',
      keyframes: [
        { time: 0, value: 4.2, easing: 'linear' },
        { time: 1, value: 9.9, easing: 'linear' },
      ],
    },
  });
  add({
    type: 'addNode',
    nodeId: 'n_lpos',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: 'n_point',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [4, 5, 6], easing: 'linear' },
        { time: 1, value: [4, 9, 6], easing: 'linear' },
      ],
    },
  });
  const nodes = JSON.parse(JSON.stringify(s.nodes));
  return {
    formatVersion: 5,
    id: 'p386-light-split',
    name: 'pre-split posable lights',
    createdAt: 0,
    updatedAt: 0,
    nodeVersions: {
      DirectionalLight: nodes.n_dir.version,
      PointLight: nodes.n_point.version,
      SpotLight: nodes.n_spot.version,
      AreaLight: nodes.n_area.version,
      AmbientLight: nodes.n_amb.version,
    },
    state: { nodes, outputs: s.outputs },
  };
}

/** The LightData node a split produced from the light `lightId`. */
function splitLightDataNode(project: Project, lightId: string) {
  return Object.values(project.state.nodes).find(
    (n) => n.type === 'LightData' && n.id.startsWith(`${lightId}__data`),
  );
}

describe('object↔data split v5 → v6: fused posable lights → Object + LightData (#386)', () => {
  it('splits each posable kind byte-identically: the Object inherits the id, the LightData owns the shading', () => {
    const m = loadFromBytes(buildFusedLightsJson());
    // 5 → 6 (light pass) → 7 (camera pass) → 8 (baked pass); this fixture has
    // neither a camera nor a baked mesh, so the last two steps are no-ops.
    expect(m.formatVersion).toBe(9);

    // Directional → Object(pose) + LightData{lightKind, intensity, color}.
    const dir = m.state.nodes.n_dir;
    expect(dir.type).toBe('Object');
    expect(dir.params).toEqual({ position: [1, 2, 3], rotation: [0.1, 0, 0], scale: [1, 1, 1] });
    const dirData = splitLightDataNode(m, 'n_dir')!;
    expect(dirData.params).toEqual({ lightKind: 'Directional', intensity: 3.7, color: '#ffee00' });
    expect((dir.inputs as Record<string, { node: string }>).data.node).toBe(dirData.id);

    // Point → +distance, decay.
    const pointData = splitLightDataNode(m, 'n_point')!;
    expect(pointData.params).toEqual({
      lightKind: 'Point',
      intensity: 4.2,
      color: '#00ff88',
      distance: 12,
      decay: 1.5,
    });

    // Spot → +target, angle, penumbra, distance, decay (the cone).
    const spotData = splitLightDataNode(m, 'n_spot')!;
    expect(spotData.params).toEqual({
      lightKind: 'Spot',
      intensity: 5.5,
      color: '#ff00aa',
      target: [1, 1, 1],
      angle: 0.5,
      penumbra: 0.45,
      distance: 8,
      decay: 3,
    });

    // Area → +width, height, lookAt, tex.
    const areaData = splitLightDataNode(m, 'n_area')!;
    expect(areaData.params).toEqual({
      lightKind: 'Area',
      intensity: 6.5,
      color: '#0088ff',
      width: 3.25,
      height: 4.75,
      lookAt: [2, 2, 2],
      tex: 'assets/hdri.exr',
    });
  });

  it('AmbientLight is SKIPPED — it stays fused with no Object and no data input (partial retirement)', () => {
    const m = loadFromBytes(buildFusedLightsJson());
    const amb = m.state.nodes.n_amb;
    expect(amb.type).toBe('AmbientLight');
    expect('data' in (amb.inputs ?? {})).toBe(false);
    // No LightData was minted from the ambient (only the four posable kinds split).
    expect(splitLightDataNode(m, 'n_amb')).toBeUndefined();
  });

  it('routes channels by paramPath: intensity → the LightData, position → the inherited-id Object', () => {
    const m = loadFromBytes(buildFusedLightsJson());
    const data = splitLightDataNode(m, 'n_point')!;
    // A shading (`intensity`) channel re-targets to the fresh LightData.
    expect((m.state.nodes.n_lint.params as { target: string }).target).toBe(data.id);
    // A `position` channel addresses the transform → stays on the inherited-id Object.
    expect((m.state.nodes.n_lpos.params as { target: string }).target).toBe('n_point');
  });

  it('hydrates a missing shading field from the SOURCE kind default (area intensity → 5, not LightData 1)', () => {
    // A hand-written area light with NO stored intensity. The migration must carry
    // AreaLight's OWN default (5), NOT LightData's collapsed default (1).
    const noIntensity = {
      formatVersion: 5,
      id: 'p386-area-hydrate',
      name: 'area light without intensity',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: { AreaLight: 1 },
      state: {
        nodes: {
          n_area: {
            id: 'n_area',
            type: 'AreaLight',
            version: 1,
            params: { position: [0, 5, 0], width: 2, height: 2 },
            inputs: {},
          },
        },
        outputs: {},
      },
    };
    const m = loadFromBytes(noIntensity);
    const data = splitLightDataNode(m, 'n_area')!;
    expect((data.params as { intensity: number }).intensity).toBe(5);
  });

  it('SUPERSET range: an intensity:50 area light migrates AND re-parses (a collapsed max(20) would reject it)', () => {
    const hot = {
      formatVersion: 5,
      id: 'p386-area-hot',
      name: 'intensity 50 area light',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: { AreaLight: 1 },
      state: {
        nodes: {
          n_area: {
            id: 'n_area',
            type: 'AreaLight',
            version: 1,
            params: { intensity: 50, position: [0, 5, 0], width: 2, height: 2 },
            inputs: {},
          },
        },
        outputs: {},
      },
    };
    // loadFromBytes runs ProjectSchema.parse — a value above the collapsed range would
    // throw here (silent node loss). It survives because LightData.intensity is max(100).
    const m = loadFromBytes(hot);
    const data = splitLightDataNode(m, 'n_area')!;
    expect((data.params as { intensity: number }).intensity).toBe(50);
  });

  it('is idempotent — re-loading a split project is a stable no-op', () => {
    const once = loadFromBytes(buildFusedLightsJson());
    const twice = loadFromBytes(once);
    for (const id of ['n_dir', 'n_point', 'n_spot', 'n_area', 'n_amb']) {
      expect(twice.state.nodes[id]).toEqual(once.state.nodes[id]);
    }
    expect(splitLightDataNode(twice, 'n_point')).toEqual(splitLightDataNode(once, 'n_point'));
    // No fused POSABLE light survives; the ambient does.
    for (const t of ['DirectionalLight', 'PointLight', 'SpotLight', 'AreaLight']) {
      expect(Object.values(twice.state.nodes).some((n) => n.type === t)).toBe(false);
    }
    expect(Object.values(twice.state.nodes).some((n) => n.type === 'AmbientLight')).toBe(true);
  });

  it('CONTROLS: a fused CURVE still splits (v4→v5) and a mesh material colour channel still re-targets (v2→v3) alongside the light pass', () => {
    // A mixed formatVersion-2 scene: a box with a material-colour channel (control b),
    // a curve (control a), and a point light — proving all four passes coexist.
    let s = emptyDagState();
    const add = (op: Parameters<typeof applyOp>[1]) => {
      s = applyOp(s, op).next;
    };
    s = addRetiredNode(s, 'n_box', 'BoxMesh', 4, {
      size: [1, 1, 1],
      ...FUSED_TRS,
      material: openpbrMaterialSchema().parse({ name: 'm', base: { color: '#123456' } }),
    });
    s = addRetiredNode(
      s,
      'n_curve',
      'Curve',
      2,
      fusedCurve({
        points: [
          { id: 'cp0', co: [0, 0, 0] },
          { id: 'cp1', co: [1, 1, 1] },
        ],
      }),
    );
    s = addRetiredNode(s, 'n_point', 'PointLight', 1, {
      ...FUSED_TRS,
      intensity: 2.2,
      position: [0, 3, 0],
      color: '#ffffff',
      distance: 0,
      decay: 2,
    });
    add({
      type: 'addNode',
      nodeId: 'n_col',
      nodeType: 'KeyframeChannelColor',
      params: {
        name: 'color',
        target: 'n_box',
        paramPath: 'material.base.color',
        keyframes: [
          { time: 0, value: '#123456', easing: 'linear' },
          { time: 1, value: '#654321', easing: 'linear' },
        ],
      },
    });
    const nodes = JSON.parse(JSON.stringify(s.nodes));
    const mixed = {
      formatVersion: 2,
      id: 'p386-mixed',
      name: 'box+curve+light',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: {
        BoxMesh: nodes.n_box.version,
        Curve: nodes.n_curve.version,
        PointLight: nodes.n_point.version,
      },
      state: { nodes, outputs: s.outputs },
    };
    const m = loadFromBytes(mixed);
    expect(m.formatVersion).toBe(9);
    // Control a — the curve split.
    expect(m.state.nodes.n_curve.type).toBe('Object');
    expect(Object.values(m.state.nodes).some((n) => n.type === 'CurveData')).toBe(true);
    // Control b — the box split AND its material colour channel re-targeted to the BoxData.
    expect(m.state.nodes.n_box.type).toBe('Object');
    const boxData = Object.values(m.state.nodes).find(
      (n) => n.type === 'BoxData' && n.id.startsWith('n_box__data'),
    )!;
    expect((m.state.nodes.n_col.params as { target: string }).target).toBe(boxData.id);
    // And the light split alongside them.
    expect(m.state.nodes.n_point.type).toBe('Object');
    expect(splitLightDataNode(m, 'n_point')).toBeDefined();
  });
});

// ── object↔data split (#387 Stage C · C4): fused cameras → Object + CameraData ──
// The per-kind repeat for the THIRD non-mesh data, one format version after the
// light's (v6→v7). Two fused camera NODES collapse into ONE CameraData carrying a
// `projection` discriminator, the way four light nodes collapsed into `lightKind`.
//
// ⚠️ EVERY FIXTURE VALUE BELOW IS DELIBERATELY OFF THE DEFAULTS, and for this kind
// that is load-bearing rather than hygiene. `DEFAULT_CAMERA_POSE` is what the pose
// road returns when a read FAILS — and the default project is framed at exactly
// `fov: 45, position: [3,2,3], lookAt: [0,0,0]`, so a COMPLETELY broken split would
// still resolve to those numbers and pass. fov 28 / position [7,1,-4] /
// lookAt [1,2,3] / roll 12 / far 250 each differ from both the schema default and
// the pose fallback (H177/V15).
//
// The gate that matters: a channel's `params.target` is asserted PER HALF and
// DIRECTLY, not only through the resolved pose. Post-split the resolver reads BOTH
// halves, so a channel re-targeted to the wrong half still resolves correctly today
// and the pose cannot tell you — the assertion has to name the id.
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §5; K23; issue #387.

const CAM_PERSP_FOV = 28;
const CAM_POSITION: Vec3 = [7, 1, -4];
const CAM_LOOKAT: Vec3 = [1, 2, 3];
const CAM_ROLL = 12;
const CAM_FAR = 250;

/** A v6 project with a fused PERSPECTIVE camera (non-default lens + aim) and a fused
 *  ORTHOGRAPHIC one, plus two channels on the perspective camera: `fov` (a lens param
 *  → must follow the CameraData) and `position` (a transform → must stay on the
 *  inherited-id Object). */
function buildFusedCamerasJson() {
  let s = emptyDagState();
  const add = (op: Parameters<typeof applyOp>[1]) => {
    s = applyOp(s, op).next;
  };
  s = addRetiredNode(s, 'n_persp', 'PerspectiveCamera', 1, {
    fov: CAM_PERSP_FOV,
    near: 0.05,
    far: CAM_FAR,
    sensorSize: 24,
    dofEnabled: true,
    focusDistance: 7.5,
    fStop: 1.4,
    focusOnTarget: true,
    position: CAM_POSITION,
    lookAt: CAM_LOOKAT,
    roll: CAM_ROLL,
  });
  s = addRetiredNode(s, 'n_ortho', 'OrthographicCamera', 1, {
    zoom: 33,
    near: 0.02,
    far: CAM_FAR,
    position: [-2, 6, 9],
    lookAt: CAM_LOOKAT,
    roll: CAM_ROLL,
  });
  // A Scene consuming the perspective camera. This is the POINT of id inheritance:
  // the edge names `n_persp` and must still name it after the split, with no
  // re-pointing pass anywhere in the migration.
  add({ type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} });
  s = connectFromRetired(
    s,
    { node: 'n_persp', socket: 'out' },
    { node: 'n_scene', socket: 'camera' },
  );
  add({
    type: 'addNode',
    nodeId: 'n_fov',
    nodeType: 'KeyframeChannelNumber',
    params: {
      name: 'fov',
      target: 'n_persp',
      paramPath: 'fov',
      keyframes: [
        { time: 0, value: CAM_PERSP_FOV, easing: 'linear' },
        { time: 1, value: 85, easing: 'linear' },
      ],
    },
  });
  add({
    type: 'addNode',
    nodeId: 'n_campos',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: 'n_persp',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: CAM_POSITION, easing: 'linear' },
        { time: 1, value: [7, 9, -4], easing: 'linear' },
      ],
    },
  });
  const nodes = JSON.parse(JSON.stringify(s.nodes));
  return {
    formatVersion: 6,
    id: 'p387-camera-split',
    name: 'pre-split cameras',
    createdAt: 0,
    updatedAt: 0,
    nodeVersions: {
      PerspectiveCamera: nodes.n_persp.version,
      OrthographicCamera: nodes.n_ortho.version,
    },
    state: { nodes, outputs: s.outputs },
  };
}

/** The CameraData node a split produced from the camera `cameraId`. */
function splitCameraDataNode(project: Project, cameraId: string) {
  return Object.values(project.state.nodes).find(
    (n) => n.type === 'CameraData' && n.id.startsWith(`${cameraId}__data`),
  );
}

describe('object↔data split v6 → v7: fused cameras → Object + CameraData (#387)', () => {
  it('splits both projections: the Object inherits the id and the pose, the CameraData owns the lens', () => {
    const m = loadFromBytes(buildFusedCamerasJson());
    // 6 → 7 (camera split) → 8 (baked pass, no baked meshes); this fixture has no
    // box/sphere/curve/light either.
    expect(m.formatVersion).toBe(9);

    // Perspective → Object(pose only) + CameraData(the whole lens + the aim).
    const persp = m.state.nodes.n_persp;
    expect(persp.type).toBe('Object');
    // rotation/scale are IDENTITY literals: neither fused camera type has them, and
    // parity-first (D1) keeps aim on the data half, so the camera road never reads
    // the Object's rotation.
    expect(persp.params).toEqual({
      position: CAM_POSITION,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    const perspData = splitCameraDataNode(m, 'n_persp')!;
    expect(perspData.params).toEqual({
      projection: 'Perspective',
      fov: CAM_PERSP_FOV,
      near: 0.05,
      far: CAM_FAR,
      sensorSize: 24,
      dofEnabled: true,
      focusDistance: 7.5,
      fStop: 1.4,
      focusOnTarget: true,
      lookAt: CAM_LOOKAT,
      roll: CAM_ROLL,
    });
    expect((persp.inputs as Record<string, { node: string }>).data.node).toBe(perspData.id);

    // Orthographic → the same Object shape + a CameraData discriminated the other way.
    const ortho = m.state.nodes.n_ortho;
    expect(ortho.type).toBe('Object');
    expect(ortho.params).toEqual({ position: [-2, 6, 9], rotation: [0, 0, 0], scale: [1, 1, 1] });
    const orthoData = splitCameraDataNode(m, 'n_ortho')!;
    expect(orthoData.params).toEqual({
      projection: 'Orthographic',
      // D5 — the ONE invented value in this migration. An orthographic source never
      // had an fov and `CameraData.fov` is required; it is inert while the projection
      // is orthographic (the recompose reads `zoom`).
      fov: 45,
      zoom: 33,
      near: 0.02,
      far: CAM_FAR,
      lookAt: CAM_LOOKAT,
      roll: CAM_ROLL,
    });
    // The orthographic source has no DoF/sensor params at all, so the migration writes
    // none — CameraData's schema defaults them. Asserted as an absence because writing
    // perspective-only fields onto an ortho bag is the plausible wrong thing to do.
    expect('dofEnabled' in (orthoData.params as object)).toBe(false);
    expect('sensorSize' in (orthoData.params as object)).toBe(false);
  });

  it('the consumer edge needs NO re-pointing — scene.camera still names the inherited id', () => {
    // The whole reason the fused node is converted IN PLACE rather than replaced. The
    // migration contains no edge-rewriting pass at all for cameras; this is what makes
    // that correct, and it covers `CameraSelect.cameras` edges, constraint targets and
    // saved selections by the same mechanism.
    const m = loadFromBytes(buildFusedCamerasJson());
    const cam = (m.state.nodes.n_scene.inputs as Record<string, { node: string; socket: string }>)
      .camera;
    expect(cam.node).toBe('n_persp');
    // ...and what it now names is the Object half, which is where the pose lives.
    expect(m.state.nodes.n_persp.type).toBe('Object');
    // The data half is a NEW node the scene does not reference — it hangs off the
    // Object's `data` input only.
    const data = splitCameraDataNode(m, 'n_persp')!;
    expect(cam.node).not.toBe(data.id);
  });

  it('routes channels by paramPath — asserted on the TARGET ID per half, not on the resolved pose', () => {
    const m = loadFromBytes(buildFusedCamerasJson());
    const data = splitCameraDataNode(m, 'n_persp')!;
    // A lens (`fov`) channel re-targets to the fresh CameraData.
    expect((m.state.nodes.n_fov.params as { target: string }).target).toBe(data.id);
    // A `position` channel addresses the pose → stays on the inherited-id Object.
    expect((m.state.nodes.n_campos.params as { target: string }).target).toBe('n_persp');
    // WHY THE IDS AND NOT THE POSE: `resolveCameraPoseAt` gathers channels from BOTH
    // halves (slice 2), so a channel parked on the wrong half still animates the pose
    // correctly today and the resolved value cannot distinguish the two. The pose
    // assertion below is a real gate for the STATIC lens; only these two lines gate
    // the routing.
  });

  it('the migrated pair resolves to the canonical pose (byte-identity, vs a canonical value not a live fused resolve)', () => {
    const m = loadFromBytes(buildFusedCamerasJson());
    // Compared against a hand-written canonical CameraPose rather than a live resolve
    // of the fused node — slice 8 deletes the fused camera types, and a fixture that
    // compares against them dies with them (the sphere's shipped lesson).
    expect(resolveCameraPoseAt(m.state, 'n_persp', 0)).toEqual({
      kind: 'PerspectiveCamera',
      position: CAM_POSITION,
      lookAt: CAM_LOOKAT,
      fov: CAM_PERSP_FOV,
      near: 0.05,
      far: CAM_FAR,
      roll: CAM_ROLL,
    });
    // The orthographic half keeps its own discriminator through the split.
    expect(resolveCameraPoseAt(m.state, 'n_ortho', 0).kind).toBe('OrthographicCamera');
    // Not a degenerate all-default fixture: every asserted value differs from the
    // pose fallback a broken road would return.
    expect(DEFAULT_CAMERA_POSE.fov).not.toBe(CAM_PERSP_FOV);
    expect(DEFAULT_CAMERA_POSE.position).not.toEqual(CAM_POSITION);
  });

  it('carries a MISSING perspective fov faithfully — it does NOT invent the 45 the pose road falls back to', () => {
    // A hand-edited perspective camera with no stored fov. The fused schema's `fov`
    // is required so a real save always carries one; the point is the DECISION, which
    // CameraData.ts states: 45 is `DEFAULT_CAMERA_POSE.fov`, so hydrating it here would
    // make "the fov never arrived" indistinguishable from "framed at 45°" one layer
    // below where anyone would look. The absence stays loud instead (H177).
    const noFov = {
      formatVersion: 6,
      id: 'p387-nofov',
      name: 'perspective camera without fov',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: { PerspectiveCamera: 1 },
      state: {
        nodes: {
          n_persp: {
            id: 'n_persp',
            type: 'PerspectiveCamera',
            version: 1,
            params: { position: CAM_POSITION, lookAt: CAM_LOOKAT },
            inputs: {},
          },
        },
        outputs: {},
      },
    };
    const data = splitCameraDataNode(loadFromBytes(noFov), 'n_persp')!;
    expect('fov' in (data.params as object)).toBe(false);
    expect((data.params as { fov?: number }).fov).not.toBe(45);
  });

  it('is idempotent — re-loading a split project is a stable no-op', () => {
    const once = loadFromBytes(buildFusedCamerasJson());
    const twice = loadFromBytes(once);
    for (const id of ['n_persp', 'n_ortho', 'n_fov', 'n_campos']) {
      expect(twice.state.nodes[id]).toEqual(once.state.nodes[id]);
    }
    expect(splitCameraDataNode(twice, 'n_persp')).toEqual(splitCameraDataNode(once, 'n_persp'));
    // No fused camera survives.
    for (const t of ['PerspectiveCamera', 'OrthographicCamera']) {
      expect(Object.values(twice.state.nodes).some((n) => n.type === t)).toBe(false);
    }
  });

  it('COLLISION GATE: the camera pass moves a channel only when its TARGET is a camera', () => {
    // `fov` and ten siblings joined the shared `isDataParamPath` predicate in this
    // pass, and that predicate is consulted by ALL FIVE passes. What keeps a name safe
    // is NOT the name — it is that each pass gates on its OWN id map. Stamped at v6 so
    // only the camera pass runs: with no camera in the file the id map is empty and the
    // re-target loop never executes, so a `fov` channel on a non-camera is untouched.
    const strayOnNonCamera = {
      formatVersion: 6,
      id: 'p387-collision',
      name: 'stray fov channel on a non-camera',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: { KeyframeChannelNumber: 2 },
      state: {
        nodes: {
          n_obj: {
            id: 'n_obj',
            type: 'Object',
            version: 1,
            params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            inputs: {},
          },
          n_stray: {
            id: 'n_stray',
            type: 'KeyframeChannelNumber',
            version: 2,
            params: {
              name: 'fov',
              target: 'n_obj',
              paramPath: 'fov',
              keyframes: [
                { time: 0, value: 10, easing: 'linear' },
                { time: 1, value: 20, easing: 'linear' },
              ],
            },
            inputs: {},
          },
        },
        outputs: {},
      },
    };
    const m = loadFromBytes(strayOnNonCamera);
    expect(m.formatVersion).toBe(9);
    expect((m.state.nodes.n_stray.params as { target: string }).target).toBe('n_obj');
  });

  it('...and an EARLIER pass may still reparent such a channel, which is inert and pre-dates the camera', () => {
    // The precise statement of why the ownership check in `isDataParamPath` is enough.
    // `paramPath` is free text, so a channel can carry a camera's name while targeting
    // a BOX — and the v2→v3 box pass, gating on its own id map plus the SHARED
    // predicate, does move it to the BoxData. That is not a camera regression: the
    // CONTROL below shows `intensity` (a LIGHT name, in the predicate since #386)
    // behaves identically. It is harmless because no earlier kind OWNS either name, so
    // both channels were already driving nothing — the move relocates an inert channel
    // between two halves of the same subject. A name an earlier kind DID own would be a
    // real, silent mis-move, which is what the ownership check exists to prevent.
    let s = emptyDagState();
    const add = (op: Parameters<typeof applyOp>[1]) => {
      s = applyOp(s, op).next;
    };
    s = addRetiredNode(s, 'n_box', 'BoxMesh', 4, {
      size: [1, 1, 1],
      ...FUSED_TRS,
      material: openpbrMaterialSchema().parse({ name: 'm', base: { color: '#123456' } }),
    });
    for (const [id, path] of [
      ['n_stray_fov', 'fov'],
      ['n_stray_int', 'intensity'],
    ] as const) {
      add({
        type: 'addNode',
        nodeId: id,
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: path,
          target: 'n_box',
          paramPath: path,
          keyframes: [
            { time: 0, value: 10, easing: 'linear' },
            { time: 1, value: 20, easing: 'linear' },
          ],
        },
      });
    }
    const nodes = JSON.parse(JSON.stringify(s.nodes));
    const m = loadFromBytes({
      formatVersion: 2,
      id: 'p387-inert-reparent',
      name: 'stray camera-name and light-name channels on a box',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: { BoxMesh: nodes.n_box.version },
      state: { nodes, outputs: s.outputs },
    });
    const boxData = Object.values(m.state.nodes).find(
      (n) => n.type === 'BoxData' && n.id.startsWith('n_box__data'),
    )!;
    // Both move, and they move the SAME way — the camera's names inherit an existing
    // property of the shared predicate rather than introducing one.
    expect((m.state.nodes.n_stray_fov.params as { target: string }).target).toBe(boxData.id);
    expect((m.state.nodes.n_stray_int.params as { target: string }).target).toBe(boxData.id);
    // The box's own geometry road is unaffected either way — nothing reads `fov` or
    // `intensity` off a BoxData, which is exactly why this is inert.
    expect(m.state.nodes.n_box.type).toBe('Object');
  });

  it('CONTROLS: box, curve and light still split alongside the camera pass in one load', () => {
    // A mixed formatVersion-2 scene carrying every kind split so far plus a camera:
    // all five passes run in sequence on one load, so the earlier kinds are live
    // controls for the camera pass rather than a comment.
    let s = emptyDagState();
    const add = (op: Parameters<typeof applyOp>[1]) => {
      s = applyOp(s, op).next;
    };
    s = addRetiredNode(s, 'n_box', 'BoxMesh', 4, {
      size: [1, 1, 1],
      ...FUSED_TRS,
      material: openpbrMaterialSchema().parse({ name: 'm', base: { color: '#123456' } }),
    });
    s = addRetiredNode(
      s,
      'n_curve',
      'Curve',
      2,
      fusedCurve({
        points: [
          { id: 'cp0', co: [0, 0, 0] },
          { id: 'cp1', co: [1, 1, 1] },
        ],
      }),
    );
    s = addRetiredNode(s, 'n_point', 'PointLight', 1, {
      ...FUSED_TRS,
      intensity: 2.2,
      position: [0, 3, 0],
      color: '#ffffff',
      distance: 0,
      decay: 2,
    });
    s = addRetiredNode(
      s,
      'n_persp',
      'PerspectiveCamera',
      1,
      fusedPerspectiveCamera({
        fov: CAM_PERSP_FOV,
        far: CAM_FAR,
        position: CAM_POSITION,
        lookAt: CAM_LOOKAT,
      }),
    );
    // A light `intensity` channel — an EARLIER kind's data-param channel, routed by the
    // same shared predicate during a different pass.
    add({
      type: 'addNode',
      nodeId: 'n_lint',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'intensity',
        target: 'n_point',
        paramPath: 'intensity',
        keyframes: [
          { time: 0, value: 2.2, easing: 'linear' },
          { time: 1, value: 6, easing: 'linear' },
        ],
      },
    });
    const nodes = JSON.parse(JSON.stringify(s.nodes));
    const m = loadFromBytes({
      formatVersion: 2,
      id: 'p387-mixed',
      name: 'box+curve+light+camera',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: {
        BoxMesh: nodes.n_box.version,
        Curve: nodes.n_curve.version,
        PointLight: nodes.n_point.version,
        PerspectiveCamera: nodes.n_persp.version,
      },
      state: { nodes, outputs: s.outputs },
    });
    expect(m.formatVersion).toBe(9);
    // Controls — every earlier kind still splits.
    expect(m.state.nodes.n_box.type).toBe('Object');
    expect(Object.values(m.state.nodes).some((n) => n.type === 'BoxData')).toBe(true);
    expect(m.state.nodes.n_curve.type).toBe('Object');
    expect(Object.values(m.state.nodes).some((n) => n.type === 'CurveData')).toBe(true);
    expect(m.state.nodes.n_point.type).toBe('Object');
    expect(splitLightDataNode(m, 'n_point')).toBeDefined();
    // ...and the light's own data-param channel still routes to ITS data half, proving
    // the camera's newly-added names did not disturb an earlier pass.
    expect((m.state.nodes.n_lint.params as { target: string }).target).toBe(
      splitLightDataNode(m, 'n_point')!.id,
    );
    // And the camera split alongside them.
    expect(m.state.nodes.n_persp.type).toBe('Object');
    expect(splitCameraDataNode(m, 'n_persp')).toBeDefined();
  });
});

// ── v7 → v8: fused BakedMesh → Object + BakedData (#388 Stage C · C5) ──────
//
// The sixth kind, and the last node that still minted a fused pair.
//
// THE FIXTURE IS DELIBERATELY POSED AWAY FROM IDENTITY, and that is the one thing this
// kind's fixture must get right. A baked mesh comes out of Apply Transform with identity
// TRS — which is ALSO `BakedMesh`'s schema default AND what a completely broken pose
// carry would produce. A fixture built at identity is green whether or not the migration
// carries the pose at all (H177). A baked mesh is first-class and re-transformable after
// the bake, so a non-identity pose is a legitimate saved state and the only one that can
// tell the two apart.
//
// The material colour likewise avoids `#808080` on purpose: that is the grey fallback a
// discarded baked spec renders as, so a fixture asserting it would pass precisely when
// the road is broken.
//
// ⚠️ WHAT THIS SUITE DOES AND DOES NOT PROVE. It proves the migrated pair carries the
// right params and evaluates to the right VALUE. It does NOT prove the pair DRAWS — that
// is a fact about the live three.js scene, and no assertion here can see it. The renderer
// slice has since taught `ObjectR`'s BakedData arm the async road (it recomposes and
// renders through `BakedMeshR`), and the drawing is observed in a browser rather than
// inferred from a green suite here. `resolveEvaluatedMesh` still does not span the pair
// — that is the flip slice's. This is also why the byte-identity check below compares
// against CANONICAL
// values rather than a live fused resolve — the fused node retires two slices from now
// and a fixture that compares against it dies with it.
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §5; K23; issue #388.

const BAKED_POSITION: Vec3 = [3, -2, 5];
const BAKED_ROTATION: Vec3 = [0, 30, 0];
const BAKED_SCALE: Vec3 = [2, 1, 0.5];
const BAKED_GEOMETRY = {
  key: 'baked|p388mig',
  kind: 'baked' as const,
  descriptor: { kind: 'baked' as const, hash: 'p388mig', vertexCount: 24 },
};
/** The full rich spec a bake captures. `#c81e5a` is neither a schema default nor the
 *  `#808080` grey a discarded baked spec renders as. */
const BAKED_MATERIAL = {
  materialClass: 'physical' as const,
  color: '#c81e5a',
  roughness: 0.42,
  metalness: 0.75,
  opacity: 1,
  transparent: false,
  emissive: '#000000',
  emissiveIntensity: 0,
  map: null,
  normalMap: null,
  roughnessMap: null,
  metalnessMap: null,
  aoMap: null,
  emissiveMap: null,
};

/** A v7 project with a fused BakedMesh posed away from identity, consumed by a Scene,
 *  and carrying three channels: `material.roughness` and `geometry` (data params → must
 *  follow the BakedData) and `position` (a transform → must stay on the inherited-id
 *  Object). */
function buildFusedBakedMeshJson() {
  let s = emptyDagState();
  const add = (op: Parameters<typeof applyOp>[1]) => {
    s = applyOp(s, op).next;
  };
  s = addRetiredNode(s, 'n_baked', 'BakedMesh', 1, {
    geometry: BAKED_GEOMETRY,
    position: BAKED_POSITION,
    rotation: BAKED_ROTATION,
    scale: BAKED_SCALE,
    material: BAKED_MATERIAL,
  });
  // A Scene consuming the baked mesh. This is the POINT of id inheritance: the edge
  // names `n_baked` and must still name it after the split, with no re-pointing pass.
  add({ type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} });
  s = connectFromRetired(
    s,
    { node: 'n_baked', socket: 'out' },
    { node: 'n_scene', socket: 'children' },
  );
  // A full render root, because `resolveEvaluatedTransform` walks from `outputs.render`
  // and returns null without one — a legitimate null that reads exactly like a broken
  // pose carry. The camera is built SPLIT-NATIVE: this fixture is stamped v7, so the
  // 6→7 camera pass never runs on it, and a fused `PerspectiveCamera` here would stay
  // fused and throw on evaluate (it is a retired relic as of #387 slice 8).
  s = makeSplitCamera(s, {
    objectId: 'n_camera',
    position: [3, 2, 3],
    lens: { lookAt: [0, 0, 0], near: 0.01, far: 500 },
    connectTo: { node: 'n_scene', socket: 'camera' },
  }).state;
  add({
    type: 'addNode',
    nodeId: 'n_render',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'ACES', smaa: true } },
  });
  add({
    type: 'connect',
    from: { node: 'n_scene', socket: 'out' },
    to: { node: 'n_render', socket: 'scene' },
  });
  add({
    type: 'addNode',
    nodeId: 'n_rough',
    nodeType: 'KeyframeChannelNumber',
    params: {
      name: 'roughness',
      target: 'n_baked',
      paramPath: 'material.roughness',
      keyframes: [
        { time: 0, value: 0.42, easing: 'linear' },
        { time: 1, value: 0.9, easing: 'linear' },
      ],
    },
  });
  // A `geometry` channel. It is not a MEANINGFUL animation — a content-hashed buffer
  // handle is not interpolatable — but `paramPath` is free text and a saved project can
  // carry one, and the choice is between following the param to its new owner and
  // silently orphaning it onto a transform-only Object. This is the ONLY channel in the
  // suite that exercises the `geometry` arm this pass added to `isDataParamPath`;
  // without it that arm could be deleted with no test going red.
  add({
    type: 'addNode',
    nodeId: 'n_geom',
    nodeType: 'KeyframeChannelNumber',
    params: {
      name: 'geometry',
      target: 'n_baked',
      paramPath: 'geometry',
      keyframes: [
        { time: 0, value: 0, easing: 'linear' },
        { time: 1, value: 1, easing: 'linear' },
      ],
    },
  });
  add({
    type: 'addNode',
    nodeId: 'n_bpos',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: 'n_baked',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: BAKED_POSITION, easing: 'linear' },
        { time: 1, value: [3, 7, 5], easing: 'linear' },
      ],
    },
  });
  const nodes = JSON.parse(JSON.stringify(s.nodes));
  return {
    formatVersion: 7,
    id: 'p388-baked-split',
    name: 'pre-split baked mesh',
    createdAt: 0,
    updatedAt: 0,
    nodeVersions: { BakedMesh: nodes.n_baked.version },
    state: {
      nodes,
      outputs: {
        ...s.outputs,
        scene: { node: 'n_scene', socket: 'out' },
        render: { node: 'n_render', socket: 'out' },
      },
    },
  };
}

/** The BakedData node a split produced from the baked mesh `bakedId`. */
function splitBakedDataNode(project: Project, bakedId: string) {
  return Object.values(project.state.nodes).find(
    (n) => n.type === 'BakedData' && n.id.startsWith(`${bakedId}__data`),
  );
}

describe('object↔data split v7 → v8: fused BakedMesh → Object + BakedData (#388)', () => {
  it('splits the baked mesh: the Object inherits the id and the pose, the BakedData owns the buffer + material', () => {
    const m = loadFromBytes(buildFusedBakedMeshJson());
    // 7 → 8 (baked pass only; this fixture has no earlier fused kind).
    expect(m.formatVersion).toBe(9);

    const obj = m.state.nodes.n_baked;
    expect(obj.type).toBe('Object');
    // The WHOLE pose, carried across unchanged — and every component differs from the
    // identity default, so "carried" and "defaulted" are distinguishable here.
    expect(obj.params).toEqual({
      position: BAKED_POSITION,
      rotation: BAKED_ROTATION,
      scale: BAKED_SCALE,
    });
    // The data params LEFT the Object.
    expect('geometry' in (obj.params as object)).toBe(false);
    expect('material' in (obj.params as object)).toBe(false);

    // The data half owns exactly the two params, both verbatim — this migration invents
    // nothing at all, unlike the camera's one `fov: 45` for an orthographic source.
    const data = splitBakedDataNode(m, 'n_baked')!;
    expect(data).toBeDefined();
    expect(data.params).toEqual({ geometry: BAKED_GEOMETRY, material: BAKED_MATERIAL });
    // ...and no pose came with it.
    for (const p of ['position', 'rotation', 'scale']) {
      expect(p in (data.params as object)).toBe(false);
    }
    expect((obj.inputs as Record<string, { node: string }>).data.node).toBe(data.id);
  });

  it('the consumer edge needs NO re-pointing — scene.children still names the inherited id', () => {
    // The whole reason the fused node is converted IN PLACE rather than replaced. The
    // migration contains no edge-rewriting pass at all; this is what makes that correct,
    // and it covers constraint targets and saved selections by the same mechanism.
    const m = loadFromBytes(buildFusedBakedMeshJson());
    const children = (m.state.nodes.n_scene.inputs as Record<string, { node: string }[]>).children;
    expect(children.map((r) => r.node)).toContain('n_baked');
    expect(m.state.nodes.n_baked.type).toBe('Object');
    // The data half is a NEW node the scene does not reference — it hangs off the
    // Object's `data` input only.
    const data = splitBakedDataNode(m, 'n_baked')!;
    expect(children.map((r) => r.node)).not.toContain(data.id);
  });

  it('routes channels by paramPath: material.* AND geometry → the BakedData, position → the Object', () => {
    const m = loadFromBytes(buildFusedBakedMeshJson());
    const data = splitBakedDataNode(m, 'n_baked')!;
    // `material.*` rides the arm the box pass added — the baked mesh inherits it rather
    // than needing a second one.
    expect((m.state.nodes.n_rough.params as { target: string }).target).toBe(data.id);
    // `geometry` is the ONE name this pass added to the shared predicate.
    expect((m.state.nodes.n_geom.params as { target: string }).target).toBe(data.id);
    // A `position` channel addresses the pose → it stays on the inherited-id Object.
    expect((m.state.nodes.n_bpos.params as { target: string }).target).toBe('n_baked');
  });

  it('the Object inherits the id, so a position channel still animates it', () => {
    const m = loadFromBytes(buildFusedBakedMeshJson());
    const p0 = resolveEvaluatedTransform(m.state, 'n_baked', ctxAt(0))!.position;
    const p1 = resolveEvaluatedTransform(m.state, 'n_baked', ctxAt(1))!.position;
    expect(p0).toEqual(BAKED_POSITION);
    expect(p1[1]).toBe(7); // the channel drives the Object's position
  });

  it('evaluates to the CANONICAL baked value — the handle and the rich spec, not a MeshData', () => {
    const m = loadFromBytes(buildFusedBakedMeshJson());
    const data = splitBakedDataNode(m, 'n_baked')!;
    const value = evaluate(m.state, data.id).value as BakedDataValue;
    // The KIND is the assertion that matters most here. A `MeshData` would typecheck at
    // every consumer and render the material as grey and the geometry as nothing, both
    // silently — which is exactly why baked has its own member of the ObjectData union.
    expect(value.kind).toBe('BakedData');
    expect(value.geometry).toEqual(BAKED_GEOMETRY);
    expect(value.material).toEqual(BAKED_MATERIAL);
    // Not a degenerate fixture: the colour differs from the grey a discarded baked spec
    // renders as, so this assertion can tell a live carry from a swallowed one.
    expect(value.material.color).not.toBe('#808080');
  });

  it('hydrates a MISSING pose to identity — the one place this pass supplies a value', () => {
    // The mirror of the camera's missing-`fov` test, and it lands the other way. All
    // three TRS params carry `BakedMesh`'s own schema default, so a hand-edited save may
    // omit them; identity is MEANINGFUL for this kind (the transform was composed into
    // the vertices, so identity is what the renderer must apply) rather than a failure
    // sentinel, which is the test for whether to hydrate at all.
    const noPose = {
      formatVersion: 7,
      id: 'p388-nopose',
      name: 'baked mesh without a stored pose',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: { BakedMesh: 1 },
      state: {
        nodes: {
          n_baked: {
            id: 'n_baked',
            type: 'BakedMesh',
            version: 1,
            params: { geometry: BAKED_GEOMETRY, material: BAKED_MATERIAL },
            inputs: {},
          },
        },
        outputs: {},
      },
    };
    const m = loadFromBytes(noPose);
    expect(m.state.nodes.n_baked.params).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    // The DATA half still invents nothing — both its params were present and are carried
    // through untouched.
    expect(splitBakedDataNode(m, 'n_baked')!.params).toEqual({
      geometry: BAKED_GEOMETRY,
      material: BAKED_MATERIAL,
    });
  });

  it('is idempotent — re-loading a split project is a stable no-op', () => {
    const once = loadFromBytes(buildFusedBakedMeshJson());
    const twice = loadFromBytes(once);
    for (const id of ['n_baked', 'n_scene', 'n_rough', 'n_geom', 'n_bpos']) {
      expect(twice.state.nodes[id]).toEqual(once.state.nodes[id]);
    }
    expect(splitBakedDataNode(twice, 'n_baked')).toEqual(splitBakedDataNode(once, 'n_baked'));
    // No fused baked mesh survives.
    expect(Object.values(twice.state.nodes).some((n) => n.type === 'BakedMesh')).toBe(false);
  });

  it('COLLISION GATE: the baked pass moves a channel only when its TARGET is a baked mesh', () => {
    // `geometry` joined the shared `isDataParamPath` predicate in this pass, and that
    // predicate is consulted by ALL SIX passes. What keeps the name safe is NOT the name
    // — it is that each pass gates on its OWN id map. Stamped at v7 so only the baked
    // pass runs: with no baked mesh in the file the id map is empty and the re-target
    // loop never executes, so a `geometry` channel on a non-baked node is untouched.
    const strayOnNonBaked = {
      formatVersion: 7,
      id: 'p388-collision',
      name: 'stray geometry channel on a plain Object',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: { KeyframeChannelNumber: 2 },
      state: {
        nodes: {
          n_obj: {
            id: 'n_obj',
            type: 'Object',
            version: 1,
            params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            inputs: {},
          },
          n_stray: {
            id: 'n_stray',
            type: 'KeyframeChannelNumber',
            version: 2,
            params: {
              name: 'geometry',
              target: 'n_obj',
              paramPath: 'geometry',
              keyframes: [
                { time: 0, value: 0, easing: 'linear' },
                { time: 1, value: 1, easing: 'linear' },
              ],
            },
            inputs: {},
          },
        },
        outputs: {},
      },
    };
    const m = loadFromBytes(strayOnNonBaked);
    expect(m.formatVersion).toBe(9);
    expect((m.state.nodes.n_stray.params as { target: string }).target).toBe('n_obj');
  });

  it('CONTROLS: box, curve, light and camera still split alongside the baked pass in one load', () => {
    // A mixed formatVersion-2 scene carrying every kind split so far plus a baked mesh:
    // all six passes run in sequence on one load, so the earlier kinds are live controls
    // for the baked pass rather than a comment.
    let s = emptyDagState();
    const add = (op: Parameters<typeof applyOp>[1]) => {
      s = applyOp(s, op).next;
    };
    s = addRetiredNode(s, 'n_box', 'BoxMesh', 4, {
      size: [1, 1, 1],
      ...FUSED_TRS,
      material: openpbrMaterialSchema().parse({ name: 'm', base: { color: '#123456' } }),
    });
    s = addRetiredNode(s, 'n_sphere', 'SphereMesh', 4, {
      radius: 1.3,
      widthSegments: 24,
      heightSegments: 16,
      ...FUSED_TRS,
      material: fusedMaterial('#cccccc'),
    });
    s = addRetiredNode(
      s,
      'n_curve',
      'Curve',
      2,
      fusedCurve({
        points: [
          { id: 'cp0', co: [0, 0, 0] },
          { id: 'cp1', co: [1, 1, 1] },
        ],
      }),
    );
    s = addRetiredNode(s, 'n_point', 'PointLight', 1, {
      ...FUSED_TRS,
      intensity: 2.2,
      position: [0, 3, 0],
      color: '#ffffff',
      distance: 0,
      decay: 2,
    });
    s = addRetiredNode(
      s,
      'n_persp',
      'PerspectiveCamera',
      1,
      fusedPerspectiveCamera({
        fov: CAM_PERSP_FOV,
        far: CAM_FAR,
        position: CAM_POSITION,
        lookAt: CAM_LOOKAT,
      }),
    );
    s = addRetiredNode(s, 'n_baked', 'BakedMesh', 1, {
      geometry: BAKED_GEOMETRY,
      position: BAKED_POSITION,
      rotation: BAKED_ROTATION,
      scale: BAKED_SCALE,
      material: BAKED_MATERIAL,
    });
    // A light `intensity` channel — an EARLIER kind's data-param channel, routed by the
    // same shared predicate during a different pass.
    add({
      type: 'addNode',
      nodeId: 'n_lint',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'intensity',
        target: 'n_point',
        paramPath: 'intensity',
        keyframes: [
          { time: 0, value: 2.2, easing: 'linear' },
          { time: 1, value: 6, easing: 'linear' },
        ],
      },
    });
    const nodes = JSON.parse(JSON.stringify(s.nodes));
    const m = loadFromBytes({
      formatVersion: 2,
      id: 'p388-mixed',
      name: 'box+sphere+curve+light+camera+baked',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: {
        BoxMesh: nodes.n_box.version,
        SphereMesh: nodes.n_sphere.version,
        Curve: nodes.n_curve.version,
        PointLight: nodes.n_point.version,
        PerspectiveCamera: nodes.n_persp.version,
        BakedMesh: nodes.n_baked.version,
      },
      state: { nodes, outputs: s.outputs },
    });
    // The full chain: 2 → 3 → 4 → 5 → 6 → 7 → 8, every step doing real work.
    expect(m.formatVersion).toBe(9);
    // Controls — every earlier kind still splits.
    expect(m.state.nodes.n_box.type).toBe('Object');
    expect(Object.values(m.state.nodes).some((n) => n.type === 'BoxData')).toBe(true);
    expect(m.state.nodes.n_sphere.type).toBe('Object');
    expect(Object.values(m.state.nodes).some((n) => n.type === 'SphereData')).toBe(true);
    expect(m.state.nodes.n_curve.type).toBe('Object');
    expect(Object.values(m.state.nodes).some((n) => n.type === 'CurveData')).toBe(true);
    expect(m.state.nodes.n_point.type).toBe('Object');
    expect(splitLightDataNode(m, 'n_point')).toBeDefined();
    expect(m.state.nodes.n_persp.type).toBe('Object');
    expect(splitCameraDataNode(m, 'n_persp')).toBeDefined();
    // ...and the light's own data-param channel still routes to ITS data half, proving
    // the baked pass's newly-added name did not disturb an earlier pass.
    expect((m.state.nodes.n_lint.params as { target: string }).target).toBe(
      splitLightDataNode(m, 'n_point')!.id,
    );
    // And the baked mesh split alongside them, pose intact.
    expect(m.state.nodes.n_baked.type).toBe('Object');
    expect((m.state.nodes.n_baked.params as { position: Vec3 }).position).toEqual(BAKED_POSITION);
    expect(splitBakedDataNode(m, 'n_baked')).toBeDefined();
  });
});

/** A serialized pre-#168 (v1) RenderOutput project — NO width/height. */
const V1_RENDER_PROJECT = {
  formatVersion: 1,
  id: 'p168-migration',
  name: 'pre-resolution render',
  createdAt: 0,
  updatedAt: 0,
  nodeVersions: { RenderOutput: 1 },
  state: {
    nodes: {
      n_render: {
        id: 'n_render',
        type: 'RenderOutput',
        version: 1,
        params: { postFx: { tonemap: 'ACES', smaa: true } },
        inputs: {},
      },
    },
    outputs: {},
  },
};

describe('RenderOutput v1 → v2 resolution migration (#168 byte-identical gate)', () => {
  it('steps version 1 → 2 and adds the 1920×1080 default', () => {
    const migrated = loadFromBytes(V1_RENDER_PROJECT);
    const render = migrated.state.nodes.n_render;
    expect(render.version).toBe(2);
    expect((render.params as { width?: unknown }).width).toBe(1920);
    expect((render.params as { height?: unknown }).height).toBe(1080);
  });

  it('leaves postFx byte-identical', () => {
    const migrated = loadFromBytes(V1_RENDER_PROJECT);
    const p = migrated.state.nodes.n_render.params as Record<string, unknown>;
    expect(p.postFx).toEqual(V1_RENDER_PROJECT.state.nodes.n_render.params.postFx);
  });

  it('is idempotent — re-loading is a stable no-op', () => {
    const once = loadFromBytes(V1_RENDER_PROJECT);
    const twice = loadFromBytes(once);
    expect(twice.state.nodes.n_render).toEqual(once.state.nodes.n_render);
    expect(twice.state.nodes.n_render.version).toBe(2);
  });
});

// ── AnimationLayer retirement (#199) — byte-identical render gate ───────────
// The v1→v2 format migration reverses addLayer's splice: a layer wrapping n_box
// (with a position channel) becomes a FREE-FLOATING direct channel targeting
// n_box, the layer node gone, scene.children re-pointed to the box. The gate:
// resolveEvaluatedTransform('n_box') — the SAME read-side band the renderer draws
// (V57/#197) — must be IDENTICAL pre-migration (layer path) and post-migration
// (direct channel) at every time, including the layer's weight/mute folded onto
// the channel. REF: docs/UNIFICATION-DESIGN.md §4; vyapti V57; hetvabhasa H40.

/** A serialized pre-#199 (formatVersion=1) project with n_box wrapped in an
 *  AnimationLayer (a position channel wired in) — the exact bytes `addLayer`
 *  produced and a pre-#199 save wrote to disk. The AnimationLayer node type is
 *  no longer registered (#199 Slice C), so it CANNOT be built via applyOp; it is
 *  injected as RAW JSON, mirroring the on-disk shape the load-time
 *  migrateAnimationLayers pass consumes (it runs BEFORE schema parse — H106). The
 *  channel + box are built through the real pipeline (both still registered) so
 *  their versions/shape are authoritative. Optional layer weight/mute. */
function buildLayerWrappedV1Json(opts?: { weight?: number; mute?: boolean }) {
  let s = buildDefaultDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_pos_channel',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: 'n_box',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 1, value: [0, 6, 0], easing: 'linear' },
      ],
    },
  }).next;
  const nodes = JSON.parse(JSON.stringify(s.nodes)) as Record<
    string,
    { id: string; type: string; version: number; params: unknown; inputs: Record<string, unknown> }
  >;
  // Inject the legacy AnimationLayer node (raw, version 1) + the addLayer splice:
  // the layer wraps n_box (target socket) + the channel (animation socket), and
  // becomes the scene child in n_box's place.
  nodes.n_box_layer = {
    id: 'n_box_layer',
    type: 'AnimationLayer',
    version: 1,
    params: {
      name: 'Layer',
      weight: opts?.weight ?? 1,
      boneMask: [],
      mute: opts?.mute ?? false,
      solo: false,
    },
    inputs: {
      target: [{ node: 'n_box', socket: 'out' }],
      animation: [{ node: 'n_pos_channel', socket: 'out' }],
    },
  };
  const sc = nodes.n_scene.inputs.children;
  const refs = (Array.isArray(sc) ? sc : sc ? [sc] : []) as { node: string; socket: string }[];
  nodes.n_scene.inputs.children = refs.map((r) =>
    r.node === 'n_box' ? { ...r, node: 'n_box_layer' } : r,
  );
  return {
    formatVersion: 1,
    id: 'p199-layer-migration',
    name: 'pre-#199 layer project',
    createdAt: 0,
    updatedAt: 0,
    nodeVersions: {
      BoxMesh: nodes.n_box.version,
      KeyframeChannelVec3: nodes.n_pos_channel.version,
    },
    state: { nodes, outputs: s.outputs },
  };
}

/** The EQUIVALENT layer-free state a native author would build today: one
 *  free-floating direct channel targeting n_box (the layer's weight/mute folded
 *  onto the channel). Built via the real pipeline (no layer); migrating
 *  buildLayerWrappedV1Json must render IDENTICALLY to this (V57). */
function buildDirectChannelState(opts?: { weight?: number; mute?: boolean }): DagState {
  let s = buildDefaultDagState();
  const params: Record<string, unknown> = {
    name: 'position',
    target: 'n_box',
    paramPath: 'position',
    keyframes: [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 1, value: [0, 6, 0], easing: 'linear' },
    ],
  };
  if (opts?.weight !== undefined && opts.weight !== 1) params.weight = opts.weight;
  if (opts?.mute) params.mute = true;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_pos_channel',
    nodeType: 'KeyframeChannelVec3',
    params,
  }).next;
  return s;
}

function childRefNodes(state: DagState): string[] {
  const sceneChildren = state.nodes.n_scene.inputs.children;
  const refs = Array.isArray(sceneChildren) ? sceneChildren : sceneChildren ? [sceneChildren] : [];
  return refs.map((r) => r.node);
}

describe('AnimationLayer v1 → v2 retirement (byte-identical render gate, #199)', () => {
  it('reverses the splice: layer gone, channel re-targets n_box, scene.children → n_box', () => {
    const migrated = loadFromBytes(buildLayerWrappedV1Json());
    // 1→2 layer → 3 box → 4 sphere → 5 curve → 6 light → 7 camera → 8 baked.
    expect(migrated.formatVersion).toBe(9);
    // No AnimationLayer node survives the load.
    expect(Object.values(migrated.state.nodes).some((n) => n.type === 'AnimationLayer')).toBe(
      false,
    );
    expect(migrated.state.nodes.n_box_layer).toBeUndefined();
    // The channel is a free-floating direct channel targeting the wrapped node.
    const ch = migrated.state.nodes.n_pos_channel;
    expect(ch).toBeDefined();
    expect((ch.params as { target: string }).target).toBe('n_box');
    // scene.children names the box directly again (the splice, reversed).
    expect(childRefNodes(migrated.state)).toContain('n_box');
    expect(childRefNodes(migrated.state)).not.toContain('n_box_layer');
  });

  it('renders identically to a native direct-channel project at every t (V57)', () => {
    const post = loadFromBytes(buildLayerWrappedV1Json()).state;
    const direct = buildDirectChannelState();
    for (const t of [0, 0.5, 1]) {
      const ctx = ctxAt(t);
      const a = resolveEvaluatedTransform(direct, 'n_box', ctx);
      const b = resolveEvaluatedTransform(post, 'n_box', ctx);
      expect(a, `direct resolves at t=${t}`).not.toBeNull();
      expect(b, `migrated resolves at t=${t}`).not.toBeNull();
      expect(b, `migrated == native direct at t=${t}`).toEqual(a);
    }
    // Sanity: the channel actually animated (not a degenerate all-equal fixture).
    const p0 = resolveEvaluatedTransform(post, 'n_box', ctxAt(0))!.position;
    const p1 = resolveEvaluatedTransform(post, 'n_box', ctxAt(1))!.position;
    expect(p1[1]).not.toBe(p0[1]);
  });

  it('folds the layer WEIGHT onto each channel (0.5 blend == native direct channel)', () => {
    const migrated = loadFromBytes(buildLayerWrappedV1Json({ weight: 0.5 }));
    expect((migrated.state.nodes.n_pos_channel.params as { weight: number }).weight).toBe(0.5);
    const direct = buildDirectChannelState({ weight: 0.5 });
    for (const t of [0, 0.5, 1]) {
      expect(resolveEvaluatedTransform(migrated.state, 'n_box', ctxAt(t))).toEqual(
        resolveEvaluatedTransform(direct, 'n_box', ctxAt(t)),
      );
    }
  });

  it('folds the layer MUTE onto each channel (muted → base, no overlay)', () => {
    const migrated = loadFromBytes(buildLayerWrappedV1Json({ mute: true }));
    expect((migrated.state.nodes.n_pos_channel.params as { mute: boolean }).mute).toBe(true);
    // A muted channel contributes nothing → position stays at the static base at every t.
    const at0 = resolveEvaluatedTransform(migrated.state, 'n_box', ctxAt(0))!.position;
    const at1 = resolveEvaluatedTransform(migrated.state, 'n_box', ctxAt(1))!.position;
    expect(at1).toEqual(at0);
    // ... and identically to a native muted direct channel.
    expect(resolveEvaluatedTransform(migrated.state, 'n_box', ctxAt(1))).toEqual(
      resolveEvaluatedTransform(buildDirectChannelState({ mute: true }), 'n_box', ctxAt(1)),
    );
  });

  it('is idempotent — re-loading a migrated (layer-free) project is a stable no-op', () => {
    const once = loadFromBytes(buildLayerWrappedV1Json());
    const twice = loadFromBytes(once);
    expect(twice.state.nodes.n_pos_channel).toEqual(once.state.nodes.n_pos_channel);
    expect(Object.values(twice.state.nodes).some((n) => n.type === 'AnimationLayer')).toBe(false);
  });
});

// ── #275 — extend/cycle enum → Cycles F-Modifier (byte-identical sample gate) ─
// A v1 KeyframeChannelNumber carries the OLD 5-enum `extend{Before,After}` +
// `cycles{Before,After}`. The v1→v2 migration splits it: hold/slope stay the
// extrapolation property, cycle/cycle-offset/mirror move to a Cycles F-Modifier.
// THE gate: the migrated node's ACTUAL sample() (through the real evaluate →
// resolveExtend → the UNCHANGED sampler) must equal the pre-migration value at
// every out-of-domain time — with the unchanged `sampleScalarKeyframesExtended`
// (old 5-enum + counts) as the oracle. REF: issue #275; vyapti V88 D2.

const CH_KEYS = [
  { time: 0, value: 0, easing: 'linear' as const },
  { time: 2, value: 10, easing: 'linear' as const },
];

/** A serialized pre-#275 (v1) KeyframeChannelNumber with the given legacy extend. */
function buildV1NumberChannelJson(v1Params: Record<string, unknown>) {
  return {
    formatVersion: 1,
    id: 'p275-migration',
    name: 'pre-cycles-modifier channel',
    createdAt: 0,
    updatedAt: 0,
    nodeVersions: { KeyframeChannelNumber: 1 },
    state: {
      nodes: {
        n_ch: {
          id: 'n_ch',
          type: 'KeyframeChannelNumber',
          version: 1,
          params: { name: 'fov', target: 'x', paramPath: 'fov', keyframes: CH_KEYS, ...v1Params },
          inputs: {},
        },
      },
      outputs: {},
    },
  };
}

/** The migrated node's REAL evaluated sampler (evaluate → resolveExtend → sampler). */
function migratedSampler(migrated: Project): (t: number) => number {
  const params = migrated.state.nodes.n_ch.params as KeyframeChannelNumberParams;
  return KeyframeChannelNumberNode.evaluate(params).sample;
}

const OUT_OF_DOMAIN = [1, 2.0001, 3, 4, 5, 6, 7, -1, -3];

describe('KeyframeChannel v1 → v2: extend/cycle → Cycles modifier (#275, byte-identical)', () => {
  it.each([
    ['cycle', 'repeat'],
    ['cycle-offset', 'repeat-offset'],
    ['mirror', 'repeat-mirror'],
  ])('extendAfter=%s migrates to a Cycles modifier (afterMode=%s) — same sample', (rule, mode) => {
    const migrated = loadFromBytes(buildV1NumberChannelJson({ extendAfter: rule, cyclesAfter: 0 }));
    const node = migrated.state.nodes.n_ch;
    expect(node.version).toBe(2);
    const p = node.params as Record<string, unknown>;
    // Old params gone; extrapolation reset to hold; a Cycles modifier appeared.
    expect(p.extendAfter).toBe('hold');
    expect(p.cyclesAfter).toBeUndefined();
    expect(p.cyclesBefore).toBeUndefined();
    const mods = p.modifiers as Array<Record<string, unknown>>;
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({ type: 'cycles', afterMode: mode, beforeMode: 'none' });
    // Byte-identical sample: migrated evaluate == the pre-migration engine value.
    const sample = migratedSampler(migrated);
    for (const t of OUT_OF_DOMAIN) {
      const oracle = sampleScalarKeyframesExtended(CH_KEYS, t, 'hold', rule as ChannelExtend, 0, 0);
      expect(sample(t), `${rule} @ t=${t}`).toBeCloseTo(oracle, 9);
    }
  });

  it('carries the cycle COUNT onto the Cycles modifier (afterCycles) — same freeze', () => {
    const migrated = loadFromBytes(
      buildV1NumberChannelJson({ extendAfter: 'cycle-offset', cyclesAfter: 1 }),
    );
    const mods = migrated.state.nodes.n_ch.params.modifiers as Array<Record<string, unknown>>;
    expect(mods[0]).toMatchObject({ afterMode: 'repeat-offset', afterCycles: 1 });
    const sample = migratedSampler(migrated);
    for (const t of OUT_OF_DOMAIN) {
      const oracle = sampleScalarKeyframesExtended(CH_KEYS, t, 'hold', 'cycle-offset', 0, 1);
      expect(sample(t), `count freeze @ t=${t}`).toBeCloseTo(oracle, 9);
    }
  });

  it('hold/slope stay the extrapolation property — NO Cycles modifier', () => {
    for (const rule of ['hold', 'slope'] as const) {
      const migrated = loadFromBytes(buildV1NumberChannelJson({ extendAfter: rule }));
      const p = migrated.state.nodes.n_ch.params as Record<string, unknown>;
      expect(p.extendAfter).toBe(rule);
      expect(p.modifiers).toEqual([]);
      const sample = migratedSampler(migrated);
      for (const t of OUT_OF_DOMAIN) {
        const oracle = sampleScalarKeyframesExtended(CH_KEYS, t, 'hold', rule, 0, 0);
        expect(sample(t), `${rule} @ t=${t}`).toBeCloseTo(oracle, 9);
      }
    }
  });

  it('independent per-side rules migrate together (before=slope, after=cycle)', () => {
    const migrated = loadFromBytes(
      buildV1NumberChannelJson({ extendBefore: 'slope', extendAfter: 'cycle' }),
    );
    const p = migrated.state.nodes.n_ch.params as Record<string, unknown>;
    expect(p.extendBefore).toBe('slope'); // extrapolation kept
    const mods = p.modifiers as Array<Record<string, unknown>>;
    expect(mods[0]).toMatchObject({ type: 'cycles', beforeMode: 'none', afterMode: 'repeat' });
    const sample = migratedSampler(migrated);
    for (const t of OUT_OF_DOMAIN) {
      const oracle = sampleScalarKeyframesExtended(CH_KEYS, t, 'slope', 'cycle', 0, 0);
      expect(sample(t), `mixed @ t=${t}`).toBeCloseTo(oracle, 9);
    }
  });

  it('PREPENDS the Cycles modifier, preserving any existing Noise modifier', () => {
    const noise: FModNoise = {
      type: 'noise',
      blend: 'add',
      strength: 3,
      scale: 1,
      phase: 0,
      offset: 0,
      depth: 1,
    };
    const migrated = loadFromBytes(
      buildV1NumberChannelJson({ extendAfter: 'cycle', modifiers: [noise] }),
    );
    const mods = migrated.state.nodes.n_ch.params.modifiers as Array<Record<string, unknown>>;
    expect(mods).toHaveLength(2);
    expect(mods[0].type).toBe('cycles'); // time modifier first
    expect(mods[1]).toMatchObject({ type: 'noise', strength: 3 });
    // Byte-identical to the pre-migration channel (cycle after + the same noise).
    const sample = migratedSampler(migrated);
    for (const t of OUT_OF_DOMAIN) {
      const oracle = sampleScalarKeyframesExtended(CH_KEYS, t, 'hold', 'cycle', 0, 0, [noise]);
      expect(sample(t), `cycle+noise @ t=${t}`).toBeCloseTo(oracle, 9);
    }
  });

  it('is idempotent — re-loading a migrated channel is a stable no-op', () => {
    const once = loadFromBytes(buildV1NumberChannelJson({ extendAfter: 'mirror', cyclesAfter: 2 }));
    const twice = loadFromBytes(once);
    expect(twice.state.nodes.n_ch).toEqual(once.state.nodes.n_ch);
    expect(twice.state.nodes.n_ch.version).toBe(2);
  });
});

// The `Curve v1 → v2` describe block lived here until #599 deleted the fused `Curve`.
//
// It isolated the NODE ladder by stamping the CURRENT formatVersion on a fused Curve, which is
// a state no save can be in once the definition is gone: a project containing a fused Curve is
// at formatVersion 2-4, so the split pass consumes it before `migrateNodes` ever sees it, and
// `migrateOneNode` resolves through the registry alone. Repairing it would have meant asserting
// on a shape the product cannot produce.
//
// Its two substantive claims are covered on the REACHABLE road and were checked before it went:
//   - minting cp0..cpN in array order from bare Vec3 points — 'normalizes a v1 bare-Vec3 curve
//     through the node ladder BEFORE splitting', which runs the same ladder from formatVersion 2
//   - custom ids preserved, not re-minted, on an already-v2 curve — the split fixture asserts
//     the CurveData's points still equal CURVE_MIG_ENTRIES
// What did NOT carry over is fused-node re-load idempotence; after the split the graph holds no
// Curve to re-migrate, so the property that matters is the split's own idempotence.
//
// The ladder itself is untouched and still load-bearing — it lives in RETIRED_LADDERS and the
// split's normalize step runs it.

// ---------------------------------------------------------------------------

describe('ParamDriver v8 → v9: two source sockets collapse into one (#609)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  /** A v8 save whose vec driver is wired on the RETIRED `inVec` socket — the shape every
   *  project saved before this collapse is in. `MakeVec3` is a real Vector3 producer, so
   *  the migrated graph has to survive the connect gate as well as the schema. */
  function buildV8VecDriverJson(): unknown {
    return {
      formatVersion: 8,
      id: 'p609-migration',
      name: 'pre-collapse vec driver',
      createdAt: 0,
      updatedAt: 0,
      nodeVersions: { ParamDriver: 1, MakeVec3: 1 },
      state: {
        nodes: {
          n_vec: { id: 'n_vec', type: 'MakeVec3', version: 1, params: {}, inputs: {} },
          n_drv: {
            id: 'n_drv',
            type: 'ParamDriver',
            version: 1,
            params: { target: 'n_box', paramPath: 'position', blendMode: 'replace', order: 0 },
            inputs: { inVec: { node: 'n_vec', socket: 'out' } },
          },
        },
        outputs: {},
      },
    };
  }

  it('THE EDGE SURVIVES: an `inVec` binding lands on `in`, still naming the same producer', () => {
    // The failure this prevents is silent and total. `inVec` is gone from the
    // declaration, so without the migration the binding refers to a socket that does not
    // exist — the edge vanishes on load, the driver reads 0, and the param simply stops
    // being driven. Nothing throws.
    const migrated = loadFromBytes(buildV8VecDriverJson());
    expect(migrated.formatVersion).toBe(9);
    expect(migrated.state.nodes.n_drv.inputs.in).toEqual({ node: 'n_vec', socket: 'out' });
    expect(migrated.state.nodes.n_drv.inputs.inVec).toBeUndefined();
  });

  it('the migrated edge is one the CURRENT gate would accept', () => {
    // A migration can leave a binding the type gate would now refuse — the graph loads
    // (load does not re-run `applyConnect`) and only breaks when something rewires it.
    // Replaying the same connect against the live registry is what proves the shape is
    // legal, not merely present.
    const migrated = loadFromBytes(buildV8VecDriverJson());
    const ref = migrated.state.nodes.n_drv.inputs.in;
    expect(ref).toBeDefined();

    let state: DagState = emptyDagState();
    for (const n of Object.values(migrated.state.nodes)) {
      state = applyOp(state, {
        type: 'addNode',
        nodeId: n.id,
        nodeType: n.type,
        params: n.params,
      } as never).next;
    }
    expect(() =>
      applyOp(state, {
        type: 'connect',
        from: { node: 'n_vec', socket: 'out' },
        to: { node: 'n_drv', socket: 'in' },
      } as never),
    ).not.toThrow();
  });

  it('IDEMPOTENT, and a scalar driver is untouched', () => {
    // Re-loading a migrated save must not move anything, and a driver already on `in`
    // (every scalar bind ever made) must not be disturbed by a pass that only looks for
    // the retired key.
    const once = loadFromBytes(buildV8VecDriverJson());
    const twice = loadFromBytes(once);
    expect(twice.state.nodes.n_drv.inputs).toEqual(once.state.nodes.n_drv.inputs);

    const scalar = buildV8VecDriverJson() as {
      state: { nodes: Record<string, { inputs: Record<string, unknown> }> };
    };
    scalar.state.nodes.n_drv.inputs = { in: { node: 'n_vec', socket: 'out' } };
    const migratedScalar = loadFromBytes(scalar);
    expect(migratedScalar.state.nodes.n_drv.inputs.in).toEqual({ node: 'n_vec', socket: 'out' });
  });

  it('a driver carrying BOTH keeps the vec binding — the precedence the old evaluate had', () => {
    // Not a shape any bind produced, but the one case where the migration has to CHOOSE.
    // The old evaluate took the Vector3 road whenever `inVec` was wired, so preserving
    // that is what keeps a live driver pointed at the same source node. Picking `in`
    // would silently re-point it at a different producer.
    const both = buildV8VecDriverJson() as {
      state: { nodes: Record<string, { inputs: Record<string, unknown> }> };
    };
    both.state.nodes.n_drv.inputs = {
      in: { node: 'n_other', socket: 'out' },
      inVec: { node: 'n_vec', socket: 'out' },
    };
    const migrated = loadFromBytes(both);
    expect(migrated.state.nodes.n_drv.inputs.in).toEqual({ node: 'n_vec', socket: 'out' });
    expect(migrated.state.nodes.n_drv.inputs.inVec).toBeUndefined();
  });
});
