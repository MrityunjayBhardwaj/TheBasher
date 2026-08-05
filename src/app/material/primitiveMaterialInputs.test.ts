// #536 S2 — the gate that replaces a structural guarantee with a checked one.
//
// Before S2 the registry's key was a total function of the spec it built from, so "two
// materials that render differently share an instance" was impossible by construction.
// Anchoring the key on the evaluator's `materialKey` gives that up: the key is now a
// function of NAMED INPUTS, and anything the build reads that is not derived from those
// inputs is silently unkeyed.
//
// So the old walk survives as an ORACLE. The claim is one-directional and that is
// deliberate:
//
//   SAME composed key  ⇒  SAME spec        ← REQUIRED. A violation shares one GPU
//                                            material between two meshes that should
//                                            render differently — repainting an object
//                                            nobody edited, which is the bug the
//                                            registry exists to prevent.
//   SAME spec          ⇒  SAME composed key  ← NOT required. The key may separate two
//                                            inputs that compile alike; that is a lost
//                                            dedup, a perf cost invisible on screen.
//
// The corpus perturbs one thing at a time, and every perturbation is chosen to land on a
// DIFFERENT field of `PrimitiveMaterialSpec`, so a key that dropped any one field is
// caught by the pair it fails to separate rather than by a count.
//
// REF: src/app/material/primitiveMaterialInputs.ts; src/app/materialRegistry.ts (`keyOf`);
//      tests/e2e/p536-override-band-instance-split.spec.ts (the same claim, in a browser);
//      issues #530, #532, #536.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { stripComments } from '../../test-utils/sourceScan';
import { BoxDataNode, BoxDataParams } from '../../nodes/BoxData';
import { hydrateInlineMaterial } from '../../nodes/materialSchema';
import type { InlineMaterialSpec, MaterialValue } from '../../nodes/types';
import { keyOf } from '../materialRegistry';
import {
  compilePrimitiveMaterial,
  irKeyFor,
  primitiveMaterialKey,
  primitiveMaterialSpec,
  type ResolvedMaps,
} from './primitiveMaterialInputs';

/** A stand-in for a decoded texture: both the oracle and the key read only these two. */
const tex = (uuid: string) => ({ isTexture: true, uuid }) as unknown as THREE.Texture;

const NO_MAPS: ResolvedMaps = {
  map: null,
  normalMap: null,
  roughnessMap: null,
  metalnessMap: null,
  aoMap: null,
  emissiveMap: null,
};

const BASE_IR = hydrateInlineMaterial({
  name: 'base',
  base: { color: '#2244ff', metalness: 0.25 },
  specular: { roughness: 0.72, ior: 1.5 },
});

/** One lobe replaced, everything else identical — the perturbation is the discriminator. */
const irWith = (patch: Record<string, unknown>): InlineMaterialSpec =>
  hydrateInlineMaterial({
    name: 'base',
    base: { color: '#2244ff', metalness: 0.25 },
    specular: { roughness: 0.72, ior: 1.5 },
    ...patch,
  });

const override = (patch: Partial<MaterialValue>): MaterialValue =>
  ({
    kind: 'Material',
    name: 'ovr',
    color: '#ff8800',
    roughness: 0.5,
    metalness: 0,
    opacity: 1,
    emissive: '#000000',
    emissiveIntensity: 0,
    overridden: { color: true },
    ignoreSourceMaterial: false,
    ...patch,
  }) as MaterialValue;

interface World {
  readonly name: string;
  readonly ir: InlineMaterialSpec;
  readonly override?: MaterialValue;
  readonly shading: string;
  readonly textures: ResolvedMaps;
}

const world = (name: string, patch: Partial<Omit<World, 'name'>> = {}): World => ({
  name,
  ir: BASE_IR,
  override: undefined,
  shading: 'material',
  textures: NO_MAPS,
  ...patch,
});

function derive(w: World) {
  const compiled = compilePrimitiveMaterial(w.ir, w.override);
  return {
    spec: primitiveMaterialSpec(compiled, w.shading, w.textures),
    key: primitiveMaterialKey({
      irKey: irKeyFor(w.ir, null),
      override: w.override,
      shading: w.shading,
      textures: w.textures,
    }),
  };
}

