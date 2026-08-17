// #688 — `material_index` is the ONLY face-domain attribute any producer mints, and the
// tiled modifier key is lossless exactly while that stays true.
//
// ── THE DEFECT THIS PINS, AND WHY IT IS QUIET ─────────────────────────────────────────
//
// #649 stopped a generator's key inheriting its source's whole attribute component and
// replaced it with a freshly minted, TILED one. Right — but `mintTiledModifierAttributes`
// reads and mints exactly one name:
//
//     const carried = read(sourceKey)?.[MATERIAL_INDEX];      // the read,  enumerated
//     const minted  = mintAttributes({ [MATERIAL_INDEX]: … }); // the mint,  enumerated
//
// So the generator's key names only the tiled `material_index`. Constructed and measured on
// `e84ff4a`: two boxes with an IDENTICAL `material_index` and a DIFFERENT second face-domain
// attribute produce `sourceKeysDiffer: true` and `arrayKeysDiffer: FALSE` — both
// `array|box|1,1,1|3|2,0,0|a:ea2140ba` — and the second attribute is silently dropped. Two
// geometries that genuinely differ collapse onto one build: #649's own defect, sign flipped.
//
// It is quiet because the enumeration is TRUE TODAY, not because it is safe. `AttributeSet`
// is deliberately open (`Readonly<Record<string, AttributeData>>`) and its own comment says
// why — a closed struct "cannot hold the user-authored attribute the model exists to make
// possible". The bug arrives with that feature.
//
// ── WHY A CENSUS AND NOT THE FIX ──────────────────────────────────────────────────────
//
// The honest fix is for the tiling to gather EVERY face-domain attribute the source carries;
// the gather is already generic (`tiled[i] = source[order[i]]` is per-face data, not
// material data). That is #688's first half and it is not what this file is.
//
// This is the second half, and it is worth having even after the first lands: it makes the
// enumeration's justification CHECKABLE rather than asserted. Today the claim "only
// `material_index` is face-domain" is written in prose at the mint site. A reader has no way
// to confirm it and no way to notice when it stops being true — the failure surfaces as a
// rendering oddity, months later, from a sharing loss nobody connected to this line.
//
// A decision that cannot be taken yet is a test that reds when it becomes takeable ([[V208]]).
// The second face-domain attribute is unreachable from a production producer right now —
// measured below, `UVMap` is CORNER — so there is nothing to fix and everything to pin.
//
// ── WHY THE PRODUCER POPULATION IS THE RIGHT DENOMINATOR ──────────────────────────────
//
// The tiling drops attributes carried by a SOURCE. What a source can carry is exactly what
// some producer minted — a key in the store got there through `mintAttributes`, which is
// declared "the ONE place production code builds an attribute set". So censusing producers
// bounds the set of attributes the tiling can ever be asked to carry. That deduction is what
// lets a producer-side census speak about a consumer-side loss.
//
// ── THE DOMAINS ARE OBSERVED, NOT READ OFF THE NAMES ──────────────────────────────────
//
// Every row below DRIVES the producer and reads `.domain` off what it actually minted. A
// name-keyed or source-scanned census would report on spelling; this one reports on values.
// It is what makes the `UVMap` row load-bearing rather than decorative: re-domaining UVs from
// `corner` to `face` would be invisible to any assertion about names, and would put a second
// attribute straight into the collapsing set.
//
// REF: src/nodes/meshAttributes.ts (`mintTiledModifierAttributes` — the enumerated mint);
//      src/nodes/attributeKey.ts (`mintAttributes` — the one door, and why a remainder
//      check on it is complete rather than best-effort);
//      src/nodes/attributes.ts (`AttributeSet` open by design, `MATERIAL_INDEX`, `UV_MAP`);
//      src/app/modifierAttributeTiling.gate.test.ts (the tiling's own numbers);
//      src/nodes/attributes.gate.test.ts (the census shape this reuses);
//      issues #688, #649, #644, #395.

import { beforeEach, describe, expect, it } from 'vitest';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';
import { insert, read } from '../app/attributeStore';
import { clear } from '../app/geometryRegistry';
import { arrayGeometryRef, boxGeometryRef } from '../app/modifierGeometry';
import { readMeshUVs } from '../app/uvAttributes';
import { boxFromFaceIndices } from '../test-utils/twoMaterialMesh';
import {
  faceRangeMaterialAttributes,
  mintTiledModifierAttributes,
  targetedMaterialAttributes,
  uniformMaterialAttributes,
} from './meshAttributes';
import { MATERIAL_INDEX, UV_MAP, isKnownDomain, type AttributeSet } from './attributes';

const BOX_SIZE: [number, number, number] = [1, 1, 1];

/** The bare box descriptor — the minters below take a descriptor, not a handle. */
const boxDescriptor = () => boxGeometryRef(BOX_SIZE, null).descriptor;

