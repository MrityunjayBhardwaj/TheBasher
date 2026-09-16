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
import type { InlineMaterialSpec, MaterialValue, MeshDataValue } from '../../nodes/types';
import { keyOf } from '../materialRegistry';
import type { NamedCornerLayer } from '../cornerLayerNames';
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
  /**
   * #1062 — the drawn mesh's ordered corner layers: the fourth render-time contribution the
   * evaluator cannot see. Defaults to `[]` (no layer list), which is what every world that
   * does not name a layer would resolve to anyway.
   */
  readonly layers: readonly NamedCornerLayer[];
}

const world = (name: string, patch: Partial<Omit<World, 'name'>> = {}): World => ({
  name,
  ir: BASE_IR,
  override: undefined,
  shading: 'material',
  textures: NO_MAPS,
  layers: [],
  ...patch,
});

function derive(w: World) {
  const compiled = compilePrimitiveMaterial(w.ir, w.override);
  return {
    spec: primitiveMaterialSpec(compiled, w.shading, w.textures, w.layers),
    key: primitiveMaterialKey({
      irKey: irKeyFor(w.ir, null),
      override: w.override,
      shading: w.shading,
      textures: w.textures,
      compiled,
      layers: w.layers,
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
  // #1062 — the fourth render-time contribution. BOTH halves of the pair name a layer, and
  // the two worlds differ ONLY in whether the mesh carries it: that is the exact pair the
  // old design could not separate, and the pair whose collision drew one mesh's answer on
  // the other. A world naming nothing would perturb neither the spec nor the key and would
  // sit in the corpus proving nothing.
  world('names a colour layer, mesh has it', {
    ir: irWith({ geometry: { opacity: 1, colorLayer: 'Color' } }),
    layers: [{ name: 'Color', type: 'float4' }],
  }),
  world('names a UV layer, mesh has it at 1', {
    ir: irWith({ mapUvLayers: { albedo: 'UVMap.001' } }),
    layers: [
      { name: 'UVMap', type: 'float2' },
      { name: 'UVMap.001', type: 'float2' },
    ],
  }),
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

describe('#532 / #1062 — `vertexColors` is a native spec field, resolved against the mesh', () => {
  // ── WHAT THIS BLOCK USED TO SAY, AND WHY IT CHANGED ──────────────────────────────────
  //
  // It used to assert the exact opposite: that the native spec was INSENSITIVE to the
  // colour flag. That was right for as long as the flag was unanswerable here — it is not a
  // property of the material but a request for a geometry attribute, and a SHARED material
  // cannot promise one, because two meshes may share a material and differ in whether they
  // carry the layer. Applying it anyway was tried and observed: a native box rendered pure
  // black.
  //
  // #1062 changes the question rather than the answer. The material now NAMES the layer it
  // reads, and the name is resolved against the drawn mesh's own ordered layer list BEFORE
  // the spec is assembled — so what reaches the spec is not a request, it is the answer for
  // THIS mesh. The sharing objection is met by the key, which carries the resolved answer.
  //
  // 🔴 THE OLD BLOCK'S REAL CONCERN SURVIVES AS THE SECOND ROW, and it is the one that
  // protects the whole existing population: a material naming a colour over a mesh that does
  // not carry it must key EXACTLY as it did before. Otherwise every such material splits and
  // the GPU cache re-mints for a layer nobody can draw.
  const flagged = irWith({ geometry: { opacity: 1, colorLayer: 'Color' } });
  const cutout = irWith({ geometry: { opacity: 1, alphaCutoff: 0.5 } });
  /** A mesh that carries the layer `flagged` names. */
  const WITH_COLOUR: readonly NamedCornerLayer[] = [{ name: 'Color', type: 'float4' }];

  const specFor = (ir: InlineMaterialSpec, layers: readonly NamedCornerLayer[]) =>
    primitiveMaterialSpec(compilePrimitiveMaterial(ir, undefined), 'material', NO_MAPS, layers);

  it('draws the colour when the mesh named carries it', () => {
    const spec = specFor(flagged, WITH_COLOUR);
    expect(spec.vertexColors).toBe(true);
    expect(keyOf(spec)).not.toBe(keyOf(specFor(BASE_IR, WITH_COLOUR)));
  });

  it('is INSENSITIVE to a colour the drawn mesh does not carry — the population is not re-keyed', () => {
    // `[]` is what every geometry without a layer list answers, which today is most of them.
    expect(keyOf(specFor(flagged, []))).toBe(keyOf(specFor(BASE_IR, [])));
    expect(specFor(flagged, []).vertexColors).toBe(false);
  });

  it('…and the PRESENCE CONTROL: the same shape of edit on a sibling flag DOES reach it', () => {
    // Without this, "insensitive" is indistinguishable from a compile that dropped the
    // whole geometry lobe, or from a spec builder that ignores its input.
    const withCutout = specFor(cutout, []);
    expect(keyOf(withCutout)).not.toBe(keyOf(specFor(BASE_IR, [])));
    expect(withCutout.alphaTest).toBe(0.5);
  });

  it('the compile carries the NAME, not the flag, so each road reduces it itself', () => {
    // The resolution is at the SPEC, not at the compiler. The glTF clone road reads the
    // compiled value directly and reduces it against geometry that has no layer list.
    expect(compilePrimitiveMaterial(flagged, undefined).colorLayer).toBe('Color');
    expect('colorLayer' in compilePrimitiveMaterial(BASE_IR, undefined)).toBe(false);
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
    // #1062 — both land under a different name for the same reason `doubleSided` does: the
    // compile carries the LAYER NAME the material asks for, and the spec carries the RESOLVED
    // answer in the build's vocabulary. The rename is the resolution step, which is exactly
    // what makes a declared correspondence necessary here rather than name equality.
    colorLayer: 'vertexColors',
    mapUvLayers: 'mapUvChannels',
  };

  /**
   * The closed exclusion set: compiled fields the native road deliberately does NOT honour.
   *
   * The reason travels with the member, because "which compiled fields does this road not
   * honour, and why" was previously prose in three files and a comment in a fourth. One
   * member today.
   */
  const EXCLUDED: Readonly<Record<string, string>> = {
    // EMPTY, and that is a result rather than an oversight (#1062). Its one member was
    // `vertexColors`, excluded because it asked the shader for a geometry attribute a SHARED
    // material could not promise — wiring it through rendered a native primitive pure black,
    // observed in a browser. A material that NAMES its layer is resolved against the drawn
    // mesh before the spec exists, so the compile no longer emits a request at all: it emits
    // `colorLayer`, and the spec carries the answer. The set stays here, checked and empty,
    // because the NEXT field the compile learns to produce must land in one of these two maps
    // or be accused — which is this whole census's subject.
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
      irWith({ geometry: { doubleSided: true, alphaCutoff: 0.5, colorLayer: 'Color' } }),
      irWith({ mapUvTransforms: { albedo: { tiling: [2, 2], offset: [0.1, 0], rotation: 0 } } }),
      // #1062 — `mapUvLayers` is conditionally emitted too, so without a world naming a UV
      // layer the union is blind to it and every case in this file would be blind with it.
      irWith({ mapUvLayers: { albedo: 'UVMap.001' } }),
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
    expect(produced.length).toBe(19);
    expect(produced.filter((f) => f in CARRIED).length).toBe(19);
    expect(produced.filter((f) => f in EXCLUDED).length).toBe(0);
  });

  it('every CARRIED target really is a key of the assembled spec', () => {
    // Guards the map itself. A stale entry — right-hand side renamed, or the field dropped
    // from the assembly — would otherwise let the first case pass while nothing arrives.
    // #1062 — the IR must name BOTH layers and the layer list must RESOLVE them, or
    // `vertexColors`/`mapUvChannels` are absent from the assembled spec and this case accuses
    // two correct entries. The resolution is the point: an unresolved name is deliberately
    // absent, so the world here has to be one where the mesh really carries what is named.
    const spec = primitiveMaterialSpec(
      compilePrimitiveMaterial(
        irWith({
          mapUvTransforms: { albedo: { tiling: [2, 2], offset: [0, 0], rotation: 0 } },
          mapUvLayers: { albedo: 'UVMap.001' },
          geometry: { opacity: 1, colorLayer: 'Color' },
        }),
        undefined,
      ),
      'flat',
      NO_MAPS,
      [
        { name: 'UVMap', type: 'float2' },
        { name: 'UVMap.001', type: 'float2' },
        { name: 'Color', type: 'float4' },
      ],
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
      compilePrimitiveMaterial(
        irWith({ geometry: { opacity: 1, colorLayer: 'Color' } }),
        undefined,
      ),
      'flat',
      NO_MAPS,
      [],
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

// ── #1076 — FLATTEN REACHES THE NATIVE DRAW ────────────────────────────────────────────
//
// `ignoreSourceMaterial` (#131) asks the renderer to ignore the source material and draw a
// fresh one from the override's own scalars. The glTF clone road always honoured it; the
// native road composed the override instead, so every map survived. Boxes, spheres, native
// imports and modified meshes all compile through `compilePrimitiveMaterial`, which is why
// the claim is stated here, one tier below the browser specs (p131, p136).
describe('#1076 — a flatten override draws the override alone on the native road', () => {
  type MapRef = NonNullable<InlineMaterialSpec['maps']['albedo']>;
  const ref = (hash: string, colorSpace: MapRef['colorSpace']): MapRef => ({
    hash,
    colorSpace,
    flipY: false,
    wrapS: 1000,
    wrapT: 1000,
  });

  /** A source with an opinion on everything flatten is meant to throw away. */
  const TEXTURED = irWith({
    base: { color: '#2244ff', metalness: 0.25 },
    specular: { roughness: 0.72, ior: 1.9 },
    coat: { weight: 0.8, roughness: 0.1 },
    transmission: { weight: 0.3 },
    geometry: { opacity: 1, alphaCutoff: 0.5, doubleSided: true },
    maps: {
      albedo: ref('albedo.png', 'srgb'),
      normal: ref('normal.png', 'srgb-linear'),
      roughness: ref('rough.png', 'srgb-linear'),
      metalness: ref('metal.png', 'srgb-linear'),
      emissive: ref('emit.png', 'srgb'),
      ao: ref('ao.png', 'srgb-linear'),
    },
    uvTransform: { tiling: [2, 3], offset: [0.25, 0], rotation: 0.5 },
    mapUvTransforms: { albedo: { tiling: [4, 4], offset: [0, 0], rotation: 0 } },
  });

  const CLAY = override({
    color: '#3399ff',
    roughness: 0.2,
    metalness: 0.1,
    opacity: 0.6,
    emissive: '#110000',
    emissiveIntensity: 2,
    ignoreSourceMaterial: true,
  });

  it('drops every source map', () => {
    const compiled = compilePrimitiveMaterial(TEXTURED, CLAY);
    expect(compiled.maps).toEqual({
      map: null,
      normalMap: null,
      roughnessMap: null,
      metalnessMap: null,
      aoMap: null,
      emissiveMap: null,
    });
    expect(compiled.mapUvTransforms).toBeUndefined();
  });

  it('draws all six of the override’s scalars, whatever it marked as authored', () => {
    // `CLAY.overridden` names only `color`. Flatten ignores the authored set on purpose: the
    // source is gone, so there is nothing below for an unauthored field to defer to.
    const compiled = compilePrimitiveMaterial(TEXTURED, CLAY);
    expect({
      color: compiled.color,
      roughness: compiled.roughness,
      metalness: compiled.metalness,
      opacity: compiled.opacity,
      transparent: compiled.transparent,
      emissive: compiled.emissive,
      emissiveIntensity: compiled.emissiveIntensity,
    }).toEqual({
      color: '#3399ff',
      roughness: 0.2,
      metalness: 0.1,
      opacity: 0.6,
      transparent: true,
      emissive: '#110000',
      emissiveIntensity: 2,
    });
  });

  it('keeps nothing else of the source — every other field is a new material’s', () => {
    const compiled = compilePrimitiveMaterial(TEXTURED, CLAY);
    const fresh = compilePrimitiveMaterial(hydrateInlineMaterial(null), undefined);
    expect({
      ior: compiled.ior,
      clearcoat: compiled.clearcoat,
      clearcoatRoughness: compiled.clearcoatRoughness,
      transmission: compiled.transmission,
      thickness: compiled.thickness,
      alphaTest: compiled.alphaTest,
      doubleSided: compiled.doubleSided,
      // #1062 — the compile carries the colour layer's NAME now; `vertexColors` is resolved
      // later, against a mesh. Reading the removed field here compared `undefined` to
      // `undefined` and passed whatever flatten did to the colour.
      colorLayer: compiled.colorLayer,
      uvTransform: compiled.uvTransform,
    }).toEqual({
      ior: fresh.ior,
      clearcoat: fresh.clearcoat,
      clearcoatRoughness: fresh.clearcoatRoughness,
      transmission: fresh.transmission,
      thickness: fresh.thickness,
      alphaTest: fresh.alphaTest,
      doubleSided: fresh.doubleSided,
      colorLayer: fresh.colorLayer,
      uvTransform: fresh.uvTransform,
    });
  });

  it('control: the same override with flatten OFF composes onto the source and keeps its maps', () => {
    // Without this, "maps dropped" could be a fixture whose maps never reached the compile.
    const composed = compilePrimitiveMaterial(TEXTURED, { ...CLAY, ignoreSourceMaterial: false });
    expect(composed.maps.map).toEqual(ref('albedo.png', 'srgb'));
    expect(composed.maps.roughnessMap).toEqual(ref('rough.png', 'srgb-linear'));
    expect(composed.ior).toBe(1.9);
    expect(composed.doubleSided).toBe(true);
    // Map-aware composition: the source's roughness map defends its channel, because the
    // override did not author roughness. Flatten, above, drew 0.2 regardless.
    expect(composed.roughness).toBe(0.72);
  });

  it('control: an override that does not SAY flatten composes — absent is not a request', () => {
    // Every other case sets the flag explicitly, so on its own this file could not tell
    // "flatten when true" from "flatten unless false" (measured: that mutation survived all
    // of them). The distinction is real: `MaterialOverrideOp`'s value omits the field, and a
    // hydrated or agent-written override may too.
    const silent: MaterialValue = { ...CLAY };
    delete (silent as { ignoreSourceMaterial?: boolean }).ignoreSourceMaterial;
    expect('ignoreSourceMaterial' in silent).toBe(false);
    const composed = compilePrimitiveMaterial(TEXTURED, silent);
    expect(composed.maps.map).toEqual(ref('albedo.png', 'srgb'));
    expect(composed.ior).toBe(1.9);
  });

  it('flatten on and off are different registry instances', () => {
    // Two meshes under one override wrapper, one flattening, must never share a material.
    const on = world('flatten on', { ir: TEXTURED, override: CLAY });
    const off = world('flatten off', {
      ir: TEXTURED,
      override: { ...CLAY, ignoreSourceMaterial: false },
    });
    expect(keyOf(derive(on).spec)).not.toBe(keyOf(derive(off).spec));
    expect(derive(on).key).not.toBe(derive(off).key);
  });
});
