// #688 — what every producer mints, at which domain, observed rather than asserted.
//
// ── THE DEFECT THIS WAS WRITTEN FOR, AND WHY THAT IS NOW HISTORY ──────────────────────
//
// #649 stopped a generator's key inheriting its source's whole attribute component and
// replaced it with a freshly minted, TILED one. Right — but `mintTiledModifierAttributes`
// then read and minted exactly one name:
//
//     const carried = read(sourceKey)?.[MATERIAL_INDEX];      // the read,  enumerated
//     const minted  = mintAttributes({ [MATERIAL_INDEX]: … }); // the mint,  enumerated
//
// so the generator's key named only the tiled `material_index`. Constructed and measured on
// `e84ff4a`: two boxes with an IDENTICAL `material_index` and a DIFFERENT second face-domain
// attribute produced `sourceKeysDiffer: true` and `arrayKeysDiffer: FALSE` — both
// `array|box|1,1,1|3|2,0,0|a:ea2140ba` — and the second attribute was silently dropped. Two
// geometries that genuinely differ collapsed onto one build: #649's own defect, sign flipped.
//
// ⚠️ THAT ENUMERATION IS GONE. #688's first half shipped the gather: the minter now selects
// its set by DOMAIN, so it carries every face-domain attribute its source holds and the
// collapse above is unconstructible. This file was written as the second half, BEFORE that
// landed, and it is kept because the population census it builds outlives the defect — but
// every row below now means something different from what it was written to mean, and the
// difference is recorded here rather than left for a reader to reconstruct.
//
// ── WHAT THE CENSUS IS FOR NOW ────────────────────────────────────────────────────────
//
// Not "the enumeration is safe" — there is no enumeration. Two things, both still live:
//
//   1. `UVMap` is CORNER, and the tiling still cannot lay out a corner-domain attribute
//      (`order` is a permutation of FACE indices). Corner attributes are therefore still
//      dropped by a generator, which is #694, still open. This census is what observes the
//      domain of every producer's output, so it is what notices a producer arriving at a
//      domain the tiling cannot carry.
//   2. A second FACE-domain attribute is no longer a bug when it appears — the gather
//      handles it — but it is still a population change nobody has exercised end to end.
//      The forward guard below reds so that someone confirms it rather than assumes it.
//
// A decision that cannot be taken yet is a test that reds when it becomes takeable ([[V208]]).
// What changed is the decision: it was "widen the enumeration or gather"; it is now "confirm
// the gather carries the new attribute, and say whether its domain can be laid out at all".
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
// `corner` to `face` would be invisible to any assertion about names, and it is a domain
// change — not a name change — that decides whether the tiling can lay an attribute out.
//
// REF: src/nodes/meshAttributes.ts (`mintTiledModifierAttributes` — the domain-selected
//      gather, and the ⚠️ block naming the corner-domain drop it does NOT close);
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
  // #770 — FACES 3..5. A box has six faces now, so the old `6, 11` clamps to nothing and every
  // face stays on slot 0: the source would silently stop being two-material.
  const minted = faceRangeMaterialAttributes(boxDescriptor(), 3, 5);
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
    // `null` carried set — this census's subject is what a producer MINTS, and a source
    // whose attributes were carried through would put another producer's output in the row.
    probe: () => targetedMaterialAttributes(boxDescriptor(), null, null)!.set,
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
      // #776 — the layer is a VERDICT now, because a descriptor with no rims of its own has a
      // uv buffer and no corner to put it on. A box has rims, so this producer still mints.
      const attribute = result.status === 'ok' ? result.attribute : null;
      return fromStore(attribute?.kind === 'resident' ? attribute.key : null, 'the UV read');
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

/**
 * The FACE-domain names carried under ONE key, sorted — the set the tiling must reproduce
 * for that particular source.
 *
 * Distinct from {@link faceDomainNames}, which is the union over the whole producer
 * population: the tiling is answerable for its own source's set, never for the population's.
 * Conflating the two is what made the tiled row fire on the harmless case.
 */
function faceDomainNamesOf(key: string | null | undefined, what: string): string[] {
  const set = fromStore(key, what);
  return Object.keys(set)
    .filter((name) => set[name].domain === 'face')
    .sort();
}

