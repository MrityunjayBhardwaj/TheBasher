// #530 — the material registry: sharing, splitting, and the two properties that
// keep the key honest.
//
// ── WHY THE KEY GETS ITS OWN GATE ───────────────────────────────────────────────
//
// A content-keyed cache has exactly one catastrophic failure: a field the builder
// applies that the key does not cover. Two materials that render differently then
// collapse onto one instance, and the symptom is a wrong-looking mesh with nothing
// in the diff to explain it. Its mirror image — specced and keyed but never
// APPLIED — is a live defect elsewhere in this codebase already (#532: the native
// road compiles `doubleSided` and drops it), so neither direction is theoretical.
//
// Both are gated here by ENUMERATION rather than by a list: the spec's own leaves
// are walked, so a field added to `PrimitiveMaterialSpec` is covered without
// anyone remembering to cover it. A gate keyed to a written-out list would go
// quietly out of date the first time the spec grew, which is the whole failure
// mode it exists to prevent.
//
// REF: src/app/materialRegistry.ts; issue #530.

import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import * as materialRegistry from './materialRegistry';
import type { PrimitiveMaterialSpec } from './materialRegistry';

afterEach(() => materialRegistry.clear());

const BASE: PrimitiveMaterialSpec = {
  color: '#3366cc',
  roughness: 0.42,
  metalness: 0.25,
  opacity: 0.9,
  transparent: true,
  emissive: '#221100',
  emissiveIntensity: 1.5,
  ior: 1.7,
  clearcoat: 0.3,
  clearcoatRoughness: 0.4,
  transmission: 0.2,
  thickness: 0.5,
  wireframe: false,
  // #532 — the three render-mode flags, every one authored AWAY from three's own
  // default (`side` 0 / `alphaTest` 0 / `vertexColors` false). A spec value that equals
  // the default would satisfy "the build applies it" on a build that ignores it, which
  // is the vacuity this whole enumeration exists to avoid.
  alphaTest: 0.25,
  vertexColors: true,
  side: THREE.DoubleSide,
  uvTransform: { tiling: [2, 3], offset: [0.1, 0.2], rotation: 0.5 },
  textures: {
    map: null,
    normalMap: null,
    roughnessMap: null,
    metalnessMap: null,
    aoMap: null,
    emissiveMap: null,
  },
};

/** Every scalar leaf of the spec, as a dotted path → value. Textures excluded (they
 *  are perturbed separately — a Texture is not a leaf value). */
function leafPaths(value: unknown, prefix = ''): [string, unknown][] {
  if (value === null || typeof value !== 'object') return [[prefix, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => leafPaths(v, `${prefix}[${i}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

/** A different value of the same type — the perturbation. */
function perturb(v: unknown): unknown {
  if (typeof v === 'number') return v + 1;
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'string') return v === '#000000' ? '#ffffff' : '#000000';
  return 'PERTURBED';
}

function setAt(spec: PrimitiveMaterialSpec, path: string, value: unknown): PrimitiveMaterialSpec {
  const copy = structuredClone(spec) as unknown as Record<string, unknown>;
  const segments = path.split('.');
  let cursor: Record<string, unknown> = copy;
  for (let i = 0; i < segments.length - 1; i++) {
    cursor = cursor[segments[i]] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1];
  const arrayMatch = /^(.*)\[(\d+)\]$/.exec(last);
  if (arrayMatch) {
    (cursor[arrayMatch[1]] as unknown[])[Number(arrayMatch[2])] = value;
  } else {
    cursor[last] = value;
  }
  return copy as unknown as PrimitiveMaterialSpec;
}

const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
] as const;

describe('#530 — two meshes whose material resolves to the same thing share one instance', () => {
  it('the SAME spec, asked for twice, is the SAME THREE.Material instance', () => {
    const first = materialRegistry.get(BASE);
    // A structurally-equal but distinct object, because that is what the renderer
    // actually hands over: `resolveNodeMaterial` hydrates a fresh IR per evaluation,
    // so two objects linked to one Material node never share a reference. If this
    // cache were identity-keyed it would dedup nothing in production while passing
    // a test written with one shared literal.
    const second = materialRegistry.get(structuredClone(BASE));
    expect(second.material).toBe(first.material);
    expect(second.key).toBe(first.key);
    expect(materialRegistry.size()).toBe(1);
  });

  it('THE OTHER HALF: a spec differing in one field gets its OWN instance', () => {
    // Without this, a registry that ignores the composed override entirely — one
    // keyed on, say, the Material node id — would pass the test above and be wrong
    // in the way that actually breaks a render.
    const first = materialRegistry.get(BASE);
    const overridden = materialRegistry.get({ ...BASE, roughness: 0.13 });
    expect(overridden.material).not.toBe(first.material);
    expect(overridden.material.roughness).toBe(0.13);
    expect(first.material.roughness).toBe(0.42);
    expect(materialRegistry.size()).toBe(2);
  });
});

describe('#530 — the key covers every field the build reads', () => {
  it('EVERY scalar leaf of the spec, perturbed alone, changes the key', () => {
    const paths = leafPaths(BASE).filter(([p]) => !p.startsWith('textures'));
    // A floor, so this cannot pass by walking an empty set — the failure mode where
    // a census gate goes green because its subject emptied.
    expect(paths.length).toBeGreaterThanOrEqual(18);
    const base = materialRegistry.keyOf(BASE);
    for (const [path, value] of paths) {
      const key = materialRegistry.keyOf(setAt(BASE, path, perturb(value)));
      expect(key, `${path} does not reach the key`).not.toBe(base);
    }
  });

  it('EVERY texture slot, filled alone, changes the key', () => {
    const base = materialRegistry.keyOf(BASE);
    for (const slot of TEXTURE_SLOTS) {
      const key = materialRegistry.keyOf({
        ...BASE,
        textures: { ...BASE.textures, [slot]: new THREE.Texture() },
      });
      expect(key, `${slot} does not reach the key`).not.toBe(base);
    }
  });

  it('two DIFFERENT textures in the same slot are two different keys', () => {
    // Presence alone is not enough: keying on "is there a map" rather than on WHICH
    // map would merge two meshes carrying different images.
    const a = materialRegistry.keyOf({
      ...BASE,
      textures: { ...BASE.textures, map: new THREE.Texture() },
    });
    const b = materialRegistry.keyOf({
      ...BASE,
      textures: { ...BASE.textures, map: new THREE.Texture() },
    });
    expect(a).not.toBe(b);
  });

  it('field ORDER in the spec object cannot change the key', () => {
    // The renderer builds this object literal by hand; a later reshuffle must not
    // silently halve the hit rate.
    const reversed = Object.fromEntries(
      Object.entries(BASE).reverse(),
    ) as unknown as PrimitiveMaterialSpec;
    expect(materialRegistry.keyOf(reversed)).toBe(materialRegistry.keyOf(BASE));
  });
});

describe('#530 — the build applies every scalar the spec carries', () => {
  it('each scalar field lands on the built material under the same name', () => {
    // The mirror of the key gate: a field that is specced and keyed but never
    // applied splits the cache while changing nothing on screen. Names match the
    // three.js property deliberately, which is what lets this be enumerated.
    const { material } = materialRegistry.get(BASE);
    const scalars = leafPaths(BASE).filter(
      ([p]) => !p.startsWith('textures') && !p.startsWith('uvTransform'),
    );
    // EXACT, not a floor. The type already forces `BASE` to carry every REQUIRED spec
    // field, so growth is handled by the compiler; what the compiler cannot see is a
    // field turning optional and quietly leaving `BASE`, which would make both this gate
    // and the key gate blind to it while staying green. The count is the guard for that
    // direction, so it is meant to be edited deliberately.
    expect(scalars.length).toBe(16);
    for (const [path, value] of scalars) {
      const applied = material[path as keyof THREE.MeshPhysicalMaterial];
      const actual = applied instanceof THREE.Color ? `#${applied.getHexString()}` : applied;
      expect(actual, `${path} is specced but not applied`).toBe(value);
    }
  });

  it('the UV transform lands on the map CLONE, and the shared source is untouched', () => {
    const source = new THREE.Texture();
    const { material } = materialRegistry.get({
      ...BASE,
      textures: { ...BASE.textures, map: source },
    });
    expect(material.map).not.toBe(source); // cloned — the decoded texture is shared by hash
    expect(material.map!.repeat.x).toBe(2);
    expect(material.map!.offset.y).toBeCloseTo(0.2);
    expect(material.map!.rotation).toBe(0.5);
    // The source is what every OTHER material also holds; placing the UV transform
    // on it would cross-contaminate all of them.
    expect(source.repeat.x).toBe(1);
    expect(source.rotation).toBe(0);
  });
});

