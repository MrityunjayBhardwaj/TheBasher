// #646 — the imported-material-array road, and why the guard over it is DEAD TODAY.
//
// ── WHAT THIS GATE HOLDS ───────────────────────────────────────────────────────────────
//
// `SceneFromDAG.tsx` refuses to overlay a DAG-authored material onto an imported mesh whose
// `material` is an ARRAY (`if (childId && !Array.isArray(src))`). #646 reads that guard as a
// live limitation: "a glTF child with a material array cannot receive a DAG material at all".
//
// Measured, that premise is false on every import road this repo has — for two DIFFERENT
// reasons, which is exactly why one row could not hold it:
//
//   glTF — three never BUILDS an array material. A multi-primitive mesh becomes a `Group` of
//          single-material `Mesh`es, so each primitive arrives as its own addressable slot.
//   FBX  — three's FBX loader DOES build one (`FBXLoader.js`, `if (materials.length > 1)`).
//          Since #1429 Basher imports FBX meshes, and the array stops at the reader: each slot
//          becomes a stored slot (name, colour, roughness) and each face its `material_index`, the
//          native road a multi-primitive glTF takes (#1052). No three material is kept.
//
// So the array state is unreachable, and the capability #646 asks for was delivered instead by
// the Group road plus per-slot IR addressing (row C).
//
// ── WHY A GATE AND NOT A COMMENT ON THE ISSUE ─────────────────────────────────────────────
//
// Because the argument is entirely made of facts that live in OTHER people's code — a vendored
// loader and an import module that is explicitly staged for a later wave. Prose asserting them
// starts rotting the moment it is written, and this cluster has already been bitten by exactly
// that: #647's "what the fix requires" describes a widening that had already shipped.
//
// Row B was a TRIPWIRE for the day Basher imported FBX meshes. That day came (#1429), and it
// fired as designed. By then the guard it watched had gone with the clone renderer (#1053, row
// C), so what the row now pins is the reason no array reaches a draw: the FBX reader's result
// holds SLOTS, plain data, and never a three material.
//
// ── THE FAILURE MODE THIS GATE IS BUILT AGAINST ───────────────────────────────────────────
//
// A census that examined nothing and printed success. Every row therefore asserts a
// DENOMINATOR before it asserts a count, and every "zero" is paired with a positive assertion
// that the road it is counting over still exists — a zero over a file that moved is not
// evidence of safety, it is evidence of a broken probe. Row D is the control on the parsers.
//
// REF: src/viewport/SceneFromDAG.tsx (the guard + the per-slot road it was replaced by);
//      src/core/import/fbx.ts (what the FBX road actually carries);
//      tests/e2e/p06-2-per-submesh.spec.ts (the live proof of per-slot addressing over a real
//      two-primitive fixture); issues #646, #638, #691.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../test-utils/sourceScan';

const REPO = join(__dirname, '..', '..');
const THREE_LOADERS = join(REPO, 'node_modules', 'three', 'examples', 'jsm', 'loaders');

const read = (...p: string[]): string => readFileSync(join(...p), 'utf8');
const lines = (s: string): number => s.split('\n').length;

/**
 * The brace-matched body of `export interface <name> { … }`, comment-stripped.
 *
 * Local rather than imported: the sibling copy lives in `materialKeyReach.gate.test.ts`, and
 * importing a spec file RE-REGISTERS its `describe`/`it` blocks into this suite — the unit
 * count defect `tools/gates/sourceFiles.ts` records in its own header. A twenty-line helper is
 * the cheaper of the two duplications.
 */
function interfaceBody(src: string, name: string): string | null {
  const stripped = stripComments(src);
  const head = new RegExp(`export interface ${name}\\b[^{]*\\{`).exec(stripped);
  if (!head) return null;
  let depth = 1;
  let i = head.index + head[0].length;
  const start = i;
  for (; i < stripped.length && depth > 0; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') depth--;
  }
  return depth === 0 ? stripped.slice(start, i - 1) : null;
}

/** The field names an interface body DECLARES, in source order. */
function declaredFields(body: string): string[] {
  return [...body.matchAll(/(?:^|\n)\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/g)].map(
    (m) => m[1],
  );
}

