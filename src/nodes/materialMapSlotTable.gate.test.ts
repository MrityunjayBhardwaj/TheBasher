// #1324 — the material map slots are stated once (`MATERIAL_MAP_SLOT_TABLE`, types.ts) and every
// consumer derives from it. These rows pin the three things that make that safe: no second list
// exists, a saved material keeps its identity, and a slot added later is optional (absent means
// off) at every stage it passes through.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MATERIAL_MAP_SLOT_TABLE } from './types';
import type { BakedTextureRef, MaterialMapSlotRow } from './types';
import {
  bakedMapsOf,
  hydrateInlineMaterial,
  hydrateMapsFor,
  mapsSchemaFor,
  NULL_BAKED_MAPS,
  NULL_MAPS,
} from './materialSchema';
import { materialKeyOf } from './materialKey';

const SRC = join(__dirname, '..');

/** Every production source file under src/ — tests, gates and throwaway probes excluded. */
function productionFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return productionFiles(path);
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name) || name.startsWith('tmp-')) return [];
    return [path];
  });
}

/** Comments out, so a file that DISCUSSES the slots is not read as one that lists them. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const rows = Object.entries(MATERIAL_MAP_SLOT_TABLE);
/** A file lists the slots when it spells EVERY one of them in a vocabulary. */
const spellsAll = (code: string, words: string[]) => words.every((w) => code.includes(w));
const irSpellings = rows.map(([slot]) => new RegExp(`\\b${slot}\\s*:`));
const threeSpellings = rows.map(([, row]) => `'${row.three}'`);

describe('the material map slot table (#1324)', () => {
  it('no production file but the table spells the whole slot list, in either vocabulary', () => {
    const files = productionFiles();
    // The denominator: a walk that read nothing would agree with everything.
    expect(files.length).toBeGreaterThan(300);
    const listing = files.filter((f) => {
      const code = stripComments(readFileSync(f, 'utf8'));
      return irSpellings.every((re) => re.test(code)) || spellsAll(code, threeSpellings);
    });
    expect(listing.map((f) => relative(SRC, f))).toEqual([
      'core/import/gltfJsonMaterialToOpenpbr.ts',
      'nodes/types.ts',
    ]);
  });

  it('the one other listing is per-slot glTF knowledge, typed over every slot of the table', () => {
    // `IR_SLOT_SOURCES` names the glTF path each slot is read from: knowledge the table does not
    // hold, not a copy of its list. It is allowed above ONLY because it is keyed by every table
    // slot (`-?` over the maps' keys), so a slot it lacks or invents is a type error, not drift.
    const code = readFileSync(join(SRC, 'core/import/gltfJsonMaterialToOpenpbr.ts'), 'utf8');
    expect(code).toMatch(
      /const IR_SLOT_SOURCES: \{\s*readonly \[K in keyof InlineMaterialMaps\]-\?:/,
    );
  });

  it('a saved textured material keeps the identity key it had before the table', () => {
    // Pinned literally: `materialKeyOf` walks keys in insertion order and the schema inserts the
    // slots in the table's order, so reordering or seeding a row moves this string.
    const ref = {
      hash: 'abc',
      colorSpace: 'srgb-linear',
      flipY: false,
      wrapS: 'repeat',
      wrapT: 'repeat',
    };
    expect(materialKeyOf(hydrateInlineMaterial({ maps: { normal: ref } }))).toBe(
      '{base:{color:#cccccc,metalness:0,},specular:{roughness:0.3,ior:1.5,},coat:{weight:0,roughness:0,},transmission:{weight:0,},emission:{color:#000000,luminance:0,},geometry:{opacity:1,},maps:{albedo:n,normal:{hash:abc,colorSpace:srgb-linear,flipY:false,wrapS:repeat,wrapT:repeat,},roughness:n,metalness:n,emissive:n,ao:n,},uvTransform:{tiling:[1,1,],offset:[0,0,],rotation:0,},}',
    );
  });

  it('the empty maps are exactly the seeded slots, in both vocabularies', () => {
    const seeded = rows.filter(([, r]) => r.seeded);
    expect(Object.keys(NULL_MAPS)).toEqual(seeded.map(([slot]) => slot));
    expect(Object.keys(NULL_BAKED_MAPS)).toEqual(seeded.map(([, r]) => r.three));
  });

  describe('a slot added later is optional at every stage (minted: the live table has none yet)', () => {
    // The day a lobe's texture slot is appended, it must not seed `null` into every material:
    // a materialised key re-keys every save. So the state is minted by hand here.
    const later: MaterialMapSlotRow = {
      three: 'clearcoatMap',
      colorSpace: 'srgb-linear',
      seeded: false,
      label: 'clearcoat',
    };
    const widened = { ...MATERIAL_MAP_SLOT_TABLE, coat: later };
    const ref: BakedTextureRef = {
      hash: 'h',
      colorSpace: 'srgb-linear',
      flipY: false,
      wrapS: 'repeat',
      wrapT: 'repeat',
    };

    it('schema: absent stays absent, a held texture is kept, the seeded six still default', () => {
      const schema = mapsSchemaFor(widened);
      const empty = schema.parse({});
      expect(Object.keys(empty)).toEqual(Object.keys(NULL_MAPS));
      expect(schema.parse({ coat: ref }).coat).toEqual(ref);
    });

    it('hydrate: a save without the slot hydrates to the key it has today', () => {
      const saved = { albedo: ref };
      const today = hydrateMapsFor(saved, MATERIAL_MAP_SLOT_TABLE);
      expect(hydrateMapsFor(saved, widened)).toEqual(today);
      expect(materialKeyOf(hydrateMapsFor(saved, widened))).toBe(materialKeyOf(today));
      expect(hydrateMapsFor({ ...saved, coat: ref }, widened).coat).toEqual(ref);
    });

    it('bake: the slot is written only when it holds a texture', () => {
      expect(bakedMapsOf(() => null, widened)).not.toHaveProperty('clearcoatMap');
      expect(
        bakedMapsOf((s) => (s === ('clearcoatMap' as never) ? ref : null), widened),
      ).toHaveProperty('clearcoatMap', ref);
    });
  });
});
