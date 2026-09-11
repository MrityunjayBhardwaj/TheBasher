// #662 — ADDING A FORMAT AND FORGETTING A SITE NOW REDS.
//
// The four-format set used to be written by hand at nine sites, none of which routed through
// the dispatcher and six of which failed SILENTLY when a format was missed. The existing
// tests could not catch that: they are behavioural, they prove that one extension routes,
// and they stay green when a fifth format is added and half the product never hears about
// it. This gate is the structural half.
//
// ── THE DISTINCTION THIS GATE TURNS ON, AND IT IS THE WHOLE DESIGN ────────────────────
//
// Not every mention of `.gltf` is a format-set decision, and a gate that pretended otherwise
// would be unusable — five modules legitimately distinguish a `.gltf` (text, with sibling
// `.bin`/textures) from a `.glb` (self-contained binary), because that is a CONTAINER
// question INSIDE one format, not a question about which format this is.
//
//   cross-format decision  → "which of the importable formats is this / is it importable"
//                            → belongs to the category, `importFormats.ts`
//   within-family decision → ".gltf text+siblings vs .glb binary"
//                            → legitimately local to a glTF module
//
// So the census does not ban the spelling; it declares WHICH FILE MAY SPELL WHICH
// EXTENSIONS, and reds on any file that spells one it has not declared. A new file that
// tests an importable extension reds because it is undeclared; a declared glTF module that
// starts testing `.bvh` reds because it has crossed families. Both are the failure #662
// describes, and neither was visible before.
//
// `importFormats.ts` needs no entry: it tests `endsWith(ext)` against a loop variable, so it
// spells no extension literally. The category is exempt by construction rather than by
// permission, which is the property that keeps this table from becoming a place to hide.
//
// ── MEASURED LIMIT, STATED SO THE NEXT READER DOES NOT OVERTRUST IT ───────────────────
//
// The alphabet is `endsWith('<ext>')`, and that is COMPLETE TODAY rather than in principle.
// Censused before writing this gate: every other way to reach an extension in this repo —
// `split('.').pop()`, `lastIndexOf('.')`, `extname`, a regex on the path — is used for
// basename/extension STRIPPING, never for importable-format dispatch. The one set-membership
// test spelled differently is `WebCodecsMediaDecode`'s `IMAGE_EXTS`, a different set
// (media clips) that already uses a named set rather than a chain. So:
//
//   a cross-format decision spelled some OTHER way is invisible to this gate.
//
// Path construction is also deliberately out of scope: `boot.ts` writes `${name}.bvh` for
// its two per-format e2e seams, and those seams are per-format by identity — the extension
// is in the function's own name. Naming a format is not deciding between formats.
//
// REF: issue #662; `importFormats.ts` (the category); `importBvhFbx.ts` (the exhaustive
//      dispatch map); `tools/gates/sourceFiles.ts` (#536, the shared census walk);
//      `src/test-utils/sourceScan.ts` (`stripComments`, so prose never trips a census);
//      CONTEXT D-03/D-04/D-05.

import { describe, it, expect } from 'vitest';
import { sourceFiles } from '../../../tools/gates/sourceFiles';
import { stripComments } from '../../test-utils/sourceScan';
import {
  IMPORT_EXTENSIONS,
  IMPORT_FORMATS,
  IMPORT_ACCEPT,
  MODEL_ACCEPT,
  UNSUPPORTED_FORMAT_MESSAGE,
  REF_PERSISTING_NODE_TYPES,
  importFormatOf,
  isImportablePath,
  isFamilyPath,
  pickEntryFile,
  type ImportExt,
} from './importFormats';

/**
 * Every file that may spell an importable extension, and the exact extensions it may spell.
 *
 * All five are glTF container logic. There is deliberately no motion entry: after #662 no
 * file outside the category tests `.bvh` or `.fbx` at all, because those tests were the
 * cross-format ones.
 */
const DECLARED_SPELLERS: Readonly<Record<string, readonly ImportExt[]>> = {
  // Ingest + sibling resolution: a `.gltf` entry needs its `.bin`/textures, a `.glb` does not.
  'src/app/asset/importGltf.ts': ['.gltf', '.glb'],
  // The lone-file escalation (a `.gltf` missing siblings) and the multi-`.glb` chooser.
  'src/app/asset/importPicker.ts': ['.gltf', '.glb'],
  // Loading from OPFS: only a `.gltf` needs the resolver rewired to sibling URIs.
  'src/app/asset/opfsLoader.ts': ['.gltf'],
  // KHR_materials_pbrSpecularGlossiness conversion differs by container.
  'src/app/asset/specGlossIngest.ts': ['.gltf', '.glb'],
  // Orphan-material rebind reads the container to find the material names.
  'src/core/import/rebindOrphanMaterials.ts': ['.gltf', '.glb'],
};

/** Which importable extensions a source text tests with `endsWith`. */
function spelledIn(src: string): ImportExt[] {
  const code = stripComments(src);
  return IMPORT_EXTENSIONS.filter((ext) =>
    new RegExp(`endsWith\\(\\s*'${ext.replace('.', '\\.')}'\\s*\\)`).test(code),
  );
}

