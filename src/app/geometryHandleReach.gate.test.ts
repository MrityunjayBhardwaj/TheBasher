// #537 — the correspondence the handle rebuild rests on, machine-checked.
//
// ── THE ASSUMPTION, AND WHY IT NEEDS A GATE ────────────────────────────────────────────
//
// The repair folds written params into a geometry descriptor and re-mints the handle. It
// finds WHICH fields to fold by asking the descriptor for its own field names
// (`descriptorParamFields`) and matching them against the paths the overlay wrote — i.e. it
// relies on a descriptor field being named exactly like the param that feeds it. Measured
// true today: `size`; `radius`/`widthSegments`/`heightSegments`; `count`/`offset`;
// `axis`/`offset`.
//
// That correspondence is a fact about two files that do not import each other, which is
// precisely the kind of fact that stops being true quietly. Rename `size` to `dimensions` on
// `BoxData` and nothing breaks, nothing errors — the descriptor keeps a field no param can
// reach, and an animated size silently returns to freezing. That is the ORIGINAL bug coming
// back through a rename, with every test green. Hence this file.
//
// ── FOUR QUESTIONS, ANSWERED SEPARATELY ────────────────────────────────────────────────
//
//   1. Is every descriptor kind CLASSIFIED — param-fed, and by which producer?
//   2. Can every descriptor field be REACHED by a param of that name on that producer?
//   3. Does folding a field actually MOVE the key (i.e. is the field really built from)?
//   4. Are the non-param-fed kinds left strictly alone?
//
// Question 3 is the one that catches a half-written rebuild arm. 2 alone would pass against
// an implementation that read the right names and ignored them.
//
// REF: src/app/modifierGeometry.ts (`descriptorParamFields`, `rebuildGeometryRef`);
//      src/app/overlayWithIdentity.ts (the seam that uses them);
//      src/nodes/types.ts (`GeometryDescriptor` — the union this censuses);
//      tools/gates/sourceFiles.ts (the shared enumeration); issues #536, #537.

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  arrayGeometryRef,
  boxGeometryRef,
  descriptorParamFields,
  mirrorGeometryRef,
  rebuildGeometryRef,
  sphereGeometryRef,
} from './modifierGeometry';
import { declaredParamKeys } from './inspectorSectionBody';
import { __resetRegistryForTests } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { stripComments } from '../test-utils/sourceScan';
import type { GeometryRef } from '../nodes/types';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const SOURCE = join(__dirname, '../nodes/types.ts');

/**
 * Every kind of geometry handle, with the node that produces it and a representative ref
 * built by the SAME builder the evaluator uses.
 *
 * `producer: null` means the kind is not fed by any node's params — its identity comes from
 * somewhere the overlay cannot write (an asset reference, a content hash of bytes in OPFS),
 * so there is nothing here for an animated channel to invalidate.
 */
const HANDLE_KINDS: Record<
  string,
  { readonly producer: string | null; readonly ref: GeometryRef; readonly probe: unknown }
> = {
  box: { producer: 'BoxData', ref: boxGeometryRef([1, 1, 1], null), probe: [2, 2, 2] },
  sphere: { producer: 'SphereData', ref: sphereGeometryRef(1, 16, 12, null), probe: 7 },
  array: {
    producer: 'ArrayModifier',
    ref: arrayGeometryRef(boxGeometryRef([1, 1, 1], null), 2, [2, 0, 0]),
    probe: 9,
  },
  mirror: {
    producer: 'MirrorModifier',
    ref: mirrorGeometryRef(boxGeometryRef([1, 1, 1], null), 'x', 0),
    probe: 3,
  },
  gltf: {
    producer: null,
    ref: {
      key: 'gltf|a|b',
      kind: 'gltf',
      descriptor: { kind: 'gltf', assetRef: 'a', childName: 'b' },
    },
    probe: 'z',
  },
  baked: {
    producer: null,
    ref: {
      key: 'baked|h',
      kind: 'baked',
      descriptor: { kind: 'baked', hash: 'h', vertexCount: 3 },
    },
    probe: 'z',
  },
};

/** A value of the right SHAPE for `field`, so a fold is not rejected for being the wrong type. */
function probeFor(field: string, kind: string): unknown {
  const p = HANDLE_KINDS[kind].probe;
  if (field === 'offset') return kind === 'array' ? [5, 0, 0] : 5;
  if (field === 'axis') return 'y';
  if (field === 'size') return [2, 2, 2];
  return p;
}

