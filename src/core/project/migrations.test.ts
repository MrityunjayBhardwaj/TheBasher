// Migration observation gate (v0.6 #1, issue #150 Wave 2).
//
// The pre-mortem (CONTEXT §E): a partial / non-identity migration that adds
// `scale` to the value but changes the rendered result for an EXISTING saved
// project. This suite is the byte-identical-render gate — it runs a REAL
// serialized v1 BoxMesh project (real bytes, the boundary the user actually
// hits via loadProject) through the production migration path and asserts:
//   1. node steps v1 → v2,
//   2. scale=[1,1,1] is added,
//   3. EVERY other param is byte-identical (deep-equal),
//   4. the migrated box's evaluated geometry (size) is unchanged → renders
//      identically (scale is identity; the renderer ignores it until Wave 3).
//
// REF: PLAN.md Wave 2 Task 5; THESIS §52; vyapti V4; hetvabhasa H25/H46 family.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { resolveEvaluatedMesh } from '../../app/resolveEvaluatedMesh';
import { migrateNodes, migrateProjectFormat } from './migrations';
import { ProjectSchema, type Project } from './schema';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

/** A serialized pre-this-phase (v1) BoxMesh project — NO scale param. */
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
  // Mirror loadProject (io.ts:64-75) exactly: real JSON round-trip → format
  // migration → schema parse → node migration.
  const raw = JSON.parse(JSON.stringify(obj));
  const formatMigrated = migrateProjectFormat(raw);
  const project = ProjectSchema.parse(formatMigrated);
  return migrateNodes(project);
}

function ctxAt(seconds: number) {
  return { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
}

describe('BoxMesh v1 → v2 scale migration (byte-identical render gate)', () => {
  it('steps version 1 → 2 and adds scale=identity', () => {
    const migrated = loadFromBytes(V1_BOX_PROJECT);
    const box = migrated.state.nodes.n_box;
    expect(box.version).toBe(2);
    expect((box.params as { scale?: unknown }).scale).toEqual([1, 1, 1]);
  });

  it('leaves every non-scale param byte-identical', () => {
    const migrated = loadFromBytes(V1_BOX_PROJECT);
    const p = migrated.state.nodes.n_box.params as Record<string, unknown>;
    const orig = V1_BOX_PROJECT.state.nodes.n_box.params;
    expect(p.size).toEqual(orig.size);
    expect(p.position).toEqual(orig.position);
    expect(p.rotation).toEqual(orig.rotation);
    expect(p.material).toEqual(orig.material);
  });

  it('renders identically — evaluated geometry size unchanged, scale is identity', () => {
    const migrated = loadFromBytes(V1_BOX_PROJECT);
    const mesh = resolveEvaluatedMesh(migrated.state, 'n_box', ctxAt(0));
    expect(mesh).not.toBeNull();
    expect(mesh!.geometry.descriptor).toEqual({ kind: 'box', size: [2, 3, 4] });
    expect(mesh!.transform.scale).toEqual([1, 1, 1]); // identity → renderer no-op
    expect(mesh!.transform.position).toEqual([1, 0, -1]);
  });

  it('is idempotent — re-running the load path is a stable no-op', () => {
    const once = loadFromBytes(V1_BOX_PROJECT);
    // Re-serialize the migrated project and load again (the round-trip the user
    // hits on every subsequent save/load). nodeVersions now records BoxMesh: 2.
    const twice = loadFromBytes(once);
    expect(twice.state.nodes.n_box).toEqual(once.state.nodes.n_box);
    expect(twice.state.nodes.n_box.version).toBe(2);
  });
});
