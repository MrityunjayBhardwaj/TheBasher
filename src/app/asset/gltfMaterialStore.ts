// gltfMaterialStore — the read-only material projection published by the
// renderer (GltfAssetR) and consumed by the inspector (NPanel), keyed by
// assetRef (UX backlog #8).
//
// The embedded materials of a glTF live on the mounted three.js clone, not in
// the DAG. The inspector is a DOM component that can't reach into the R3F
// scene, so the renderer PUBLISHES a read-only summary here whenever the clone
// or its material override changes; the inspector subscribes reactively. This
// is the V33 pattern (a read-only projection of render state) applied to
// materials — single producer (GltfAssetR), single consumer surface.
//
// Keyed by assetRef, matching the single-asset-per-ref assumption the sibling
// `gltfCloneRegistry` makes; the newest mount wins.
//
// REF: UX-BACKLOG #8; src/app/asset/readGltfMaterials.ts (the extractor);
//      src/viewport/SceneFromDAG.tsx (GltfAssetR — the publisher);
//      src/app/NPanel.tsx (the inspector consumer).

import { create } from 'zustand';
import type { GltfMaterialSlot } from './readGltfMaterials';

export interface GltfMaterialStore {
  /** assetRef → the rendered clone's per-slot material summary. */
  byAsset: Record<string, readonly GltfMaterialSlot[]>;
  publish(assetRef: string, slots: readonly GltfMaterialSlot[]): void;
  clearAsset(assetRef: string): void;
}

export const useGltfMaterialStore = create<GltfMaterialStore>((set) => ({
  byAsset: {},
  publish(assetRef, slots) {
    set((s) => ({ byAsset: { ...s.byAsset, [assetRef]: slots } }));
  },
  clearAsset(assetRef) {
    set((s) => {
      if (!(assetRef in s.byAsset)) return s;
      const next = { ...s.byAsset };
      delete next[assetRef];
      return { byAsset: next };
    });
  },
}));