describe('#662 — the importer category is the only place the format set is written', () => {
  it('declares a family, a unique entry priority and a ref answer for every extension', () => {
    for (const ext of IMPORT_EXTENSIONS) {
      const f = IMPORT_FORMATS[ext];
      expect(f, `${ext} has no IMPORT_FORMATS entry`).toBeDefined();
      expect(f.ext, `${ext}'s entry disagrees with its key`).toBe(ext);
      expect(['model', 'motion']).toContain(f.family);
    }
    const priorities = IMPORT_EXTENSIONS.map((e) => IMPORT_FORMATS[e].entryPriority);
    expect(new Set(priorities).size, 'two formats claim the same entry priority').toBe(
      priorities.length,
    );
  });

  it('derives every string a site used to spell by hand', () => {
    for (const ext of IMPORT_EXTENSIONS) {
      expect(IMPORT_ACCEPT, `${ext} missing from the picker accept list`).toContain(ext);
      expect(UNSUPPORTED_FORMAT_MESSAGE, `${ext} missing from the error hint`).toContain(ext);
      expect(isImportablePath(`a/b/thing${ext}`), `${ext} is not importable`).toBe(true);
      expect(importFormatOf(`X${ext.toUpperCase()}`), `${ext} fails case-insensitively`).toEqual(
        IMPORT_FORMATS[ext],
      );
    }
    // The model picker takes models and nothing else.
    for (const ext of IMPORT_EXTENSIONS) {
      expect(MODEL_ACCEPT.includes(ext)).toBe(IMPORT_FORMATS[ext].family === 'model');
    }
    expect(importFormatOf('notes.txt')).toBeNull();
    expect(isImportablePath('notes.txt')).toBe(false);
  });

  it('keeps the two orders separate — accept order is not entry priority', () => {
    // Declaration order drives the accept attribute…
    expect(IMPORT_ACCEPT).toBe('.gltf,.glb,.bvh,.fbx');
    // …and the My-Imports entry pick runs `.glb` FIRST, which is a different order. A
    // category that derived one from the other would silently change which file a mixed
    // folder surfaces, so this pins that they disagree on purpose.
    expect(pickEntryFile(['m.gltf', 'm.glb'])).toBe('m.glb');
    expect(pickEntryFile(['walk.fbx', 'walk.bvh'])).toBe('walk.bvh');
    expect(pickEntryFile(['m.gltf', 'walk.bvh'])).toBe('m.gltf');
    expect(pickEntryFile(['readme.txt'])).toBeNull();
  });

  it('derives the ref-persisting node types from the category (the silent-data-loss site)', () => {
    // Every model format persists under a node type; no motion format persists at all.
    for (const ext of IMPORT_EXTENSIONS) {
      const f = IMPORT_FORMATS[ext];
      if (f.family === 'model') {
        expect(f.persistsRefAs, `${ext} is a model but persists no ref`).not.toBeNull();
        expect(REF_PERSISTING_NODE_TYPES.has(f.persistsRefAs as string)).toBe(true);
      } else {
        expect(f.persistsRefAs, `${ext} is motion but claims a persistent ref`).toBeNull();
      }
    }
    // The set is exactly what the category declares — not a superset someone widened by hand.
    const declared = new Set(
      IMPORT_EXTENSIONS.map((e) => IMPORT_FORMATS[e].persistsRefAs).filter((t) => t !== null),
    );
    expect([...REF_PERSISTING_NODE_TYPES].sort()).toEqual([...declared].sort());
  });

  it('family tests answer for every extension, so no site needs its own', () => {
    for (const ext of IMPORT_EXTENSIONS) {
      const f = IMPORT_FORMATS[ext];
      expect(isFamilyPath(`x${ext}`, 'model')).toBe(f.family === 'model');
      expect(isFamilyPath(`x${ext}`, 'motion')).toBe(f.family === 'motion');
    }
    expect(isFamilyPath('x.txt', 'model')).toBe(false);
    expect(isFamilyPath('x.txt', 'motion')).toBe(false);
  });

  it('no undeclared file spells an importable extension', () => {
    const files = sourceFiles();
    expect(files.length, 'the census walk returned nothing — it never ran').toBeGreaterThan(400);

    const offenders: string[] = [];
    for (const [path, src] of files) {
      const spelled = spelledIn(src);
      if (spelled.length === 0) continue;
      const allowed = DECLARED_SPELLERS[path];
      if (!allowed) {
        offenders.push(`${path} spells ${spelled.join(' ')} but is not a declared speller`);
        continue;
      }
      const crossed = spelled.filter((e) => !allowed.includes(e));
      if (crossed.length > 0) {
        offenders.push(`${path} spells ${crossed.join(' ')}, outside its declared set`);
      }
    }
    expect(
      offenders,
      'A cross-format decision belongs in importFormats.ts (#662). If this is genuinely a ' +
        'within-family container decision, add the file to DECLARED_SPELLERS with the exact ' +
        'extensions it may spell, and say why in a comment.',
    ).toEqual([]);
  });

  it('every declared speller stays inside ONE family', () => {
    for (const [path, exts] of Object.entries(DECLARED_SPELLERS)) {
      const families = new Set(exts.map((e) => IMPORT_FORMATS[e].family));
      expect(
        families.size,
        `${path} spells across families — that is a cross-format decision`,
      ).toBe(1);
    }
  });

  it('every declared speller still exists and still spells what it claims', () => {
    // Chesterton in reverse: a stale allowlist entry is permission nobody is using, and it
    // would silently cover a future file that reused the path.
    const byPath = new Map(sourceFiles());
    for (const [path, exts] of Object.entries(DECLARED_SPELLERS)) {
      const src = byPath.get(path);
      expect(src, `${path} is declared but no longer exists`).toBeDefined();
      const spelled = spelledIn(src as string);
      expect(spelled.length, `${path} is declared but spells nothing — drop it`).toBeGreaterThan(0);
      for (const e of spelled) {
        expect(exts, `${path} declares ${exts.join(' ')} but spells ${e}`).toContain(e);
      }
    }
  });
});
