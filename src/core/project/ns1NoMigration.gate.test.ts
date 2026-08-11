// #637 (ns-1) — THE MIGRATION DECISION, recorded as an assertion instead of as a belief.
//
// ── THE DECISION, AND WHY IT IS NOT AN OMISSION ───────────────────────────────────────
//
// This phase ships NO migration, and that is the correct outcome rather than a missing step.
// The reason is measurable: the geometry descriptor is never serialized. It is minted fresh
// from node params on every evaluation and appears in no member of the project schema, so
// there is no old descriptor in any save file to read and convert. What IS persisted is node
// params — and this phase changed none of their shapes. The face-domain material index and
// the corner-domain UV attribute are both DERIVED at read or evaluate time from params that
// did not move.
//
// An issue in this epic opens by asserting the opposite ("the descriptor is serialized into
// the DAG, and the DAG state IS the save format"). That sentence was measured false; the
// issue now carries the correction. This gate is what keeps the corrected version true.
//
// ── WHY THIS IS NOT A VACUOUS ASSERTION ───────────────────────────────────────────────
//
// "Nothing changed" is exactly the kind of claim that passes by reading a constant it also
// defines. Every number here is a comparison between TWO INDEPENDENT SOURCES: bytes frozen
// on disk before the phase began, and live code as it stands now. The fixture cannot be
// regenerated — it is the byte output of the running app, captured before any attribute code
// existed — so the two can only agree by the format genuinely not having moved.
//
// A future phase that DOES need a migration will red this file. That is the intended
// behaviour and the correct response is to write the migration and update these numbers in
// the same commit, with this fixture as its gate — never to relax the comparison.
//
// REF: tools/gates/preNs1Fixture.ts (the frozen bytes);
//      src/core/project/preNs1Fixture.test.ts (the load gate this rides beside);
//      src/core/project/schema.ts + migrations.ts (the two ladders);
//      .anvi/project_management/phases/ns-1-attribute-domains/PLAN.md §5.1, §5.2;
//      issues #637, #636, #395.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, getNodeType } from '../dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { MemoryStorage } from '../storage';
import { resolveEvaluatedMesh } from '../../app/resolveEvaluatedMesh';
import { assignedMaterials, primaryMaterial } from '../../app/materialAssignment';
import { loadProject, projectPath } from './io';
import { PROJECT_FORMAT_VERSION } from './schema';
import { readPreNs1FixtureBytes } from '../../../tools/gates/preNs1Fixture';
import type { EvalCtx } from '../dag/types';

interface FixtureShape {
  readonly id: string;
  readonly formatVersion: number;
  readonly state: { readonly nodes: Record<string, { readonly type: string; version?: number }> };
}

const fixture = (): FixtureShape =>
  JSON.parse(readPreNs1FixtureBytes().toString('utf8')) as FixtureShape;

const CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** The two MESH-bearing Objects in the frozen scene (its camera and light pose nothing with
 *  geometry), and the key each must still resolve to. Literals, because the fixture is frozen and the key templates are pinned elsewhere:
 *  a change that re-keys an existing project's geometry reds here with the old and new
 *  strings side by side. */
const EXPECTED_GEOMETRY_KEYS: Record<string, string> = {
  n_box: 'box|1,1,1',
  n_ns1_sphere: 'baked|7e1cd74f-425',
};

describe('#637 this phase ships no migration, and the absence is pinned', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  it('did not move the project format version', () => {
    // Frozen bytes vs live constant. Equal, not merely "no newer" — the load gate beside
    // this one already allows the fixture to lag; this one says it does not.
    expect(PROJECT_FORMAT_VERSION).toBe(fixture().formatVersion);
  });

  it('did not move any node’s version', () => {
    const recorded = new Map<string, number | undefined>();
    for (const node of Object.values(fixture().state.nodes)) {
      recorded.set(node.type, node.version);
    }
    expect(recorded.size).toBeGreaterThan(0); // a loop that never ran reports clean

    const moved: string[] = [];
    for (const [type, version] of recorded) {
      const live = getNodeType(type)?.version;
      if (live !== version) moved.push(`${type}: fixture ${version} → registry ${live}`);
    }
    expect(moved).toEqual([]);
  });

  it('loads and resolves to the SAME geometry as before the phase', async () => {
    const storage = new MemoryStorage();
    const bytes = readPreNs1FixtureBytes();
    await storage.write(projectPath(fixture().id), new Uint8Array(bytes));
    const project = await loadProject(storage, fixture().id);

    for (const [nodeId, key] of Object.entries(EXPECTED_GEOMETRY_KEYS)) {
      const mesh = resolveEvaluatedMesh(project.state, nodeId, CTX);
      expect(mesh, `${nodeId} no longer resolves to a mesh`).not.toBeNull();
      expect(mesh!.geometry.key, `${nodeId} re-keyed`).toBe(key);
    }
  });

  it('reads the old project’s materials through the attribute system, unchanged', async () => {
    const storage = new MemoryStorage();
    const bytes = readPreNs1FixtureBytes();
    await storage.write(projectPath(fixture().id), new Uint8Array(bytes));
    const project = await loadProject(storage, fixture().id);

    // The point of the whole phase, checked against a project saved before any of it
    // existed: every mesh in it still reports exactly one material, and reports it.
    for (const nodeId of Object.keys(EXPECTED_GEOMETRY_KEYS)) {
      const mesh = resolveEvaluatedMesh(project.state, nodeId, CTX)!;
      expect(assignedMaterials(mesh.materials), `${nodeId} material count`).toHaveLength(1);
      expect(primaryMaterial(mesh.materials), `${nodeId} material`).not.toBeNull();
    }
  });
});