describe('#530 — lifetime is refcounted, and a handoff is not a drop', () => {
  it('the instance survives while any holder remains, and is disposed at zero', async () => {
    const { key, material } = materialRegistry.get(BASE);
    let disposed = false;
    material.addEventListener('dispose', () => {
      disposed = true;
    });
    materialRegistry.retain(key);
    materialRegistry.retain(key);
    expect(materialRegistry.holders(key)).toBe(2);

    materialRegistry.release(key);
    await Promise.resolve();
    expect(materialRegistry.size(), 'evicted while a holder remained').toBe(1);
    expect(disposed).toBe(false);

    materialRegistry.release(key);
    await Promise.resolve();
    expect(materialRegistry.size()).toBe(0);
    expect(disposed, 'the last release did not dispose').toBe(true);
  });

  it('a HANDOFF — the last release and a new retain in the same tick — keeps the instance', async () => {
    // React runs every cleanup in a commit before any effect, so an unmounting mesh
    // and a mounting one that resolve to the same material make the count touch zero
    // in between. Evicting on that zero would dispose a material the new mesh has
    // already attached — a black mesh, from a cache that was "working".
    const { key, material } = materialRegistry.get(BASE);
    materialRegistry.retain(key);
    materialRegistry.release(key); // the old mesh leaves — count 0, eviction queued
    materialRegistry.retain(key); // the new mesh arrives, same tick
    await Promise.resolve();
    expect(materialRegistry.size()).toBe(1);
    expect(materialRegistry.get(BASE).material).toBe(material);
  });

  it('disposing frees the texture CLONES too, not just the material', async () => {
    // Material.dispose does not free textures, and these clones belong to the
    // registry — the reason this cache is refcounted rather than permanent like the
    // geometry registry.
    const { key, material } = materialRegistry.get({
      ...BASE,
      textures: { ...BASE.textures, map: new THREE.Texture() },
    });
    const clone = material.map!;
    let cloneDisposed = false;
    clone.addEventListener('dispose', () => {
      cloneDisposed = true;
    });
    materialRegistry.retain(key);
    materialRegistry.release(key);
    await Promise.resolve();
    expect(cloneDisposed).toBe(true);
  });

  it('a release the registry has already forgotten is a no-op, not a crash', () => {
    expect(() => materialRegistry.release('never-seen')).not.toThrow();
    expect(() => materialRegistry.retain('never-seen')).not.toThrow();
    expect(materialRegistry.holders('never-seen')).toBe(0);
  });
});
