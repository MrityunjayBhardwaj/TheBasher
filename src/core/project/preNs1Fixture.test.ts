// ns-1 wave 0, step 1 — the PRE-PHASE project fixture, and the gate that keeps it loadable.
//
// WHY THIS EXISTS, AND WHY IT HAD TO BE CAPTURED FIRST
//
// The attribute-domain phase changes what a geometry value carries. Anything that
// changes a shape which lives in saved data fails SILENTLY: an old project does not
// error, the affected thing is simply absent. A mesh loads with no UVs, a material
// assignment is quietly gone, nothing throws, and the damage is found by a user
// opening a project they made last month.
//
// The defence against that is a real pre-change save. It has to be captured BEFORE
// the change lands, because once the shape has moved, a "pre-phase" save can only be
// reconstructed from belief about what the old shape was — which produces a fixture
// that agrees with the new code by construction and therefore tests nothing.
//
// So `__fixtures__/pre-ns1-project.json` is NOT hand-written. It is the byte output of
// the running app: a scene built through the real op paths in a browser, saved through
// the same `saveCurrent()` seam the File > Save menu item calls, and read back out of
// OPFS. It is read-only forever. Nothing regenerates it — a regenerated fixture is a
// fixture that has silently agreed to whatever the code does now.
//
// WHAT IS IN IT, and why each member is there:
//   - `n_box_data`         BoxData     — a primitive carrying a `material` param
//   - `n_ns1_sphere__data` BakedData   — a baked mesh (geometry as an OPFS HANDLE)
//   - `n_gltfChild_*`      GltfChild   — an imported glTF mesh with captured materials
// Those are the three producers whose material/UV reads this phase touches. A fixture
// with only a primitive would pass every assertion here while saying nothing about the
// two paths that actually differ.
//
// This file asserts only that the fixture LOADS. The O(scene) size gate that rides on
// the same bytes is #631, in `saveIsOScene.gate.test.ts` — a separate concern with a
// separate failure message.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { MemoryStorage } from '../storage';
import { loadProject, projectPath } from './io';
import { PROJECT_FORMAT_VERSION } from './schema';
import { readPreNs1FixtureBytes } from '../../../tools/gates/preNs1Fixture';

describe('ns-1 pre-phase fixture', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('was captured at a format version no newer than the current one', () => {
    const raw = JSON.parse(readPreNs1FixtureBytes().toString('utf8')) as { formatVersion: number };
    // If this reds, the fixture was regenerated against newer code — which is exactly
    // the failure it exists to prevent. Do not "fix" it by re-capturing.
    expect(raw.formatVersion).toBeLessThanOrEqual(PROJECT_FORMAT_VERSION);
  });

  it('carries all three producers this phase touches', () => {
    const raw = JSON.parse(readPreNs1FixtureBytes().toString('utf8')) as {
      state: { nodes: Record<string, { type: string }> };
    };
    const kinds = new Set(Object.values(raw.state.nodes).map((n) => n.type));
    // Named individually rather than as a count, so a fixture that loses one member and
    // gains another cannot stay green.
    expect(kinds.has('BoxData'), 'primitive with a material').toBe(true);
    expect(kinds.has('BakedData'), 'baked mesh').toBe(true);
    expect(kinds.has('GltfChild'), 'imported glTF mesh').toBe(true);
  });

  it('loads through the real loadProject seam — format ladder, schema, node ladder and all', async () => {
    const storage = new MemoryStorage();
    const bytes = readPreNs1FixtureBytes();
    const raw = JSON.parse(bytes.toString('utf8')) as { id: string };
    await storage.write(projectPath(raw.id), new Uint8Array(bytes));

    // The real production path: JSON decode → migrateProjectFormat → ProjectSchema.parse
    // → migrateNodes → repairAndWarn. Not a schema parse of a hand-built object.
    const project = await loadProject(storage, raw.id);

    expect(project.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    const kinds = new Set(Object.values(project.state.nodes).map((n) => n.type));
    expect(kinds.has('BoxData')).toBe(true);
    expect(kinds.has('BakedData')).toBe(true);
    expect(kinds.has('GltfChild')).toBe(true);
  });

  it('resolves the material each producer carries, so a later phase cannot drop one silently', async () => {
    const storage = new MemoryStorage();
    const bytes = readPreNs1FixtureBytes();
    const raw = JSON.parse(bytes.toString('utf8')) as { id: string };
    await storage.write(projectPath(raw.id), new Uint8Array(bytes));
    const project = await loadProject(storage, raw.id);

    const nodes = Object.values(project.state.nodes);
    const box = nodes.find((n) => n.type === 'BoxData');
    const baked = nodes.find((n) => n.type === 'BakedData');
    const gltfChild = nodes.find((n) => n.type === 'GltfChild');

    // This is the assertion that has to survive #636. Today each producer carries its
    // material in its own param shape; the phase's whole point is that they stop doing
    // so independently. When that lands, this test tells you which producer lost it.
    expect(box?.params.material, 'BoxData.material').toBeDefined();
    expect(baked?.params.material, 'BakedData.material').toBeDefined();
    expect(gltfChild?.params.materials, 'GltfChild.materials').toBeDefined();
  });
});