/** The names a producer mints at the FACE domain, sorted — over the whole population. */
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
    // lands, which is the entire failure mode.
    //
    // ⚠️ WHAT A RED MEANS CHANGED WHEN THE GATHER SHIPPED. It used to mean
    // `mintTiledModifierAttributes` is silently dropping the new attribute. It no longer
    // does — the minter selects by domain and carries whatever its source holds (measured:
    // giving the tiled row's own source a second face-domain attribute leaves the tiling
    // row GREEN). A red here now means the population changed and two things want
    // confirming: that the gather really carries it end to end, and — if the new attribute
    // is NOT face-domain — that something can lay it out at all, which for the corner
    // domain is #694 and is still open. Update the literal once you have confirmed, not
    // before.
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
    const unknown: string[] = [];
    for (const [name, domains] of censusDomains()) {
      // Iterated as VALUES rather than parsed back out of a formatted string: a census that
      // re-reads its own display format is one delimiter away from lying about its subject.
      for (const domain of domains) if (!isKnownDomain(domain)) unknown.push(`${name} @ ${domain}`);
    }

    expect(unknown).toEqual([]);
  });
});

describe('#688 the tiled modifier key carries the whole face-domain set', () => {
  it('🔴 the tiled mint carries exactly ITS SOURCE`s face-domain attributes', () => {
    // THE ROW THAT TIES THE CENSUS TO THE TILING, and the one that discriminates.
    //
    // ⚠️ COMPARED AGAINST THE SOURCE, NOT AGAINST THE POPULATION UNION, and that is a
    // correction rather than a preference. This row first compared the tiling's output to
    // `faceDomainNames()` — the union over EVERY producer — which is only the same set while
    // every producer happens to mint the same face-domain names. Measured once the gather
    // shipped: giving a NON-source producer a second face-domain attribute redded this row
    // while nothing whatsoever was broken (the tiling carried its own source faithfully),
    // and giving the SOURCE one left it green (the gather did carry it). So against the
    // union it had become a detector that fires only on the harmless case and stays silent
    // on the harmful one — exactly inverted.
    //
    // Against the source it states the gather's actual contract: whatever face-domain data
    // the source holds comes through, no more and no less. It reds if the minter ever drops
    // one again, which is the defect this file exists for.
    const source = twoMaterialBoxRef();
    const sourceFaceNames = faceDomainNamesOf(source.attributeKey, 'the tiled row`s source');
    const array = arrayGeometryRef(source, 3, [2, 0, 0]);
    const tiled = fromStore(mintTiledModifierAttributes(array.descriptor), 'the tiled minter');

    expect(Object.keys(tiled).sort()).toEqual(sourceFaceNames);
    // Not vacuous on an empty source: the source is asserted to carry something, so an
    // equality between two empty lists cannot be what passes here.
    expect(sourceFaceNames.length).toBeGreaterThan(0);
  });

  it('carries the source`s assignment rather than merely a set of the right shape', () => {
    // Guards the row above against passing on a tiling that mints the right NAME and the
    // wrong VALUES — a gather bug would keep the key set identical. 6 source faces, faces
    // 3..5 on slot 1, arrayed x3 => 18 faces repeating the source's 3+3 split three times.
    const array = arrayGeometryRef(twoMaterialBoxRef(), 3, [2, 0, 0]);
    const tiled = fromStore(mintTiledModifierAttributes(array.descriptor), 'the tiled minter');
    const assignment = tiled[MATERIAL_INDEX];

    expect(assignment.domain).toBe('face');
    expect(assignment.count).toBe(18);
    expect([...assignment.data]).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1]);
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

  it('🔴 registers a probe for every mint CALL SITE, not merely for every module', () => {
    // THE HOLE THE MODULE-LEVEL CHECK ABOVE LEAVES OPEN, closed by counting.
    //
    // The remainder check is satisfied the moment a module appears in `PRODUCERS` even once.
    // So a FIFTH minting function added inside `meshAttributes.ts` — already registered four
    // times over — would be driven by no probe and reported by no remainder, and this whole
    // file would stay green while exactly the attribute it exists to catch walked in. Found
    // by reading this gate back against itself rather than by a failure.
    //
    // Counting call sites is a weaker instrument than the import-clause sweep above (an alias
    // defeats it), which is why it SUPPLEMENTS that check rather than replacing it: the sweep
    // owns "is this module a producer at all", this row owns "are all of its producers here".
    const stripped = new Map(sourceFiles().map(([path, src]) => [path, stripComments(src)]));
    const mismatches: string[] = [];

    for (const [path, src] of stripped) {
      if (path === DECLARING_MODULE) continue;
      const sites = (src.match(/\bmintAttributes\s*\(/g) ?? []).length;
      const probes = PRODUCERS.filter((p) => p.module === path).length;
      if (sites !== probes)
        mismatches.push(`${path}: ${sites} mint call site(s), ${probes} probe(s)`);
    }

    expect(mismatches).toEqual([]);
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
