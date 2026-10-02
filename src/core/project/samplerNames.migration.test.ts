// #1316 — v18 → v19: a stored texture ref's sampler state by name.
//
// One field held two numberings: glTF's (the clone road stored the file's 10497) and three.js's (the
// native road, uploads and bakes stored 1000). This pass must turn both into the same name wherever a
// ref sits — a material's maps, a baked snapshot's slots, a slot table — recognise refs by shape, and
// leave anything that is not a ref alone.
//
// REF: src/core/project/migrations.ts (`migrateSamplerNames`); src/nodes/materialSchema.ts (the
//      two number tables); issue #1316.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateProjectFormat, migrateSamplerNames } from './migrations';
import { PROJECT_FORMAT_VERSION } from './schema';
import { openpbrMaterialSchema } from '../../nodes/materialSchema';

/** A migrated project's params, read by key. */
type Tree = { [k: string]: Tree };

const ref = (sampler: Record<string, number>) => ({
  hash: 'k.png',
  store: 'project',
  colorSpace: 'srgb',
  flipY: false,
  ...sampler,
});

function v18(nodes: Record<string, unknown>) {
  return { formatVersion: 18, state: { nodes } };
}

afterEach(() => vi.restoreAllMocks());

describe('#1316 — both old numberings become the same name', () => {
  it('three.js`s and glTF`s REPEAT/NEAREST read the same after the pass', () => {
    const out = migrateSamplerNames(
      v18({
        native: {
          params: {
            material: {
              maps: {
                albedo: ref({ wrapS: 1000, wrapT: 1001, magFilter: 1003, minFilter: 1008 }),
              },
            },
          },
        },
        clone: {
          params: {
            materials: [{ maps: { albedo: ref({ wrapS: 10497, wrapT: 33071 }) } }],
          },
        },
        baked: {
          params: {
            material: { map: ref({ wrapS: 33648, wrapT: 1002, magFilter: 9728, minFilter: 9987 }) },
          },
        },
      }),
    ) as { formatVersion: number; state: { nodes: Record<string, { params: Tree }> } };
    const n = out.state.nodes;
    expect(out.formatVersion).toBe(19);
    expect(n.native.params.material.maps.albedo).toMatchObject({
      wrapS: 'repeat',
      wrapT: 'clamp-to-edge',
      magFilter: 'nearest',
      minFilter: 'linear-mipmap-linear',
    });
    expect(n.clone.params.materials[0].maps.albedo).toMatchObject({
      wrapS: 'repeat',
      wrapT: 'clamp-to-edge',
    });
    expect(n.baked.params.material.map).toMatchObject({
      wrapS: 'mirrored-repeat',
      wrapT: 'mirrored-repeat',
      magFilter: 'nearest',
      minFilter: 'linear-mipmap-linear',
    });
  });

  it('runs on load, through the ladder', () => {
    const out = migrateProjectFormat(
      v18({ a: { params: { material: { maps: { albedo: ref({ wrapS: 1000, wrapT: 1000 }) } } } } }),
    ) as { formatVersion: number; state: { nodes: Record<string, { params: Tree }> } };
    // The ladder runs on to the live format; this step is the one that named the sampler.
    expect(out.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(out.state.nodes.a.params.material.maps.albedo.wrapS).toBe('repeat');
  });

  it('a migrated ref is one the schema accepts; an unmigrated number is refused by it', () => {
    const migrated = migrateSamplerNames(
      v18({ a: { params: { material: { maps: { albedo: ref({ wrapS: 1000, wrapT: 1000 }) } } } } }),
    ) as { state: { nodes: Record<string, { params: Tree }> } };
    expect(() =>
      openpbrMaterialSchema().parse(migrated.state.nodes.a.params.material),
    ).not.toThrow();
    expect(() =>
      openpbrMaterialSchema().parse({ maps: { albedo: ref({ wrapS: 1000, wrapT: 1000 }) } }),
    ).toThrow();
  });
});

describe('#1316 — what the pass leaves alone, and what it says', () => {
  it('an object that is not a texture ref keeps its numbers', () => {
    const out = migrateSamplerNames(
      v18({ a: { params: { sampler: { wrapS: 10497, magFilter: 9728 } } } }),
    ) as { state: { nodes: Record<string, { params: Tree }> } };
    expect(out.state.nodes.a.params.sampler).toEqual({ wrapS: 10497, magFilter: 9728 });
  });

  it('a number neither table knows takes the default and is named in the warning, not thrown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = migrateSamplerNames(
      v18({
        n_odd: {
          params: {
            material: { maps: { albedo: ref({ wrapS: 7, wrapT: 1000, magFilter: 9987 }) } },
          },
        },
      }),
    ) as { state: { nodes: Record<string, { params: Tree }> } };
    const albedo = out.state.nodes.n_odd.params.material.maps.albedo;
    expect(albedo.wrapS).toBe('repeat');
    // A mipmap filter is not a magnification filter: dropped, which means the renderer's default.
    expect('magFilter' in albedo).toBe(false);
    expect(warn.mock.calls[0][0]).toMatch(
      /2 held a number .*n_odd\.wrapS=7, n_odd\.magFilter=9987/,
    );
  });

  it('a project with no texture refs says nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    migrateSamplerNames(v18({ a: { params: { size: [1, 1, 1] } } }));
    expect(warn).not.toHaveBeenCalled();
  });
});
