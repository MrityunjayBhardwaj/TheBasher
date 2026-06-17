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
import { __resetRegistryForTests, applyOp, type DagState } from '../dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { resolveEvaluatedMesh } from '../../app/resolveEvaluatedMesh';
import { resolveEvaluatedTransform } from '../../app/resolveEvaluatedTransform';
import { CURRENT_LOOK_ROUGHNESS } from '../../nodes/materialSchema';
import type { InlineMaterialSpec } from '../../nodes/types';
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

describe('BoxMesh v1 → v4 migration (byte-identical render gate)', () => {
  it('steps version 1 → 4 (scale + material + uvTransform) and adds scale=identity', () => {
    const migrated = loadFromBytes(V1_BOX_PROJECT);
    const box = migrated.state.nodes.n_box;
    expect(box.version).toBe(4);
    expect((box.params as { scale?: unknown }).scale).toEqual([1, 1, 1]);
  });

  it('leaves non-material params byte-identical; widens material preserving the look', () => {
    const migrated = loadFromBytes(V1_BOX_PROJECT);
    const p = migrated.state.nodes.n_box.params as Record<string, unknown>;
    const orig = V1_BOX_PROJECT.state.nodes.n_box.params;
    expect(p.size).toEqual(orig.size);
    expect(p.position).toEqual(orig.position);
    expect(p.rotation).toEqual(orig.rotation);
    // Material is NO LONGER byte-equal (it widened to the OpenPBR IR) — but the
    // LOOK is preserved: base.color carried over, roughness = CURRENT look (0.5).
    const mat = p.material as InlineMaterialSpec;
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

  it('is idempotent — re-running the load path is a stable no-op', () => {
    const once = loadFromBytes(V1_BOX_PROJECT);
    // Re-serialize the migrated project and load again (the round-trip the user
    // hits on every subsequent save/load). nodeVersions now records BoxMesh: 3.
    const twice = loadFromBytes(once);
    expect(twice.state.nodes.n_box).toEqual(once.state.nodes.n_box);
    expect(twice.state.nodes.n_box.version).toBe(4);
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

/** Default scene with n_box wrapped in an AnimationLayer (a position channel
 *  wired in) — the exact shape `addLayer` produces. Optional layer weight/mute. */
function buildLayerWrappedState(opts?: { weight?: number; mute?: boolean }): DagState {
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
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_box_layer',
    nodeType: 'AnimationLayer',
    params: { name: 'Layer', weight: opts?.weight ?? 1, mute: opts?.mute ?? false },
  }).next;
  // Splice the layer between n_box and n_scene.children (addLayer.ts:95-123).
  s = applyOp(s, {
    type: 'disconnect',
    from: { node: 'n_box', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_box', socket: 'out' },
    to: { node: 'n_box_layer', socket: 'target' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_pos_channel', socket: 'out' },
    to: { node: 'n_box_layer', socket: 'animation' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_box_layer', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  }).next;
  return s;
}

/** Serialize a DagState as a formatVersion=1 project (the bytes a pre-#199 save
 *  produced — the boundary the user hits on load). */
function serializeV1(state: DagState) {
  const nodeVersions: Record<string, number> = {};
  for (const n of Object.values(state.nodes)) {
    nodeVersions[n.type] = Math.max(nodeVersions[n.type] ?? 0, n.version);
  }
  return {
    formatVersion: 1,
    id: 'p199-layer-migration',
    name: 'pre-#199 layer project',
    createdAt: 0,
    updatedAt: 0,
    nodeVersions,
    state: { nodes: state.nodes, outputs: state.outputs },
  };
}

function childRefNodes(state: DagState): string[] {
  const sceneChildren = state.nodes.n_scene.inputs.children;
  const refs = Array.isArray(sceneChildren) ? sceneChildren : sceneChildren ? [sceneChildren] : [];
  return refs.map((r) => r.node);
}

describe('AnimationLayer v1 → v2 retirement (byte-identical render gate, #199)', () => {
  it('reverses the splice: layer gone, channel re-targets n_box, scene.children → n_box', () => {
    const migrated = loadFromBytes(serializeV1(buildLayerWrappedState()));
    expect(migrated.formatVersion).toBe(2);
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

  it('renders byte-identically: resolveEvaluatedTransform(n_box) matches pre vs post at every t', () => {
    const pre = buildLayerWrappedState();
    const post = loadFromBytes(serializeV1(pre)).state;
    for (const t of [0, 0.5, 1]) {
      const ctx = ctxAt(t);
      const a = resolveEvaluatedTransform(pre, 'n_box', ctx);
      const b = resolveEvaluatedTransform(post, 'n_box', ctx);
      expect(a, `pre resolves at t=${t}`).not.toBeNull();
      expect(b, `post resolves at t=${t}`).not.toBeNull();
      expect(b, `byte-identical at t=${t}`).toEqual(a);
    }
    // Sanity: the channel actually animated (not a degenerate all-equal fixture).
    const p0 = resolveEvaluatedTransform(post, 'n_box', ctxAt(0))!.position;
    const p1 = resolveEvaluatedTransform(post, 'n_box', ctxAt(1))!.position;
    expect(p1[1]).not.toBe(p0[1]);
  });

  it('folds the layer WEIGHT onto each channel (0.5 blend preserved pre == post)', () => {
    const pre = buildLayerWrappedState({ weight: 0.5 });
    const migrated = loadFromBytes(serializeV1(pre));
    expect((migrated.state.nodes.n_pos_channel.params as { weight: number }).weight).toBe(0.5);
    for (const t of [0, 0.5, 1]) {
      expect(resolveEvaluatedTransform(migrated.state, 'n_box', ctxAt(t))).toEqual(
        resolveEvaluatedTransform(pre, 'n_box', ctxAt(t)),
      );
    }
  });

  it('folds the layer MUTE onto each channel (muted → base, no overlay, pre == post)', () => {
    const pre = buildLayerWrappedState({ mute: true });
    const migrated = loadFromBytes(serializeV1(pre));
    expect((migrated.state.nodes.n_pos_channel.params as { mute: boolean }).mute).toBe(true);
    // A muted channel contributes nothing → position stays at the static base at every t.
    const at0 = resolveEvaluatedTransform(migrated.state, 'n_box', ctxAt(0))!.position;
    const at1 = resolveEvaluatedTransform(migrated.state, 'n_box', ctxAt(1))!.position;
    expect(at1).toEqual(at0);
    expect(resolveEvaluatedTransform(migrated.state, 'n_box', ctxAt(1))).toEqual(
      resolveEvaluatedTransform(pre, 'n_box', ctxAt(1)),
    );
  });

  it('is idempotent — re-loading a migrated (layer-free) project is a stable no-op', () => {
    const once = loadFromBytes(serializeV1(buildLayerWrappedState()));
    const twice = loadFromBytes(once);
    expect(twice.state.nodes.n_pos_channel).toEqual(once.state.nodes.n_pos_channel);
    expect(Object.values(twice.state.nodes).some((n) => n.type === 'AnimationLayer')).toBe(false);
  });
});
