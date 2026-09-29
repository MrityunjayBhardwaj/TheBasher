// #1123 — a bake keeps how strongly its normal and occlusion maps act.
//
// These rows are the CLONE road's half (`captureBakedMaterial`, reading a live three material); the
// primitive road's half sits with the rest of the inline bake in `dispatchApplyTransform.test.ts`.
//
// The strength is `normalScale.x`, never the signed y: y's sign belongs to how the texture was
// uploaded (#1325), and the rebuild derives it again from the baked texture. Storing the signed
// value would flip it twice.
//
// `persistTexture` is stubbed because its canvas readback cannot run under node. What it would
// write is not the subject here; the strength beside it is.

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { MemoryStorage } from '../../core/storage/MemoryStorage';

vi.mock('../asset/bakedTextureStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../asset/bakedTextureStore')>()),
  persistTexture: async (_storage: unknown, texture: THREE.Texture) => ({
    hash: `stub.png`,
    colorSpace: 'srgb-linear' as const,
    flipY: texture.flipY,
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
  }),
}));

const { captureBakedMaterial } = await import('./captureBakedMaterial');

function liveWithMaps(): THREE.MeshStandardMaterial {
  const live = new THREE.MeshStandardMaterial();
  live.normalMap = new THREE.Texture();
  live.aoMap = new THREE.Texture();
  return live;
}

describe('#1123 — the capture reads the strengths the material draws with', () => {
  it('keeps both, the normal one as a strength even when y is negated', async () => {
    const live = liveWithMaps();
    // As three's loader draws a glTF normal map at scale 0.5 on a mesh without tangents.
    live.normalScale.set(0.5, -0.5);
    live.aoMapIntensity = 0.3;
    const spec = await captureBakedMaterial(new MemoryStorage(), live);
    expect(spec).toMatchObject({ normalScale: 0.5, aoMapIntensity: 0.3 });
  });

  it('a negated y at the default strength is the upload, not a strength, and writes nothing', async () => {
    const live = liveWithMaps();
    live.normalScale.set(1, -1);
    const spec = await captureBakedMaterial(new MemoryStorage(), live);
    expect('normalScale' in spec).toBe(false);
    expect('aoMapIntensity' in spec).toBe(false);
  });

  it('a strength with no map to act on is not captured', async () => {
    const live = new THREE.MeshStandardMaterial();
    live.normalScale.set(0.5, 0.5);
    live.aoMapIntensity = 0.3;
    const spec = await captureBakedMaterial(new MemoryStorage(), live);
    expect('normalScale' in spec).toBe(false);
    expect('aoMapIntensity' in spec).toBe(false);
  });
});
