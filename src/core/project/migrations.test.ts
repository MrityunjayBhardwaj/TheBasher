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
import { __resetRegistryForTests } from '../dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { resolveEvaluatedMesh } from '../../app/resolveEvaluatedMesh';
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