/**
 * A two-material box source, anchored on `faceRangeMaterialAttributes`.
 *
 * ⚠️ Every fixture here necessarily routes through SOME producer — the census's subject is
 * the union of them, so unlike a normal gate there is no outside to build from ([[V210]] has
 * nothing to bite on). What is available instead is that the fixture's producer is a
 * DIFFERENT row from the one it feeds: this source anchors the tiled row, and its own row is
 * driven independently below.
 */
function twoMaterialBoxRef() {
  const minted = faceRangeMaterialAttributes(boxDescriptor(), 6, 11);
  expect(minted, 'the two-material source failed to mint').not.toBeNull();
  insert(minted!.key, minted!.set, 'evaluate');
  return boxGeometryRef(BOX_SIZE, minted!.key);
}

/** Read a set back out of the store, failing loudly rather than censusing an absence. */
function fromStore(key: string | null | undefined, what: string): AttributeSet {
  expect(key, `${what} minted no key`).toBeTruthy();
  const set = read(key!);
  expect(set, `${what} minted key ${String(key)} which is not in the store`).not.toBeNull();
  return set!;
}

/** A site that mints an attribute set, and how to make it do so. */
interface Producer {
  /** `src/`-relative module, matching what the remainder scan reports. */
  readonly module: string;
  /** The minting export, named so a red says which producer grew an attribute. */
  readonly what: string;
  /** Drive it and hand back what it actually minted. */
  readonly probe: () => AttributeSet;
}

/**
 * Every production site that mints an attribute set.
 *
 * `src/test-utils/twoMaterialMesh.ts` is in this list on purpose: `sourceFiles()` excludes
 * only `*.test.ts`, so a fixture module IS production to every census in this repo, and it
 * mints a real face-domain assignment into the real store. Leaving it out would be the census
 * choosing its own denominator.
 */
const PRODUCERS: readonly Producer[] = [
  {
    module: 'src/nodes/meshAttributes.ts',
    what: 'uniformMaterialAttributes',
    probe: () => uniformMaterialAttributes(boxDescriptor())!.set,
  },
  {
    module: 'src/nodes/meshAttributes.ts',
    what: 'faceRangeMaterialAttributes',
    probe: () => faceRangeMaterialAttributes(boxDescriptor(), 6, 11)!.set,
  },
  {
    module: 'src/nodes/meshAttributes.ts',
    what: 'targetedMaterialAttributes',
    probe: () => targetedMaterialAttributes(boxDescriptor(), null)!.set,
  },
  {
    module: 'src/nodes/meshAttributes.ts',
    what: 'mintTiledModifierAttributes',
    // Returns a KEY rather than the set — it stores as it mints, being the one producer that
    // derives from another producer's output.
    probe: () => {
      const array = arrayGeometryRef(twoMaterialBoxRef(), 3, [2, 0, 0]);
      return fromStore(mintTiledModifierAttributes(array.descriptor), 'the tiled minter');
    },
  },
  {
    module: 'src/app/uvAttributes.ts',
    what: 'readMeshUVs',
    probe: () => {
      const result = readMeshUVs(boxGeometryRef(BOX_SIZE, null));
      expect(result.status, 'the UV read did not reach its minting arm').toBe('ok');
      return fromStore(result.status === 'ok' ? result.attributeKey : null, 'the UV read');
    },
  },
  {
    module: 'src/test-utils/twoMaterialMesh.ts',
    what: 'boxFromFaceIndices',
    probe: () =>
      fromStore(
        boxFromFaceIndices(new Int32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1])).attributeKey,
        'the two-material fixture',
      ),
  },
];

/** The module that DECLARES the mint is not a producer through it. */
const DECLARING_MODULE = 'src/nodes/attributeKey.ts';

/** Drive every producer once and collect `name -> domain` over the whole population. */
function censusDomains(): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const producer of PRODUCERS) {
    for (const [name, attribute] of Object.entries(producer.probe())) {
      const domains = byName.get(name) ?? new Set<string>();
      domains.add(attribute.domain);
      byName.set(name, domains);
    }
  }
  return byName;
}

/** The names a producer mints at the FACE domain, sorted — the set the tiling must carry. */
function faceDomainNames(): string[] {
  return [...censusDomains()]
    .filter(([, domains]) => domains.has('face'))
    .map(([name]) => name)
    .sort();
}

beforeEach(() => {
  clear();
});

