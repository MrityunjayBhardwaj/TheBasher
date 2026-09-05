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
import { registerAllNodes } from '../../nodes/registerAll';
import { MemoryStorage } from '../storage';
import { resolveEvaluatedMesh } from '../../app/resolveEvaluatedMesh';
import { assignedMaterials, primaryMaterial } from '../../app/materialAssignment';
import { boxDescriptor } from '../../app/modifierGeometry';
import { mintMeshAttributes } from '../../nodes/meshAttributes';
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
 *  strings side by side.
 *
 *  🔴 #638 RE-KEYED THE BOX, DELIBERATELY, AND THE TWO ROWS ARE NOT THE SAME KIND OF PIN.
 *
 *  `n_box` — a box's key is DERIVED from its node params at every `evaluate()` and is
 *  stored nowhere: `GeometryDescriptor` appears in no `ProjectSchema` member and `io.ts`
 *  has zero geometry hits. So folding the attribute component into it re-keys a runtime
 *  cache and nothing else — no persisted byte moves, and no saved project needs a
 *  migration. The row is restated with the component derived from the same mint the
 *  producer uses, rather than as a hash literal no reader could check.
 *
 *  `n_ns1_sphere` — a BAKED key is a different animal and this row is the actual gate.
 *  `bakedGeometryKey(hash, vertexCount)` also indexes the OPFS path the bytes live at, so
 *  moving it orphans every persisted baked mesh in every project, silently: the load finds
 *  nothing at the new address and the mesh simply does not arrive. It stays a frozen
 *  literal. Structurally it is also safe by construction — `faceCountOf` is `null` for
 *  `baked` and `gltf`, so neither can carry an attribute component at all — but "safe by
 *  construction" is a claim, and this literal is what tests it. */
const EXPECTED_GEOMETRY_KEYS: Record<string, string> = {
  n_box: `box|1,1,1|a:${mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate')}`,
  n_ns1_sphere: 'baked|7e1cd74f-425',
};

describe('#637 this phase ships no migration, and the absence is pinned', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('has moved the project format version exactly once since the freeze, and #915 is that once', () => {
    // 🔴 THIS ROW CHANGED SHAPE IN #915, AND THE HEADER ABOVE SAYS WHY IT MAY.
    //
    // It read `toBe(fixture().formatVersion)` — ns-1 shipped no migration, so the frozen
    // bytes and the live constant were equal. #915 ships one (v9 → v10: dropping the
    // channels the retired eager bake wrote and nobody authored), so that equality is now
    // false and SHOULD be: this file's own instruction for a phase that does need a
    // migration is to write it and update the number in the same commit, never to relax
    // the comparison.
    //
    // So the pin is restated, not loosened. The fixture cannot be regenerated — it is
    // frozen app output — so the distance between it and live is the thing to pin, and it
    // is still an exact equality against those frozen bytes. A SECOND unplanned bump reds
    // this row again, which is the whole point of having it.
    const MIGRATIONS_SINCE_FREEZE = 1; // #915 only
    expect(PROJECT_FORMAT_VERSION).toBe(fixture().formatVersion + MIGRATIONS_SINCE_FREEZE);
  });

  it('the frozen project still loads through the new ladder, and #915 finds nothing to drop', () => {
    // The bump is only safe because the migration is a NO-OP on this fixture: it carries no
    // glTF rig, so there is no bone channel for the pass to examine, let alone remove. Said
    // as an assertion rather than left to the geometry row below to imply — a migration that
    // silently deleted a node here would still resolve the same two meshes.
    const before = fixture().state.nodes;
    const channelsInFixture = Object.values(before).filter(
      (n) => n.type === 'KeyframeChannelVec3',
    ).length;
    expect(channelsInFixture).toBe(0);
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