describe('#646 — an imported mesh cannot carry a material ARRAY, on any road that exists', () => {
  it('A. three’s glTF loader builds no array material — multi-primitive becomes a Group', () => {
    const src = read(THREE_LOADERS, 'GLTFLoader.js');
    // DENOMINATOR FIRST. A zero from a file that failed to load is not a measurement.
    expect(lines(src)).toBeGreaterThan(4000);
    const stripped = stripComments(src);

    // The count that makes #646's premise false for glTF.
    expect([...stripped.matchAll(/\.material\s*=\s*\[/g)]).toHaveLength(0);

    // …and the road that stands in its place, asserted POSITIVELY. Without this, the zero
    // above would still pass if three deleted the mesh-building path entirely, and the gate
    // would report safety over a loader that no longer does the thing at all.
    expect(/if\s*\(\s*meshes\.length\s*===\s*1\s*\)/.test(stripped)).toBe(true);
    expect(/const\s+group\s*=\s*new\s+Group\(\)/.test(stripped)).toBe(true);
  });

  it('B. (#1429) Basher’s FBX import reads three’s array into stored slots and keeps no material', () => {
    // three's FBX loader DOES build the array (`if ( materials.length > 1 ) material = materials`).
    const loader = read(THREE_LOADERS, 'FBXLoader.js');
    expect(lines(loader)).toBeGreaterThan(3000);
    expect(/materials\.length\s*>\s*1/.test(stripComments(loader))).toBe(true);

    const src = read(REPO, 'src', 'core', 'import', 'fbxMesh.ts');
    expect(lines(src)).toBeGreaterThan(50);
    // What a mesh's materials are once read: a slot is a name, a colour, a roughness and (#1434)
    // the images it samples, each an index into the file's images and a clamp. A field holding a
    // three material or texture here would carry the array past the reader.
    const slot = interfaceBody(src, 'FbxMaterialSlot');
    expect(slot).not.toBeNull();
    expect(declaredFields(slot as string)).toEqual([
      'name',
      'color',
      'roughness',
      'baseColorImage',
      'normalImage',
    ]);
    const image = interfaceBody(src, 'FbxSlotImage');
    expect(image).not.toBeNull();
    expect(declaredFields(image as string)).toEqual(['image', 'clamp']);
    const mesh = interfaceBody(src, 'FbxMeshRead');
    expect(mesh).not.toBeNull();
    expect(/\bmaterials\s*:\s*readonly\s+FbxMaterialSlot\[\]/.test(mesh as string)).toBe(true);

    // And the chain writes them as the native slots, the multi-primitive glTF road's shape.
    const chain = stripComments(read(REPO, 'src', 'core', 'import', 'fbxImportChain.ts'));
    expect(/materialSlots\s*:\s*slots/.test(chain)).toBe(true);
    for (const file of [src, chain]) {
      expect(/new\s+Mesh\s*\(/.test(stripComments(file))).toBe(false);
      expect(/\.material\s*=/.test(stripComments(file))).toBe(false);
    }
  });

  // C. (#1053) The clone renderer's per-slot addressing (`localSlotByChild`, `irs?.[local]`,
  // `targetSlot === slotIdx`) and its array guard were deleted with the clone road: a kept clone
  // import is not drawn. A multi-primitive import is native now, its slots on the mesh (#1052).

  it('D. guards the guard — the parsers read code, not prose about it', () => {
    // A mention inside a comment must not count as an assignment, or row A would report a
    // violation the day someone DOCUMENTS the array road.
    expect(
      /\.material\s*=\s*\[/.test(stripComments('/* m.material = [a, b] */ const x = 1;')),
    ).toBe(false);
    expect(/\.material\s*=\s*\[/.test(stripComments('m.material = [a, b];'))).toBe(true);

    // Brace matching: a nested object type must not end the body early, which would hide
    // every field after it and make row B's equality pass over a SHORTER list.
    const nested = 'export interface X {\n  readonly a: { b: string };\n  readonly c: Y;\n}\n';
    expect(declaredFields(interfaceBody(nested, 'X') as string)).toEqual(['a', 'c']);

    // A name that is not there returns null rather than an empty body that reads as "declares
    // nothing" — the difference between "no fields" and "no interface".
    expect(interfaceBody('export interface Other { a: 1 }', 'X')).toBeNull();
  });
});