/**
 * Each entry moves exactly one field of the built spec (or, for the last few, one of the
 * render-time contributions the evaluator cannot see). `thickness` has no entry of its
 * own: the compile derives it from `transmission`, so the transmission perturbation is
 * the only way to reach it.
 */
const CORPUS: readonly World[] = [
  world('base'),
  world('color', { ir: irWith({ base: { color: '#00ff44', metalness: 0.25 } }) }),
  world('metalness', { ir: irWith({ base: { color: '#2244ff', metalness: 0.9 } }) }),
  world('roughness', { ir: irWith({ specular: { roughness: 0.13, ior: 1.5 } }) }),
  world('ior', { ir: irWith({ specular: { roughness: 0.72, ior: 1.9 } }) }),
  world('clearcoat', { ir: irWith({ coat: { weight: 0.8, roughness: 0.1 } }) }),
  world('clearcoatRoughness', { ir: irWith({ coat: { weight: 0.8, roughness: 0.4 } }) }),
  world('transmission+thickness+transparent', { ir: irWith({ transmission: { weight: 0.6 } }) }),
  world('emissive', { ir: irWith({ emission: { color: '#ff0000', luminance: 1 } }) }),
  world('emissiveIntensity', { ir: irWith({ emission: { color: '#ff0000', luminance: 5 } }) }),
  world('opacity+transparent', { ir: irWith({ geometry: { opacity: 0.4 } }) }),
  // #532 — the two render-mode flags the native build honours. Each has to reach the
  // SPEC, not just the compile: the vacuity check below asserts every world produces a
  // DIFFERENT spec, so a flag the spec drops makes its world a duplicate of `base` and
  // reds there. That is the whole gate for the missing half — no separate assertion
  // states it twice. (`vertexColors` is deliberately absent from the spec and therefore
  // absent from this corpus; it is pinned on its own below.)
  world('alphaTest', { ir: irWith({ geometry: { opacity: 1, alphaCutoff: 0.5 } }) }),
  world('side (doubleSided)', { ir: irWith({ geometry: { opacity: 1, doubleSided: true } }) }),
  world('uvTransform', {
    ir: irWith({ uvTransform: { tiling: [2, 3], offset: [0.25, 0], rotation: 0.5 } }),
  }),
  world('wireframe (shading)', { shading: 'wireframe' }),
  world('override present', { override: override({}) }),
  world('override, different colour', { override: override({ color: '#00ffaa' }) }),
  world('one map resolved', { textures: { ...NO_MAPS, map: tex('t1') } }),
  world('a different texture instance', { textures: { ...NO_MAPS, map: tex('t2') } }),
  world('a different slot', { textures: { ...NO_MAPS, normalMap: tex('t1') } }),
];

