// #1062 — a REAL format-13 save whose materials address a UV set by NUMBER and vertex colours by a
// BOOLEAN, and the gate that keeps it meaning the same after both become layer names.
//
// ── WHY IT WAS CAPTURED BEFORE THE CHANGE ─────────────────────────────────────────────────────
//
// The same defence `polyMeshV1Fixture.test.ts` states: a change to a shape that lives in saved data
// fails silently. An old project does not error — its map simply samples the wrong UV set, or its
// mesh quietly stops asking for its colours. A fixture written after the shape moved agrees with
// the new code by construction and tests nothing, so this one is the byte output of the running app
// on `ec0041f8`, imported through the product's own ingest road and saved by its own autosave.
//
// It holds all three cases in one file:
//   - `TwoUvQuadMat`  → a base-colour map sampling the file's TEXCOORD_1 (`mapUvSets.albedo = 1`)
//   - `VColorMat`     → a mesh with COLOR_0 (`geometry.vertexColors = true`)
//   - `BoxData`       → a native material that asks for neither (the control)
//
// ── WHY THE ORACLE NAMES NEITHER SPELLING ─────────────────────────────────────────────────────
//
// The questions worth asking are "does the albedo map sample the SECOND UV set?" and "does this
// material ask for the mesh's colours?" — both of which have the same answer before and after the
// representation changes. So the readers below accept EITHER spelling (a number today, a layer name
// after #1062) and report what was asked for, never how it was written. If a migration drops the
// old key without writing the new one, they report `none` and this gate reds — which is the whole
// point of capturing the file first.
//
// REF: tools/gates/materialLayersV13Fixture.ts (the reader); src/core/project/migrations.ts (the
//      ladder); ref/GROUND_TRUTH_BLENDER_ATTRIBUTE_NAMING.md (why layers are named at all);
//      issues #1062, #1117.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { MemoryStorage } from '../storage';
import { loadProject, projectPath } from './io';
import { PROJECT_FORMAT_VERSION } from './schema';
import { readMaterialLayersV13FixtureBytes } from '../../../tools/gates/materialLayersV13Fixture';

interface RawMaterial {
  readonly name?: string;
  readonly mapUvSets?: Record<string, unknown>;
  readonly mapUvLayers?: Record<string, unknown>;
  readonly geometry?: { readonly vertexColors?: unknown; readonly colorLayer?: unknown };
}

interface RawProject {
  readonly id: string;
  readonly formatVersion: number;
  readonly state: {
    readonly nodes: Record<string, { type: string; params: { material?: RawMaterial } }>;
  };
}

function raw(): RawProject {
  return JSON.parse(readMaterialLayersV13FixtureBytes().toString('utf8')) as RawProject;
}

/** Blender's name for the nth UV set, which is what a layer-naming material says (#1062). */
const SECOND_UV_LAYER = 'UVMap.001';

/**
 * Which UV set the albedo map samples, read from whichever spelling the material uses.
 * `none` means it named no set at all — including the case where a migration dropped the old
 * key and wrote nothing in its place.
 */
function albedoUvSet(material: RawMaterial | undefined): 'first' | 'second' | 'other' | 'none' {
  const byName = material?.mapUvLayers?.albedo;
  if (typeof byName === 'string') {
    if (byName === SECOND_UV_LAYER) return 'second';
    return byName === 'UVMap' ? 'first' : 'other';
  }
  const byNumber = material?.mapUvSets?.albedo;
  if (typeof byNumber === 'number') {
    if (byNumber === 1) return 'second';
    return byNumber === 0 ? 'first' : 'other';
  }
  return 'none';
}

/** Whether the material asks for the mesh's colours, in whichever spelling it uses. */
function asksForColours(material: RawMaterial | undefined): boolean {
  const named = material?.geometry?.colorLayer;
  if (typeof named === 'string') return named.length > 0;
  return material?.geometry?.vertexColors === true;
}

function materialsByName(project: {
  state: { nodes: Record<string, { params: unknown }> };
}): Map<string, RawMaterial> {
  const out = new Map<string, RawMaterial>();
  for (const node of Object.values(project.state.nodes)) {
    const material = (node.params as { material?: RawMaterial }).material;
    if (material && typeof material === 'object' && typeof material.name === 'string') {
      out.set(material.name, material);
    }
  }
  return out;
}

async function loaded() {
  const storage = new MemoryStorage();
  await storage.write(projectPath(raw().id), new Uint8Array(readMaterialLayersV13FixtureBytes()));
  return loadProject(storage, raw().id);
}

describe('#1062 format-13 material fixture', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('was captured at format 13, holding a numeric UV set and a boolean colour flag', () => {
    const project = raw();
    // If any of these reds, the fixture was regenerated against newer code — the exact failure it
    // exists to prevent. Do not "fix" it by re-capturing.
    expect(project.formatVersion).toBe(13);
    expect(project.formatVersion).toBeLessThanOrEqual(PROJECT_FORMAT_VERSION);
    const materials = materialsByName(project);
    expect(materials.get('TwoUvQuadMat')?.mapUvSets).toEqual({ albedo: 1 });
    expect(materials.get('VColorMat')?.geometry?.vertexColors).toBe(true);
  });

  it('loads through the real loadProject seam, still sampling the second UV set', async () => {
    const project = await loaded();
    expect(project.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    const materials = materialsByName(project);
    expect(materials.has('TwoUvQuadMat'), 'the material survives the load').toBe(true);
    expect(albedoUvSet(materials.get('TwoUvQuadMat'))).toBe('second');
  });

  it('loads with the vertex-coloured material still asking for the mesh’s colours', async () => {
    const materials = materialsByName(await loaded());
    expect(materials.has('VColorMat'), 'the material survives the load').toBe(true);
    expect(asksForColours(materials.get('VColorMat'))).toBe(true);
  });

  it('leaves the native material asking for neither — it never had either', async () => {
    const materials = materialsByName(await loaded());
    const box = materials.get('default');
    expect(box, 'the box material survives the load').toBeDefined();
    expect(albedoUvSet(box)).toBe('none');
    expect(asksForColours(box)).toBe(false);
  });
});
