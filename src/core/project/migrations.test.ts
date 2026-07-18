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

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { resolveEvaluatedMesh } from '../../app/resolveEvaluatedMesh';
import { resolveEvaluatedTransform } from '../../app/resolveEvaluatedTransform';
import { CURRENT_LOOK_ROUGHNESS } from '../../nodes/materialSchema';
import type { InlineMaterialSpec } from '../../nodes/types';
import {
  KeyframeChannelNumberNode,
  type KeyframeChannelNumberParams,
} from '../../nodes/KeyframeChannelNumber';
import { sampleScalarKeyframesExtended, type ChannelExtend } from '../../nodes/keyframeInterp';
import type { FModNoise } from '../../nodes/channelModifiers';
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

describe('v1 box → normalize + split to Object + BoxData (byte-identical render gate)', () => {
  it('normalizes a v1 box through BoxMesh’s OWN ladder, THEN splits (Object gets scale=identity)', () => {
    const migrated = loadFromBytes(V1_BOX_PROJECT);
    // formatVersion 1 → 2 (AnimationLayer) → 3 (split). The box node keeps its id
    // but is now an Object; the v1→v4 normalization ran first (scale=identity).
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
    const mat = mesh!.material as InlineMaterialSpec;
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
    const mat = mesh!.material as InlineMaterialSpec;
    expect(mat.specular.roughness).toBe(0.3); // FRESH box = OpenPBR
    expect(mat.specular.roughness).not.toBe(CURRENT_LOOK_ROUGHNESS);
  });

  it('is idempotent — re-loading a split project is a stable no-op', () => {
    const once = loadFromBytes(V1_BOX_PROJECT);
    // Re-serialize the migrated (split) project and load again — the round-trip
    // the user hits on every subsequent save/load. formatVersion is now 3, so no
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

/** A genuinely FUSED BoxMesh scene, wired into a Scene — the pre-split shape. The default
 *  project is split-native now (#365 Phase 5a Slice 1b), so a migration fixture must build a
 *  real fused BoxMesh by hand; matches the default box's size + material so the byte-identical
 *  comparison against the (now-split) default holds. */
function buildFusedBoxDagState(): DagState {
  let s = emptyDagState();
  const add = (op: Parameters<typeof applyOp>[1]) => {
    s = applyOp(s, op).next;
  };
  add({
    type: 'addNode',
    nodeId: 'n_box',
    nodeType: 'BoxMesh',
    params: {
      size: [1, 1, 1],
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      material: { name: 'default', base: { color: '#5af07a' } },
    },
  });
  add({
    type: 'addNode',
    nodeId: 'n_camera',
    nodeType: 'PerspectiveCamera',
    params: { fov: 45, near: 0.01, far: 500, position: [3, 2, 3], lookAt: [0, 0, 0] },
  });
  add({ type: 'addNode', nodeId: 'n_scene', nodeType: 'Scene', params: {} });
  add({
    type: 'addNode',
    nodeId: 'n_render',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'ACES', smaa: true } },
  });
  add({
    type: 'connect',
    from: { node: 'n_box', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  });
  add({
    type: 'connect',
    from: { node: 'n_camera', socket: 'out' },
    to: { node: 'n_scene', socket: 'camera' },
  });
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
    expect(migrated.formatVersion).toBe(3);
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
    const fused = resolveEvaluatedMesh(buildDefaultDagState(), 'n_box', ctxAt(0));
    expect(split).not.toBeNull();
    expect(fused).not.toBeNull();
    expect(split!.geometry.descriptor).toEqual(fused!.geometry.descriptor);
    expect(split!.material).toEqual(fused!.material);
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
    expect(migrated.formatVersion).toBe(3); // 1→2 (layer retire) → 3 (box split)
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