describe('#537 — every param that feeds a geometry handle can reach it', () => {
  it('classifies every kind in the GeometryDescriptor union', () => {
    // Read off the type rather than restated, so a seventh descriptor kind cannot be added
    // without someone answering here whether params feed it — which is exactly the question
    // whose wrong default (silently: no) is this issue.
    const src = stripComments(readFileSync(SOURCE, 'utf8'));
    const head = /export type GeometryDescriptor\s*=/.exec(src);
    expect(head, 'the union must still be found by this parser').not.toBeNull();

    // Walk to the `;` that ends the DECLARATION, tracking brace depth. Written first as a
    // lazy `([\s\S]*?);` and that was wrong in a way worth recording: the arms are object
    // types full of `;` separators, so the match ended inside the second arm and the census
    // reported two kinds where there are six — a census silently reading a SMALLER subject,
    // which is the failure mode every gate in this repo is most exposed to. It reported a
    // clean four-kind classification as a mismatch only because the expected list was exact.
    let depth = 0;
    let i = head!.index + head![0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ';' && depth === 0) break;
    }
    const body = src.slice(head!.index + head![0].length, i);
    const kinds = [...body.matchAll(/readonly kind:\s*'([a-z]+)'/g)].map((m) => m[1]);
    expect(kinds.sort()).toEqual(Object.keys(HANDLE_KINDS).sort());
  });

  it('names every descriptor field after a real param on the producing node', () => {
    // The correspondence itself. A field with no same-named param is a field no animation can
    // ever reach — the original freeze, restored by a rename, with nothing else going red.
    const unreachable: string[] = [];
    for (const [kind, entry] of Object.entries(HANDLE_KINDS)) {
      if (!entry.producer) continue;
      const params = declaredParamKeys(entry.producer);
      for (const field of descriptorParamFields(entry.ref.descriptor)) {
        if (!params.includes(field)) unreachable.push(`${kind}.${field} (${entry.producer})`);
      }
    }
    expect(unreachable).toEqual([]);
  });

  it('moves the key when any single field is folded in', () => {
    // The half a name check cannot see: that each field is genuinely BUILT FROM. An arm that
    // read the right names and dropped one would pass the case above and freeze that param
    // alone — the narrowest possible version of this bug.
    const ignored: string[] = [];
    for (const [kind, entry] of Object.entries(HANDLE_KINDS)) {
      if (!entry.producer) continue;
      for (const field of descriptorParamFields(entry.ref.descriptor)) {
        const rebuilt = rebuildGeometryRef(entry.ref, { [field]: probeFor(field, kind) });
        if (rebuilt.key === entry.ref.key) ignored.push(`${kind}.${field}`);
      }
    }
    expect(ignored).toEqual([]);
  });

  it('never exposes a nested source handle as a param field', () => {
    // `source` is another producer's minted identity. Folding a param write into it would
    // repoint this modifier at geometry its own producer never agreed to.
    for (const kind of ['array', 'mirror']) {
      const d = HANDLE_KINDS[kind].ref.descriptor as unknown as Record<string, unknown>;
      expect(Object.keys(d), `${kind} must actually have a source to exclude`).toContain('source');
      expect(descriptorParamFields(HANDLE_KINDS[kind].ref.descriptor)).not.toContain('source');
    }
  });

  it('leaves an asset-keyed handle strictly alone', () => {
    // gltf and baked are keyed by an asset reference and by a content hash of bytes in OPFS.
    // Re-minting either here would be a second spelling of a key this module does not own —
    // and for `baked`, a fabricated hash pointing at bytes that do not exist.
    for (const kind of ['gltf', 'baked']) {
      const { ref } = HANDLE_KINDS[kind];
      expect(rebuildGeometryRef(ref, { hash: 'x', assetRef: 'y', size: [9, 9, 9] })).toBe(ref);
    }
  });

  it('returns the ref by reference when nothing it builds from was written', () => {
    // What keeps an animated position from re-minting a geometry key — and therefore from
    // costing two objects their shared build.
    const { ref } = HANDLE_KINDS.box;
    expect(rebuildGeometryRef(ref, {})).toBe(ref);
    // A written param that is real but feeds a DIFFERENT descriptor kind must not fold in
    // either: `radius` is nothing to a box.
    expect(rebuildGeometryRef(ref, { radius: 5 })).toEqual(boxGeometryRef([1, 1, 1], null));
  });
});