describe('#536 S2 — the composed key is at least as discriminating as the spec walk', () => {
  it('never gives two DIFFERENT specs the same key', () => {
    const rows = CORPUS.map((w) => ({ name: w.name, ...derive(w) }));
    const collisions: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const differentSpec = keyOf(rows[i].spec) !== keyOf(rows[j].spec);
        if (differentSpec && rows[i].key === rows[j].key) {
          collisions.push(`${rows[i].name} ↔ ${rows[j].name}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('the corpus actually separates specs, or the claim above is vacuous', () => {
    // Without this, a corpus of identical worlds passes the collision check for free.
    // EQUALITY, not a floor: every entry was chosen to land on a different spec field,
    // and that was measured rather than assumed. A floor would let a future entry that
    // silently duplicates an existing one shrink the corpus's reach without a red.
    const specKeys = new Set(CORPUS.map((w) => keyOf(derive(w).spec)));
    expect(specKeys.size).toBe(CORPUS.length);
  });

  it('is not a constant, and dedups what it should', () => {
    const keys = CORPUS.map((w) => derive(w).key);
    expect(new Set(keys).size).toBe(CORPUS.length);
    // Two structurally-equal worlds built independently must land on ONE key, or the
    // registry would hand every mesh its own material and every sharing claim above
    // would be satisfied by a cache that never hits.
    expect(derive(world('a')).key).toBe(derive(world('b')).key);
  });
});

describe('#532 — `vertexColors` is deliberately NOT a native spec field', () => {
  // It is not a property of the material; it is a request for a geometry attribute the
  // material does not own and a SHARED material cannot promise — two meshes may share
  // one material and differ in whether they carry `COLOR_0`. The only producer of the
  // flag is the glTF import chain, which sets it exactly when the imported primitive
  // has the attribute and applies it on the imported material, never through this
  // registry. Applying it here was tried and observed: a native box renders pure black.
  //
  // So this is a REACH stated with a gate, not a silent omission — and the pair below
  // is what makes it a statement rather than a wish.
  const flagged = irWith({ geometry: { opacity: 1, vertexColors: true } });
  const cutout = irWith({ geometry: { opacity: 1, alphaCutoff: 0.5 } });

  it('the native spec is INSENSITIVE to it', () => {
    const plain = primitiveMaterialSpec(
      compilePrimitiveMaterial(BASE_IR, undefined),
      'material',
      NO_MAPS,
    );
    const withFlag = primitiveMaterialSpec(
      compilePrimitiveMaterial(flagged, undefined),
      'material',
      NO_MAPS,
    );
    expect(keyOf(withFlag)).toBe(keyOf(plain));
    expect(Object.keys(withFlag)).not.toContain('vertexColors');
  });

  it('…and the PRESENCE CONTROL: the same shape of edit on a sibling flag DOES reach it', () => {
    // Without this, "insensitive" is indistinguishable from a compile that dropped the
    // whole geometry lobe, or from a spec builder that ignores its input.
    const plain = primitiveMaterialSpec(
      compilePrimitiveMaterial(BASE_IR, undefined),
      'material',
      NO_MAPS,
    );
    const withCutout = primitiveMaterialSpec(
      compilePrimitiveMaterial(cutout, undefined),
      'material',
      NO_MAPS,
    );
    expect(keyOf(withCutout)).not.toBe(keyOf(plain));
    expect(withCutout.alphaTest).toBe(0.5);
  });

  it('the compile still carries it, so the glTF road is unaffected', () => {
    // The exclusion is at the SPEC, not at the compiler — `applyOpenpbrScalars` reads
    // the compiled value directly and must keep seeing it.
    expect(compilePrimitiveMaterial(flagged, undefined).vertexColors).toBe(true);
    expect(compilePrimitiveMaterial(BASE_IR, undefined).vertexColors).toBe(false);
  });
});

describe('#536 S2 — the evaluator’s key is used, and the fallback is the same function', () => {
  it('prefers the minted key over re-deriving one', () => {
    expect(irKeyFor(BASE_IR, 'minted-by-the-evaluator')).toBe('minted-by-the-evaluator');
  });

  it('falls back to the evaluator’s own key function, not a second spelling', () => {
    // The fallback path (ModifiedData, and the fallback IR a materialless node draws)
    // must agree with what the evaluator would have minted for the same IR — otherwise
    // the two halves of identity drift with nothing to notice.
    expect(irKeyFor(BASE_IR, null)).toBe(irKeyFor(BASE_IR, undefined));
    const sameContent = hydrateInlineMaterial({
      name: 'a different label entirely',
      base: { color: '#2244ff', metalness: 0.25 },
      specular: { roughness: 0.72, ior: 1.5 },
    });
    // `name` is excluded from render identity (the S1 corollary), so a relabelled but
    // otherwise identical material must not lose its share of the instance.
    expect(irKeyFor(sameContent, null)).toBe(irKeyFor(BASE_IR, null));
  });

  it('lands a keyed and an unkeyed road on ONE instance for the same material (#542)', () => {
    // The cross-road claim §4's reach paragraph rests on, and NOT covered by the two cases
    // above: those compare the fallback with itself. This one compares the fallback with
    // what the EVALUATOR actually mints, taken from `BoxData.evaluate` rather than by
    // calling the key function here — writing `irKeyFor(ir, materialKeyOf(ir))` was the
    // first attempt and it is equal by construction, so it could never have failed.
    //
    // It matters because `ModifiedData` carries no minted key while sharing the very same
    // registry: an arrayed cube (fallback road) and a plain cube (minted road) with equal
    // materials must draw ONE instance. If the evaluator ever minted with a different
    // function, the two roads would silently stop sharing — a lost dedup, invisible on
    // screen and impossible to see from either road on its own.
    const params = BoxDataParams.parse({
      size: [1, 1, 1],
      material: { base: { color: '#2244ff' } },
    });
    const evaluated = BoxDataNode.evaluate(
      params,
      { material: [] },
      {
        time: { frame: 0, seconds: 0, normalized: 0 },
      },
    ) as MeshDataValue;
    expect(evaluated.materialKey, 'the evaluator must mint one at all').toBeTruthy();
    expect(irKeyFor(evaluated.material as InlineMaterialSpec, evaluated.materialKey)).toBe(
      irKeyFor(evaluated.material as InlineMaterialSpec, null),
    );
  });

  it('a map REF change moves the key even when the resolved textures are equal', () => {
    // The safe direction, stated rather than discovered later: the key may separate two
    // inputs whose specs match. Here the IR points at a different image while the
    // caller supplies the same (empty) resolved slots.
    const a = world('ref a', { ir: irWith({ maps: { albedo: null } }) });
    const b = world('ref b', {
      ir: irWith({ maps: { albedo: { hash: 'zzz', colorSpace: 'srgb' } } }),
    });
    expect(keyOf(derive(a).spec)).toBe(keyOf(derive(b).spec));
    expect(derive(a).key).not.toBe(derive(b).key);
  });
});

// ── #566 — THE OTHER DIRECTION: compiled → spec ────────────────────────────────────────
//
// `materialRegistry.test.ts` already enumerates spec → material ("specced but not
// applied"). That is the mirror of this one and it is what made #532 findable ONCE the
// fields were on the spec. The defect #532 actually was is upstream of it: `openpbrToThree`
// compiled `alphaTest` / `doubleSided` / `vertexColors`, the native road's spec never
// carried them, and the build could not apply what it never received. Every tier stayed
// green, because no tier asked this question.
//
// ⚠️ THE TIER, stated the way the locality gate states its own. This reads the OBJECTS —
// what the compile returns and what the assembly returns — never a picture. A field that is
// carried under the right name and then applied to something the shader ignores is invisible
// here by construction; that residual belongs to the browser tier.
describe('#566 — every field the compile produces is carried on the spec, or excluded on the record', () => {
  /**
   * The declared correspondence, compiled field → spec field.
   *
   * DECLARED rather than name equality, and that is the whole design. Two of these land
   * under a different name on purpose, so a name-equality gate would accuse `doubleSided`
   * and `maps` while they are working correctly — and the cheapest way to silence a
   * false accusation is to rename the field, which would undo the reason it was renamed
   * (the spec speaks the BUILD's vocabulary, so the downstream enumeration can check it).
   * A wrong gate that is easy to "fix" wrongly is worse than no gate.
   */
  const CARRIED: Readonly<Record<string, string>> = {
    color: 'color',
    roughness: 'roughness',
    metalness: 'metalness',
    opacity: 'opacity',
    transparent: 'transparent',
    alphaTest: 'alphaTest',
    // #532 — boolean→enum at the spec assembly, so every spec field lands on the material
    // under its own name and the downstream gate stays exact instead of needing an exemption.
    doubleSided: 'side',
    emissive: 'emissive',
    emissiveIntensity: 'emissiveIntensity',
    ior: 'ior',
    clearcoat: 'clearcoat',
    clearcoatRoughness: 'clearcoatRoughness',
    transmission: 'transmission',
    thickness: 'thickness',
    // The compile emits map REFS; the seam suspends on them and hands the assembly decoded
    // textures. Same information, one resolution step later, under the build's name.
    maps: 'textures',
    uvTransform: 'uvTransform',
    mapUvTransforms: 'mapUvTransforms',
  };

  /**
   * The closed exclusion set: compiled fields the native road deliberately does NOT honour.
   *
   * The reason travels with the member, because "which compiled fields does this road not
   * honour, and why" was previously prose in three files and a comment in a fourth. One
   * member today.
   */
  const EXCLUDED: Readonly<Record<string, string>> = {
    vertexColors:
      'asks the shader for a COLOR_0 attribute the GEOMETRY must supply, so a shared ' +
      'material cannot answer it without knowing who is holding it (#532 — wiring it ' +
      'through renders a native primitive pure black, observed in a browser)',
  };

  /**
   * The fields the compile actually PRODUCES, unioned over several worlds.
   *
   * Runtime keys, not the interface's declarations: the question is what the assembly is
   * handed, and an optional field is absent from the object when the IR does not populate
   * it. Unioned over a corpus for exactly that reason — `mapUvTransforms` is ABSENT rather
   * than undefined when no per-map placement exists, so a single-world enumeration would
   * be blind to it and would report a stale CARRIED entry as correct.
   */
  const producedFields = (): string[] => {
    const worlds: InlineMaterialSpec[] = [
      BASE_IR,
      irWith({ emission: { color: '#ff8800', intensity: 2 } }),
      irWith({ geometry: { doubleSided: true, alphaCutoff: 0.5, vertexColors: true } }),
      irWith({ mapUvTransforms: { albedo: { tiling: [2, 2], offset: [0.1, 0], rotation: 0 } } }),
    ];
    const seen = new Set<string>();
    for (const ir of worlds)
      for (const k of Object.keys(compilePrimitiveMaterial(ir, undefined))) seen.add(k);
    return [...seen].sort();
  };

  it('accounts for every produced field exactly once — carried, or excluded with a reason', () => {
    for (const field of producedFields()) {
      const carried = field in CARRIED;
      const excluded = field in EXCLUDED;
      expect(
        carried || excluded,
        `\`${field}\` is compiled but the spec neither carries nor excludes it — it will be ` +
          `dropped on the floor exactly as #532's flags were, with every tier green`,
      ).toBe(true);
      expect(carried && excluded, `\`${field}\` is both carried and excluded`).toBe(false);
    }
  });

  it('derives the counts rather than flooring them, so a field cannot leave quietly', () => {
    // EXACT on both sides. A floor would pass a field that stopped being produced — which is
    // the direction that looks like cleanup and silently removes a rendering lobe.
    const produced = producedFields();
    expect(produced.length).toBe(18);
    expect(produced.filter((f) => f in CARRIED).length).toBe(17);
    expect(produced.filter((f) => f in EXCLUDED).length).toBe(1);
  });

  it('every CARRIED target really is a key of the assembled spec', () => {
    // Guards the map itself. A stale entry — right-hand side renamed, or the field dropped
    // from the assembly — would otherwise let the first case pass while nothing arrives.
    const spec = primitiveMaterialSpec(
      compilePrimitiveMaterial(
        irWith({ mapUvTransforms: { albedo: { tiling: [2, 2], offset: [0, 0], rotation: 0 } } }),
        undefined,
      ),
      'flat',
      NO_MAPS,
    );
    const produced = producedFields();
    for (const [compiled, specField] of Object.entries(CARRIED)) {
      // #570 — the map's LEFT-hand side needs the same guarantee its right-hand side has,
      // and the same one every exclusion already has. Without this a carried entry naming a
      // field the compile does not produce passes every case in this file (measured: adding
      // one left 3820/3820 green), so the map can start describing a compile that no longer
      // exists — the one thing a declared correspondence is here to prevent.
      expect(
        produced,
        `CARRIED names \`${compiled}\`, which the compile does not produce in any world`,
      ).toContain(compiled);
      expect(
        Object.prototype.hasOwnProperty.call(spec, specField),
        `CARRIED says \`${compiled}\` → \`${specField}\`, but the spec has no such key`,
      ).toBe(true);
    }
  });

  /**
   * #570 — THE CORPUS'S OWN OBLIGATION, read from the compile rather than from memory.
   *
   * Every case above is a statement about `producedFields()`, and `producedFields()` unions
   * four HAND-PICKED worlds. `openpbrToThree` emits most of its keys unconditionally, but a
   * conditional emission (`...(cond ? { field } : {})`) only appears when some world triggers
   * `cond` — so a conditional field no world reaches is absent from the union, accounted for
   * by nobody, and the count stays put. Measured: adding one left **3820/3820 green**, while
   * the same field emitted unconditionally reddened exactly one file of 306. The condition
   * was the entire difference.
   *
   * That is this file's own subject one level up — "the next field it learns to compile can
   * be lost exactly the same way with every tier green" — so the corpus cannot stay a list
   * somebody remembered to extend.
   *
   * ⚠️ STATED RESIDUAL: derivation B reads SYNTAX. A conditional emission written some other
   * way (an `if` that assigns, a spread of a prebuilt object) is invisible to it, and if no
   * world triggers that one either, derivation A cannot see it and the two agree vacuously.
   * The pair narrows the gap to "a new conditional emission, in a new syntax, that nothing
   * exercises"; it does not close it. Widen the pattern when the compile grows a second way
   * of emitting conditionally, not before.
   */
  const COMPILER = 'src/app/material/openpbrToThree.ts';

  /** Derivation B — the field named by each conditional spread in the compiler's source. */
  const conditionallyEmittedInSource = (): string[] => {
    const src = stripComments(readFileSync(join(__dirname, '..', '..', '..', COMPILER), 'utf8'));
    const body = /export function openpbrToThree[\s\S]*?\n}/.exec(src);
    if (!body) throw new Error('could not find the openpbrToThree body');
    return [...body[0].matchAll(/\.\.\.\([^?]*\?\s*\{\s*([A-Za-z0-9_]+)\s*:/g)].map((m) => m[1]);
  };

  /**
   * Derivation A — the fields observed to be NON-universal: produced by some world in the
   * corpus, absent from the leanest one. Runtime, so it owes nothing to the compiler's
   * syntax, which is what makes it an independent check on B's regex rather than a restating
   * of it.
   */
  const observedConditional = (): string[] => {
    const always = new Set(Object.keys(compilePrimitiveMaterial(BASE_IR, undefined)));
    return producedFields().filter((f) => !always.has(f));
  };

  it('every conditionally-emitted field is triggered by a world in the corpus', () => {
    const declared = conditionallyEmittedInSource();
    // Anti-vacuity: a regex that matched nothing would make this case green and meaningless,
    // which is how a census dies quietly.
    expect(
      declared.length,
      'the conditional-spread parse read nothing — this census would be vacuous',
    ).toBeGreaterThan(0);
    const produced = producedFields();
    for (const field of declared) {
      expect(
        produced,
        `\`${field}\` is emitted conditionally and NO world in the corpus triggers it, so ` +
          `every case in this file is blind to it — add a world that populates its input`,
      ).toContain(field);
    }
  });

  it('reads the conditional set two independent ways — source syntax and runtime — and they agree', () => {
    // If B's regex silently stops matching a form the compiler starts using, A still sees the
    // field (some world triggers it) and the two disagree. That disagreement is the only
    // signal that the source-text half has gone blind.
    expect(conditionallyEmittedInSource().sort()).toEqual(observedConditional().sort());
  });

  it('every EXCLUSION is load-bearing — remove it and the first case must actually accuse', () => {
    // An exemption that is not doing work reads as considered and is decoration; worse, if
    // the field later DOES get carried, the stale entry keeps the census green while the
    // reason beside it has become false. So: an excluded field must genuinely be absent
    // from the spec, and must genuinely still be produced.
    const spec = primitiveMaterialSpec(
      compilePrimitiveMaterial(irWith({ geometry: { vertexColors: true } }), undefined),
      'flat',
      NO_MAPS,
    );
    const produced = producedFields();
    for (const field of Object.keys(EXCLUDED)) {
      expect(produced, `\`${field}\` is excluded but no longer produced`).toContain(field);
      expect(
        Object.prototype.hasOwnProperty.call(spec, field),
        `\`${field}\` is listed as excluded but the spec carries it — the exclusion, and the ` +
          `reason written beside it, are now false`,
      ).toBe(false);
      expect(EXCLUDED[field].length, `\`${field}\` is excluded without a reason`).toBeGreaterThan(
        30,
      );
    }
  });
});
