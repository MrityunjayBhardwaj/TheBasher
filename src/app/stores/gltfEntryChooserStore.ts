// gltfEntryChooserStore — a promise-based modal for picking WHICH glTF to import
// when a dropped/picked folder contains more than one (e.g. a `model.gltf` +
// `model_Textured.gltf` variant pack). Without it, `locateEntryFile` silently
// auto-picks the shallowest entry — which can be the stripped/untextured variant
// — and the user gets the wrong model with no say (#214 follow-up).
//
// A UI projection (V8): it never touches the DAG. `chooseGltfEntry(options)`
// returns a Promise the non-React import pickers await; the mounted
// <GltfEntryChooser> resolves it on click/cancel. Mirrors the store-driven
// overlay pattern of renderAnimationStore + RenderAnimationProgress.

import { create } from 'zustand';

/** One selectable glTF entry, with a cheap material/texture count so the user
 *  can tell a textured model from a stripped variant (null = a .glb, counts
 *  unavailable without a full container parse). */
export interface GltfEntryOption {
  relativePath: string;
  materials: number | null;
  textures: number | null;
}

interface ChooserRequest {
  options: GltfEntryOption[];
  resolve: (relativePath: string | null) => void;
}

export interface GltfEntryChooserStore {
  /** The active request (the modal mounts on this); null when idle. */
  request: ChooserRequest | null;
  /** Resolve with the chosen entry's relativePath. */
  choose: (relativePath: string) => void;
  /** Resolve with null (dismissed) — the import aborts. */
  cancel: () => void;
}

export const useGltfEntryChooserStore = create<GltfEntryChooserStore>((set, get) => ({
  request: null,
  choose: (relativePath) => {
    const req = get().request;
    if (!req) return;
    set({ request: null });
    req.resolve(relativePath);
  },
  cancel: () => {
    const req = get().request;
    if (!req) return;
    set({ request: null });
    req.resolve(null);
  },
}));

/**
 * Open the chooser and resolve with the picked entry's relativePath (or null if
 * dismissed). Imports are sequential user actions, but if a request is somehow
 * already pending, resolve it null first so its awaiter never hangs.
 */
export function chooseGltfEntry(options: GltfEntryOption[]): Promise<string | null> {
  const prev = useGltfEntryChooserStore.getState().request;
  if (prev) prev.resolve(null);
  return new Promise((resolve) => {
    useGltfEntryChooserStore.setState({ request: { options, resolve } });
  });
}
