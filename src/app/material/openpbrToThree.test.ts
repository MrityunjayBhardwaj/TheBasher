// openpbrToThree unit (v0.6 #2, #178, PLAN W1 1.5) — the ONE IR→three.js
// mapping. Proves the name mapping, the transmission auto-set, the pinned
// luminance constant, and that `unsupported` lobes are NOT emitted.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InlineMaterialSpec } from '../../nodes/types';
import {
  DEFAULT_TRANSMISSION_THICKNESS,
  EMISSION_NIT_TO_INTENSITY,
  openpbrToThree,
} from './openpbrToThree';

function ir(over: Partial<InlineMaterialSpec> = {}): InlineMaterialSpec {
  return {
    name: 'm',
    base: { color: '#aabbcc', metalness: 0.25 },
    specular: { roughness: 0.4, ior: 1.6 },
    coat: { weight: 0.7, roughness: 0.2 },
    transmission: { weight: 0 },
    emission: { color: '#112233', luminance: 3 },
    geometry: { opacity: 1 },
    maps: {
      albedo: null,
      normal: null,
      roughness: null,
      metalness: null,
      emissive: null,
      ao: null,
    },
    ...over,
  };
}

describe('openpbrToThree (the one IR→three.js adapter)', () => {
  it('maps each OpenPBR lobe field to its three.js name', () => {
    const t = openpbrToThree(ir());
    expect(t.color).toBe('#aabbcc'); // base.color
    expect(t.metalness).toBe(0.25); // base.metalness
    expect(t.roughness).toBe(0.4); // specular.roughness
    expect(t.ior).toBe(1.6); // specular.ior
    expect(t.clearcoat).toBe(0.7); // coat.weight
    expect(t.clearcoatRoughness).toBe(0.2); // coat.roughness
    expect(t.emissive).toBe('#112233'); // emission.color
    expect(t.opacity).toBe(1); // geometry.opacity
  });

  it('emission.luminance → emissiveIntensity via the pinned 1:1 constant', () => {
    const t = openpbrToThree(ir({ emission: { color: '#fff', luminance: 5 } }));
    expect(t.emissiveIntensity).toBe(5 * EMISSION_NIT_TO_INTENSITY);
    expect(EMISSION_NIT_TO_INTENSITY).toBe(1.0);
  });

  it('transmission > 0 auto-sets transparent + thickness', () => {
    const opaque = openpbrToThree(ir({ transmission: { weight: 0 } }));
    expect(opaque.transmission).toBe(0);
    expect(opaque.transparent).toBe(false);
    expect(opaque.thickness).toBe(0);

    const glass = openpbrToThree(ir({ transmission: { weight: 0.9 } }));
    expect(glass.transmission).toBe(0.9);
    expect(glass.transparent).toBe(true);
    expect(glass.thickness).toBe(DEFAULT_TRANSMISSION_THICKNESS);
  });

  it('opacity < 1 forces transparent (even with no transmission)', () => {
    const t = openpbrToThree(ir({ geometry: { opacity: 0.5 } }));
    expect(t.opacity).toBe(0.5);
    expect(t.transparent).toBe(true);
  });

  it('passes map refs through to three.js slot names', () => {
    const refStub = {
      hash: 'h',
      colorSpace: 'srgb',
      flipY: false,
      wrapS: 1000,
      wrapT: 1000,
    } as const;
    const t = openpbrToThree(ir({ maps: { ...ir().maps, albedo: refStub, normal: refStub } }));
    expect(t.maps.map).toBe(refStub); // albedo → map
    expect(t.maps.normalMap).toBe(refStub); // normal → normalMap
    expect(t.maps.roughnessMap).toBeNull();
  });

  it('does NOT emit unsupported lobes (they are v0.7-only)', () => {
    const t = openpbrToThree(ir({ unsupported: { subsurface_weight: 0.8 } }));
    expect(JSON.stringify(t)).not.toContain('subsurface');
    expect(JSON.stringify(t)).not.toContain('0.8');
  });

  // The adapter is the ONLY IR→three.js mapping site (V29 N×M drift guard).
  // A grep gate ensures no renderer re-implements `base.color → color` etc.
  it('is the single mapping site — no parallel IR→three mapping in renderers', () => {
    const scene = readFileSync(join(__dirname, '../../viewport/SceneFromDAG.tsx'), 'utf8');
    // The renderer must consume openpbrToThree, never read base.metalness/specular.* directly.
    expect(scene).not.toMatch(/material\.specular\.roughness/);
    expect(scene).not.toMatch(/material\.base\.metalness/);
  });
});