describe('#688 the face-domain producer census', () => {
  it('🔴 `material_index` is the ONLY face-domain attribute any producer mints', () => {
    // THE FORWARD GUARD. Exact, never a floor: a floor passes forever once the second name
    // lands, which is the entire failure mode. When this reds, `mintTiledModifierAttributes`
    // is silently dropping the new attribute and collapsing keys that must differ — read
    // #688's first half (gather every face-domain attribute) before touching this list.
    expect(faceDomainNames()).toEqual([MATERIAL_INDEX]);
  });

  it('pins every producer`s name and domain, so a re-domained attribute cannot slip in', () => {
    // The whole observed map, not just the face rows. `UVMap` is the one non-face producer
    // and the reason the defect is unreachable today; re-domaining it to `face` would put a
    // second attribute into the collapsing set while every name-keyed assertion stayed green.
    const observed = [...censusDomains()]
      .map(([name, domains]) => `${name} @ ${[...domains].sort().join(',')}`)
      .sort();

    // `UVMap` sorts BEFORE `material_index` — ASCII, uppercase first. Written in the order
    // the sort actually produces rather than the order the prose above reads in.
    expect(observed).toEqual([`${UV_MAP} @ corner`, `${MATERIAL_INDEX} @ face`]);
  });

  it('mints each attribute at exactly ONE domain across the whole population', () => {
    // Two producers disagreeing about a name's domain is its own defect: the store is keyed
    // on content, so the same name at two domains makes "the material_index" ambiguous at
    // every consumer. Separated from the row above so a red says WHICH thing broke.
    const split = [...censusDomains()]
      .filter(([, domains]) => domains.size !== 1)
      .map(([name, domains]) => `${name}: ${[...domains].sort().join(',')}`);

    expect(split).toEqual([]);
  });

  it('mints only KNOWN domains — the open identifier is not a licence', () => {
    // `DomainId` is open as DATA so a fifth domain costs no migration. That openness is for
    // round-tripping stored values, NOT for a producer to invent one: an attribute minted at
    // an unknown domain reaches no dispatch site and is silently ignored everywhere.
    const unknown = [...censusDomains()]
      .flatMap(([name, domains]) => [...domains].map((d) => `${name} @ ${d}`))
      .filter((row) => !isKnownDomain(row.split(' @ ')[1]));

    expect(unknown).toEqual([]);
  });
});

describe('#688 the tiled modifier key carries the whole face-domain set', () => {
  it('🔴 the tiled mint names exactly the census`s face-domain attributes', () => {
    // THE ROW THAT TIES THE CENSUS TO THE DEFECT, and the one that discriminates.
    //
    // The row above pins what producers mint; this one pins what the TILING carries, and
    // compares the two. Today both are `[material_index]`. Add a second face-domain producer
    // and they diverge — the census grows, the enumerated mint does not — so the sharing loss
    // is named here, at the seam, instead of being found in a render months later.
    const array = arrayGeometryRef(twoMaterialBoxRef(), 3, [2, 0, 0]);
    const tiled = fromStore(mintTiledModifierAttributes(array.descriptor), 'the tiled minter');

    expect(Object.keys(tiled).sort()).toEqual(faceDomainNames());
  });

  it('carries the source`s assignment rather than merely a set of the right shape', () => {
    // Guards the row above against passing on a tiling that mints the right NAME and the
    // wrong VALUES — a gather bug would keep the key set identical. 12 source faces, faces
    // 6..11 on slot 1, arrayed x3 => 36 faces repeating the source's 6+6 split three times.
    const array = arrayGeometryRef(twoMaterialBoxRef(), 3, [2, 0, 0]);
    const tiled = fromStore(mintTiledModifierAttributes(array.descriptor), 'the tiled minter');
    const assignment = tiled[MATERIAL_INDEX];

    expect(assignment.domain).toBe('face');
    expect(assignment.count).toBe(36);
    expect([...assignment.data]).toEqual([
      0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1,
      1, 1, 1, 1, 1,
    ]);
  });
});

describe('#688 the producer list is complete', () => {
  it('leaves no unclassified remainder — every module minting an attribute set is registered', () => {
    // The census is only as honest as `PRODUCERS`. `mintAttributes` is declared the ONE place
    // production code builds an attribute set, so an import of it IS a producer by
    // definition — which makes this remainder check complete rather than best-effort, unlike
    // a census over call shapes an alias could defeat.
    //
    // Comments are stripped first: this module and `meshAttributes.ts` both DISCUSS
    // `mintAttributes` in prose, and a name-keyed scan counts documentation. The better the
    // explanation, the likelier the false positive.
    const registered = new Set(PRODUCERS.map((p) => p.module));
    const remainder = sourceFiles()
      .filter(([path]) => path !== DECLARING_MODULE)
      .filter(([, src]) => /\bmintAttributes\b/.test(stripComments(src)))
      .map(([path]) => path)
      .filter((path) => !registered.has(path));

    expect(remainder).toEqual([]);
  });

  it('registers no producer that has stopped minting', () => {
    // The inverse direction: a registered module that no longer imports the mint would leave
    // a row driving something that is no longer a producer, and the census would keep
    // reporting on a population that had quietly shrunk.
    const minting = new Set(
      sourceFiles()
        .filter(([, src]) => /\bmintAttributes\b/.test(stripComments(src)))
        .map(([path]) => path),
    );

    expect([...new Set(PRODUCERS.map((p) => p.module))].filter((m) => !minting.has(m))).toEqual([]);
  });

  it('every registered producer actually mints something', () => {
    // A probe returning an empty set would make every census row above vacuously true. This
    // is the positive control: each producer is driven and observed to produce.
    for (const producer of PRODUCERS) {
      const set = producer.probe();
      expect(
        Object.keys(set).length,
        `${producer.module} ${producer.what} minted an empty set`,
      ).toBeGreaterThan(0);
    }
  });
});
